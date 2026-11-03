import asyncio
import hashlib
import uuid
from datetime import datetime, timezone
from psycopg.types.json import Jsonb
from .audit import event, emit_log
from .config import Identity, canonical
from .db import Database, one, all_rows
from .errors import ServiceError, unavailable

TERMINAL = {'completed', 'failed', 'cancelled', 'timed_out'}
ACTIVE = {'queued', 'running', 'cancelling'}


def uid(prefix):
    return prefix + '_' + uuid.uuid4().hex


def fingerprint(body):
    return hashlib.sha256(canonical(body).encode()).hexdigest()


def error_value(error, correlation):
    return {'code': error.code, 'message': error.message, 'retryable': error.retryable, 'correlation_id': correlation}


def sandbox_json(row):
    p = row['profile_snapshot']
    return {k: row[k] for k in ('sandbox_id', 'owner_ref', 'profile', 'status', 'created_at', 'updated_at', 'active_run_id', 'error')} | {
        'persistent': True, 'resources': {k: p[k] for k in ('cpus', 'memory_mib', 'disk_mib', 'network')}}


def run_json(row):
    return {k: row[k] for k in ('run_id', 'sandbox_id', 'execution_ref', 'profile', 'status', 'created_at', 'updated_at',
                                'started_at', 'finished_at', 'result', 'error')}


class ProviderService:
    def __init__(self, settings, runtime):
        self.settings, self.runtime = settings, runtime
        self.db = Database(settings.database_url)
        self.tasks, self.loop_task, self.stopping = {}, None, False

    async def open(self, dispatcher=True):
        await self.db.open()
        await self.recover()
        if dispatcher:
            self.loop_task = asyncio.create_task(self.dispatch_loop())

    async def close(self):
        self.stopping = True
        if self.loop_task:
            self.loop_task.cancel()
            await asyncio.gather(self.loop_task, return_exceptions=True)
        for task in self.tasks.values():
            task.cancel()
        await asyncio.gather(*self.tasks.values(), return_exceptions=True)
        await self.runtime.close()
        await self.db.close()

    async def get_sandbox(self, c, identity, sid, lock=False):
        row = await one(c, 'SELECT * FROM sandboxes WHERE sandbox_id=%s AND owner_id=%s' + (' FOR UPDATE' if lock else ''), (sid, identity.owner))
        if not row:
            raise ServiceError(404, 'not_found', 'Environment was not found.')
        self.settings.sandbox_profile(identity, row['profile'])
        return row

    async def get_run(self, c, identity, sid, rid, lock=False):
        await self.get_sandbox(c, identity, sid)
        row = await one(c, 'SELECT * FROM runs WHERE run_id=%s AND sandbox_id=%s AND owner_id=%s' + (' FOR UPDATE' if lock else ''), (rid, sid, identity.owner))
        if not row:
            raise ServiceError(404, 'not_found', 'Execution was not found.')
        if row['profile'] not in identity.policy['workload_profiles']:
            raise ServiceError(403, 'forbidden', 'Workload profile is not permitted.')
        return row

    async def replay(self, c, identity, operation, key, body):
        row = await one(c, 'SELECT * FROM idempotency WHERE owner_id=%s AND operation=%s AND key=%s', (identity.owner, operation, key))
        if row and row['fingerprint'] != fingerprint(body):
            raise ServiceError(409, 'idempotency_conflict', 'Idempotency key was already used with a different request.')
        return row['resource_id'] if row else None

    async def remember(self, c, identity, operation, key, body, resource):
        await c.execute('INSERT INTO idempotency(owner_id,operation,key,fingerprint,resource_id) VALUES(%s,%s,%s,%s,%s)',
                        (identity.owner, operation, key, fingerprint(body), resource))

    async def create(self, identity, key, body, correlation):
        profile = self.settings.sandbox_profile(identity, body['profile'])
        async with self.db.tx() as c:
            await c.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))', ('owner:' + identity.owner,))
            sid = await self.replay(c, identity, 'create', key, body)
            if not sid:
                existing = await one(c, 'SELECT * FROM sandboxes WHERE owner_id=%s AND owner_ref=%s FOR UPDATE', (identity.owner, body['owner_ref']))
                if existing:
                    if existing['profile'] != body['profile'] or existing['status'] == 'destroyed':
                        raise ServiceError(409, 'invalid_state', 'Owner reference is retained for a different or destroyed environment.')
                    sid = existing['sandbox_id']
                else:
                    count = await one(c, "SELECT count(*) AS count FROM sandboxes WHERE owner_id=%s AND status<>'destroyed'", (identity.owner,))
                    if count['count'] >= self.settings.max_sandboxes:
                        raise ServiceError(429, 'quota_exceeded', 'Environment quota exceeded.')
                    sid = uid('sbx')
                    await c.execute('''INSERT INTO sandboxes(sandbox_id,owner_id,owner_ref,profile,profile_snapshot,runtime_name,status)
                                       VALUES(%s,%s,%s,%s,%s,%s,'creating')''',
                                    (sid, identity.owner, body['owner_ref'], body['profile'], Jsonb(profile), sid))
                    sb = await self.get_sandbox(c, identity, sid)
                    await event(c, sb, identity, correlation, 'sandbox.creation_requested', 'creating')
                await self.remember(c, identity, 'create', key, body, sid)
        return await self.lifecycle(identity, sid, 'ensure', correlation)

    async def lifecycle(self, identity, sid, action, correlation):
        if action == 'destroy':
            # Commit explicit destruction authority before irreversible runtime effects.
            async with self.db.tx() as c:
                sb = await self.get_sandbox(c, identity, sid, lock=True)
                if sb['status'] == 'destroyed':
                    return sandbox_json(sb)
                if sb['active_run_id']:
                    raise ServiceError(409, 'sandbox_busy', 'Environment has an active execution.')
                if sb['status'] != 'destroying':
                    await c.execute("UPDATE sandboxes SET status='destroying',updated_at=now() WHERE sandbox_id=%s", (sid,))
                    await event(c, sb, identity, correlation, 'sandbox.destruction_requested', 'destroying')
        failure = None
        async with self.db.tx() as c:
            sb = await self.get_sandbox(c, identity, sid, lock=True)
            if action == 'ensure' and sb['status'] not in ('creating',):
                return sandbox_json(sb)
            if action == 'start' and sb['status'] == 'running':
                return sandbox_json(sb)
            if action == 'stop' and sb['status'] == 'stopped':
                return sandbox_json(sb)
            if action == 'destroy' and sb['status'] == 'destroyed':
                return sandbox_json(sb)
            if sb['status'] == 'destroyed' or (action in ('start', 'stop') and sb['status'] in ('creating', 'destroying', 'failed')):
                raise ServiceError(409, 'invalid_state', 'Operation is not permitted in the current environment state.')
            if sb['active_run_id']:
                raise ServiceError(409, 'sandbox_busy', 'Environment has an active execution.')
            old = sb['status']
            try:
                if action == 'ensure':
                    found = await self.runtime.ensure(sb['runtime_name'], sb['profile_snapshot'])
                    await c.execute("UPDATE sandboxes SET runtime_id=%s,disk_ref=%s,status='running',error=NULL,updated_at=now() WHERE sandbox_id=%s",
                                    (found.runtime_id, found.disk_ref, sid))
                    kind, state = 'sandbox.created', 'running'
                elif action == 'start':
                    await self.runtime.start(sb['runtime_name'])
                    await c.execute("UPDATE sandboxes SET status='running',error=NULL,updated_at=now() WHERE sandbox_id=%s", (sid,))
                    kind, state = 'sandbox.resumed' if old == 'stopped' else 'sandbox.started', 'running'
                elif action == 'stop':
                    await self.runtime.stop(sb['runtime_name'])
                    await c.execute("UPDATE sandboxes SET status='stopped',error=NULL,updated_at=now() WHERE sandbox_id=%s", (sid,))
                    kind, state = 'sandbox.stopped', 'stopped'
                else:
                    # Only this explicit, separately-authorized operation calls remove.
                    found = await self.runtime.inspect(sb['runtime_name'])
                    if found is not None:
                        await self.runtime.stop(sb['runtime_name'])
                        await self.runtime.destroy(sb['runtime_name'])
                    await c.execute("UPDATE sandboxes SET status='destroyed',error=NULL,updated_at=now() WHERE sandbox_id=%s", (sid,))
                    kind, state = 'sandbox.destroyed', 'destroyed'
                await event(c, sb, identity, correlation, kind, state)
            except Exception as exc:
                failure = exc if isinstance(exc, ServiceError) else unavailable()
                # Preserve creating intent for idempotent retry of the same stable identity.
                await c.execute('UPDATE sandboxes SET error=%s,updated_at=now() WHERE sandbox_id=%s', (Jsonb(error_value(failure, correlation)), sid))
                await event(c, sb, identity, correlation, 'sandbox.failed', old, detail={'error_classification': failure.code})
            row = await self.get_sandbox(c, identity, sid)
        if failure:
            raise failure
        return sandbox_json(row)

    async def execute(self, identity, sid, key, body, correlation):
        if body.get('artifact_output_ref'):
            raise ServiceError(422, 'unsupported_artifact_transfer', 'No scoped artifact transfer adapter is configured.')
        async with self.db.tx() as c:
            sb = await self.get_sandbox(c, identity, sid, lock=True)
            p, argv = self.settings.workload(identity, body['profile'], sb['profile'], body['arguments'], body['timeout_seconds'])
            rid = await self.replay(c, identity, 'execute:' + sid, key, body)
            if not rid:
                existing = await one(c, 'SELECT * FROM runs WHERE owner_id=%s AND sandbox_id=%s AND execution_ref=%s', (identity.owner, sid, body['execution_ref']))
                if existing:
                    if canonical(existing['request']) != canonical(body):
                        raise ServiceError(409, 'idempotency_conflict', 'Execution reference already identifies a different request.')
                    rid = existing['run_id']
                else:
                    fence = await one(c, 'SELECT execution_ref FROM cancellation_fences WHERE sandbox_id=%s AND execution_ref=%s', (sid, body['execution_ref']))
                    if fence:
                        raise ServiceError(409, 'execution_cancelled', 'Execution reference has been cancelled and cannot be started.')
                    if sb['active_run_id']:
                        raise ServiceError(409, 'sandbox_busy', 'Environment has an active execution.')
                    if sb['status'] != 'running':
                        raise ServiceError(409, 'invalid_state', 'Environment must be running before execution.')
                    rid = uid('run')
                    await c.execute('''INSERT INTO runs(run_id,sandbox_id,owner_id,execution_ref,profile,request,profile_snapshot,status,correlation_id,actor_id)
                                       VALUES(%s,%s,%s,%s,%s,%s,%s,'queued',%s,%s)''',
                                    (rid, sid, identity.owner, body['execution_ref'], body['profile'], Jsonb(body), Jsonb(p | {'resolved_argv': argv}), correlation, identity.actor))
                    await c.execute('UPDATE sandboxes SET active_run_id=%s,updated_at=now() WHERE sandbox_id=%s', (rid, sid))
                    await event(c, sb, identity, correlation, 'run.queued', 'queued', rid)
                await self.remember(c, identity, 'execute:' + sid, key, body, rid)
            row = await self.get_run(c, identity, sid, rid)
            return run_json(row)

    async def cancel_by_reference(self, identity, sid, body, correlation):
        async with self.db.tx() as c:
            sb = await self.get_sandbox(c, identity, sid, lock=True)
            await c.execute('''INSERT INTO cancellation_fences(sandbox_id,execution_ref,owner_id,actor_id,correlation_id)
                               VALUES(%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING''',
                            (sid, body['execution_ref'], identity.owner, identity.actor, correlation))
            run = await one(c, 'SELECT * FROM runs WHERE sandbox_id=%s AND execution_ref=%s AND owner_id=%s FOR UPDATE',
                            (sid, body['execution_ref'], identity.owner))
            if run and run['profile'] not in identity.policy['workload_profiles']:
                raise ServiceError(403, 'forbidden', 'Workload profile is not permitted.')
            if run and run['status'] not in TERMINAL and run['status'] != 'cancelling':
                await c.execute("UPDATE runs SET status='cancelling',updated_at=now() WHERE run_id=%s", (run['run_id'],))
                await event(c, sb, identity, correlation, 'run.cancellation_requested', 'cancelling', run['run_id'])
                run['status'] = 'cancelling'
            elif not run:
                await event(c, sb, identity, correlation, 'run.cancellation_fenced', 'fenced')
            return {'execution_ref': body['execution_ref'], 'run_id': run['run_id'] if run else None,
                    'status': run['status'] if run else 'fenced'}

    async def cancel(self, identity, sid, rid, correlation):
        async with self.db.tx() as c:
            sb = await self.get_sandbox(c, identity, sid, lock=True)
            run = await self.get_run(c, identity, sid, rid, lock=True)
            if run['status'] not in TERMINAL and run['status'] != 'cancelling':
                await c.execute("UPDATE runs SET status='cancelling',updated_at=now() WHERE run_id=%s", (rid,))
                await event(c, sb, identity, correlation, 'run.cancellation_requested', 'cancelling', rid)
            return run_json(await self.get_run(c, identity, sid, rid))

    async def events(self, identity, sid, cursor, limit):
        try:
            seq = int(cursor.removeprefix('v1:')) if cursor else 0
            if cursor and (not cursor.startswith('v1:') or str(seq) != cursor[3:] or seq < 0 or seq > 9223372036854775807 or len(cursor) > 256):
                raise ValueError()
            if not 1 <= limit <= 100:
                raise ValueError()
        except (ValueError, AttributeError):
            raise ServiceError(400, 'invalid_request', 'Event cursor or limit is invalid.')
        async with self.db.tx() as c:
            await self.get_sandbox(c, identity, sid)
            rows = await all_rows(c, 'SELECT * FROM audit_events WHERE sandbox_id=%s AND owner_id=%s AND sequence>%s ORDER BY sequence LIMIT %s', (sid, identity.owner, seq, limit + 1))
            result = []
            for row in rows[:limit]:
                result.append({k: row[k] for k in ('event_id', 'type', 'status', 'occurred_at', 'correlation_id', 'actor_id', 'owner_id', 'sandbox_id', 'run_id', 'detail')} |
                              {'target_id': row['run_id'] or sid, 'job_id': None, 'client_reference': None})
            return {'events': result, 'next_cursor': 'v1:' + str(rows[limit - 1]['sequence']) if len(rows) > limit else None}

    async def recover(self):
        if not await self.runtime.ready():
            return
        async with self.db.tx() as c:
            rows = await all_rows(c, "SELECT * FROM sandboxes WHERE status IN ('running','stopped','destroying') AND active_run_id IS NULL FOR UPDATE")
            for sb in rows:
                identity = Identity('sandbox-provider-recovery', sb['owner_id'], {})
                try:
                    found = await self.runtime.inspect(sb['runtime_name'])
                    if sb['status'] == 'destroying':
                        intent = await one(c, "SELECT actor_id,correlation_id FROM audit_events WHERE sandbox_id=%s AND type='sandbox.destruction_requested' ORDER BY sequence DESC LIMIT 1", (sb['sandbox_id'],))
                        if not intent:
                            continue  # No durable authority: never delete based on a state guess.
                        identity = Identity(intent['actor_id'], sb['owner_id'], {})
                        if found is not None:
                            await self.runtime.stop(sb['runtime_name'])
                            await self.runtime.destroy(sb['runtime_name'])
                        await c.execute("UPDATE sandboxes SET status='destroyed',error=NULL,updated_at=now() WHERE sandbox_id=%s", (sb['sandbox_id'],))
                        await event(c, sb, identity, intent['correlation_id'], 'sandbox.destroyed', 'destroyed', detail={'recovered': True})
                        continue
                    if found is None:
                        err = ServiceError(409, 'missing_runtime', 'Retained environment could not be located. Operator recovery is required.')
                        await c.execute("UPDATE sandboxes SET status='failed',error=%s,updated_at=now() WHERE sandbox_id=%s", (Jsonb(error_value(err, 'provider-recovery')), sb['sandbox_id']))
                        await event(c, sb, identity, 'provider-recovery', 'sandbox.failed', 'failed', detail={'error_classification': err.code})
                    else:
                        status = 'running' if found.running else 'stopped'
                        await c.execute('UPDATE sandboxes SET status=%s,updated_at=now() WHERE sandbox_id=%s', (status, sb['sandbox_id']))
                        await event(c, sb, identity, 'provider-recovery', 'sandbox.recovered', status)
                except Exception:
                    emit_log('sandbox.recovery_pending', 'provider-recovery', identity.actor, identity.owner, sandbox_id=sb['sandbox_id'], outcome='unavailable')

    async def dispatch_loop(self):
        while not self.stopping:
            try:
                self.tasks = {rid: task for rid, task in self.tasks.items() if not task.done()}
                async with self.db.tx() as c:
                    rows = await all_rows(c, "SELECT run_id FROM runs WHERE status IN ('queued','running','cancelling') ORDER BY created_at LIMIT 32")
                for row in rows:
                    if row['run_id'] not in self.tasks and len(self.tasks) < 4:
                        self.tasks[row['run_id']] = asyncio.create_task(self.process_run(row['run_id']))
            except asyncio.CancelledError:
                raise
            except Exception:
                emit_log('run.dispatch_unavailable', 'provider-worker', outcome='unavailable', error_classification='dependency_unavailable')
            await asyncio.sleep(self.settings.poll_seconds)

    async def finish(self, c, run, sb, identity, status, result=None, error=None):
        async with c.transaction():
            # Always lock sandbox before run, matching endpoint lock order.
            await c.execute('SELECT sandbox_id FROM sandboxes WHERE sandbox_id=%s FOR UPDATE', (sb['sandbox_id'],))
            current = await one(c, 'SELECT * FROM runs WHERE run_id=%s FOR UPDATE', (run['run_id'],))
            if current['status'] in TERMINAL:
                return
            if current['status'] == 'cancelling' and status == 'completed':
                # A terminal successful exit wins a cancellation that arrives too late.
                pass
            await c.execute('''UPDATE runs SET status=%s,result=%s,error=%s,finished_at=now(),updated_at=now() WHERE run_id=%s''',
                            (status, Jsonb(result) if result is not None else None, Jsonb(error) if error else None, run['run_id']))
            await c.execute('UPDATE sandboxes SET active_run_id=NULL,updated_at=now() WHERE sandbox_id=%s AND active_run_id=%s', (sb['sandbox_id'], run['run_id']))
            await event(c, sb, identity, run['correlation_id'], 'run.' + status, status, run['run_id'],
                        {'exit_code': result['exit_code']} if result else {'error_classification': error['code']} if error else {})

    async def process_run(self, rid):
        async with self.db.pool.connection() as c:
            # Session advisory lock survives commits, is released by PostgreSQL on process death.
            locked = await one(c, 'SELECT pg_try_advisory_lock(hashtextextended(%s,0)) AS locked', ('run:' + rid,))
            await c.commit()
            if not locked['locked']:
                return
            try:
                async with c.transaction():
                    run = await one(c, 'SELECT * FROM runs WHERE run_id=%s', (rid,))
                    if not run or run['status'] in TERMINAL:
                        return
                    sb = await one(c, 'SELECT * FROM sandboxes WHERE sandbox_id=%s FOR UPDATE', (run['sandbox_id'],))
                    run = await one(c, 'SELECT * FROM runs WHERE run_id=%s FOR UPDATE', (rid,))
                    identity = Identity(run['actor_id'], run['owner_id'], {})
                    fresh = run['status'] == 'queued'
                    if fresh:
                        await c.execute("UPDATE runs SET status='running',started_at=now(),updated_at=now() WHERE run_id=%s AND status='queued'", (rid,))
                        await event(c, sb, identity, run['correlation_id'], 'run.started', 'running', rid)
                execution = None
                try:
                    if run['status'] == 'cancelling' and not run['runtime_execution_id']:
                        await self.runtime.stop(sb['runtime_name'])
                        await self._set_stopped(c, sb)
                        await self.finish(c, run, sb, identity, 'cancelled')
                        return
                    if fresh:
                        p = run['profile_snapshot']
                        execution = await self.runtime.execute(sb['runtime_name'], p['resolved_argv'], p, run['request']['timeout_seconds'])
                        async with c.transaction():
                            await c.execute('UPDATE runs SET runtime_execution_id=%s,updated_at=now() WHERE run_id=%s', (execution.id(), rid))
                    elif run['runtime_execution_id']:
                        execution = await self.runtime.attach(sb['runtime_name'], run['runtime_execution_id'])
                        async with c.transaction():
                            await event(c, sb, identity, run['correlation_id'], 'run.recovered', run['status'], rid)
                    else:
                        raise ServiceError(409, 'ambiguous_execution', 'Execution outcome is unknown. Environment was stopped for operator recovery.')
                    started = run['started_at'] or datetime.now(timezone.utc)
                    timeout = max(.01, run['request']['timeout_seconds'] - (datetime.now(timezone.utc) - started).total_seconds())
                    collect = asyncio.create_task(self.runtime.collect(execution, min(self.settings.max_output, run['profile_snapshot']['max_output_bytes'])))
                    end = asyncio.get_running_loop().time() + timeout
                    while not collect.done():
                        async with c.transaction():
                            current = await one(c, 'SELECT status FROM runs WHERE run_id=%s', (rid,))
                        if current['status'] == 'cancelling':
                            await self.runtime.cancel(execution)
                            collect.cancel()
                            await asyncio.gather(collect, return_exceptions=True)
                            await self.finish(c, run, sb, identity, 'cancelled')
                            return
                        if asyncio.get_running_loop().time() >= end:
                            await self.runtime.cancel(execution)
                            collect.cancel()
                            await asyncio.gather(collect, return_exceptions=True)
                            err = ServiceError(409, 'deadline_exceeded', 'Execution exceeded its permitted duration.')
                            await self.finish(c, run, sb, identity, 'timed_out', error=error_value(err, run['correlation_id']))
                            return
                        await asyncio.sleep(self.settings.poll_seconds)
                    result = await collect
                    if not fresh:
                        result['output_truncated'] = True
                    err = None if result['exit_code'] == 0 else error_value(ServiceError(409, 'execution_failed', 'Approved workload exited unsuccessfully.'), run['correlation_id'])
                    await self.finish(c, run, sb, identity, 'completed' if err is None else 'failed', result, err)
                except asyncio.CancelledError:
                    if 'collect' in locals() and not collect.done():
                        collect.cancel()
                        await asyncio.gather(collect, return_exceptions=True)
                    # Leave durable run+execution identity for the next process; detached VM survives.
                    raise
                except Exception as exc:
                    err = exc if isinstance(exc, ServiceError) else ServiceError(409, 'ambiguous_execution', 'Execution outcome is unknown. Environment requires recovery.')
                    try:
                        await self.runtime.stop(sb['runtime_name'])
                        await self._set_stopped(c, sb)
                        await self.finish(c, run, sb, identity, 'failed', error=error_value(err, run['correlation_id']))
                    except Exception:
                        # Keep active ownership while unable to prove workload stopped.
                        async with c.transaction():
                            await c.execute("UPDATE runs SET status='cancelling',error=%s,updated_at=now() WHERE run_id=%s", (Jsonb(error_value(err, run['correlation_id'])), rid))
                            await event(c, sb, identity, run['correlation_id'], 'run.recovery_pending', 'cancelling', rid, {'error_classification': err.code})
            except asyncio.CancelledError:
                raise
            except Exception:
                emit_log('run.recovery_pending', 'provider-worker', run_id=rid, outcome='unavailable', error_classification='dependency_unavailable')
            finally:
                await c.execute('SELECT pg_advisory_unlock(hashtextextended(%s,0))', ('run:' + rid,))
                await c.commit()

    async def _set_stopped(self, c, sb):
        async with c.transaction():
            await c.execute("UPDATE sandboxes SET status='stopped',updated_at=now() WHERE sandbox_id=%s", (sb['sandbox_id'],))
