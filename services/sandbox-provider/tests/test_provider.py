import asyncio
import json
import pytest
from jsonschema import Draft202012Validator
from provider.app import OPENAPI, REGISTRY, create_app
from provider.config import Settings
from provider.db import one
from provider.service import ProviderService
from .conftest import TOKEN_A, TOKEN_B, TOKEN_DELEGATE, policies, profiles
from .fake_runtime import FakeRuntime

pytestmark = pytest.mark.integration


def headers(token=TOKEN_A, key='key-1', **more):
    return {'Authorization': 'Bearer ' + token, 'Idempotency-Key': key, 'X-Correlation-ID': 'test-correlation', **more}


def conform(schema, value):
    Draft202012Validator({'$ref': 'urn:workflow:provider:openapi#/components/schemas/' + schema}, registry=REGISTRY, format_checker=Draft202012Validator.FORMAT_CHECKER).validate(value)


async def create(client, ref='workspace-a', token=TOKEN_A):
    result = await client.post('/v1/sandboxes', headers=headers(token, 'create-' + ref), json={'owner_ref': ref, 'profile': 'minimal-linux:v1', 'persistent': True})
    assert result.status_code == 201, result.text
    conform('Sandbox', result.json())
    return result.json()['sandbox_id']


async def execute(client, sid, key='execute-1', profile='fixture-write-file:v1', arguments=None, token=TOKEN_A, timeout=30):
    payload = {'execution_ref': key, 'profile': profile, 'arguments': arguments if arguments is not None else {'file': 'hello-world.txt', 'text': 'hello'}, 'timeout_seconds': timeout}
    result = await client.post('/v1/sandboxes/' + sid + '/execute', headers=headers(token, key), json=payload)
    assert result.status_code == 202, result.text
    conform('Run', result.json())
    return result.json()['run_id']


async def wait_run(client, sid, rid, token=TOKEN_A):
    for _ in range(160):
        result = await client.get(f'/v1/sandboxes/{sid}/runs/{rid}', headers=headers(token))
        assert result.status_code == 200, result.text
        conform('Run', result.json())
        if result.json()['status'] in {'completed', 'failed', 'cancelled', 'timed_out'}:
            return result.json()
        await asyncio.sleep(.025)
    raise AssertionError('Run did not reach a terminal state')


async def test_auth_validation_and_safe_errors(env):
    app, client, settings, runtime = env
    r = await client.post('/v1/sandboxes', json={})
    assert r.status_code == 401
    conform('Error', r.json())
    assert r.headers['X-Correlation-ID']
    assert (await client.post('/v1/sandboxes', headers=headers(**{'Content-Type': 'application/json'}), content='{')).status_code == 400
    assert (await client.post('/v1/sandboxes', headers=headers(), json={'owner_ref': 'a', 'profile': 'minimal-linux:v1', 'persistent': True, 'shell': 'id'})).status_code == 422
    assert (await client.post('/v1/sandboxes', headers=headers(**{'X-Owner-ID': 'owner-b'}), json={})).status_code == 403
    assert (await client.post('/v1/sandboxes', headers=headers(TOKEN_DELEGATE), json={})).status_code == 403
    assert (await client.post('/v1/sandboxes', headers=headers(), content='x' * 65537)).status_code == 413
    assert runtime.creates == 0


async def test_idempotent_create_conflict_and_ensure(env):
    _, client, _, runtime = env
    sid = await create(client)
    assert await create(client) == sid
    r = await client.post('/v1/sandboxes', headers=headers(key='different-key'), json={'owner_ref': 'workspace-a', 'profile': 'minimal-linux:v1', 'persistent': True})
    assert r.json()['sandbox_id'] == sid
    r = await client.post('/v1/sandboxes', headers=headers(key='create-workspace-a'), json={'owner_ref': 'different', 'profile': 'minimal-linux:v1', 'persistent': True})
    assert r.status_code == 409 and r.json()['code'] == 'idempotency_conflict'
    assert runtime.creates == 1


async def test_write_stop_resume_read_and_events(env):
    app, client, _, runtime = env
    sid = await create(client)
    rid = await execute(client, sid)
    run = await wait_run(client, sid, rid)
    assert run['status'] == 'completed' and run['result']['stdout'] == 'hello'
    assert (await client.post(f'/v1/sandboxes/{sid}/stop', headers=headers(), json={})).json()['status'] == 'stopped'
    assert (await client.post(f'/v1/sandboxes/{sid}/stop', headers=headers(), json={})).status_code == 200
    assert runtime.removes == 0
    assert (await client.post(f'/v1/sandboxes/{sid}/start', headers=headers(), json={})).json()['status'] == 'running'
    rid = await execute(client, sid, 'read-1', 'fixture-read-file:v1', {'file': 'hello-world.txt'})
    assert (await wait_run(client, sid, rid))['result']['stdout'] == 'hello'
    r = await client.get(f'/v1/sandboxes/{sid}/events?limit=2', headers=headers())
    conform('EventPage', r.json()); assert r.json()['next_cursor']
    again = await client.get(f'/v1/sandboxes/{sid}/events?cursor={r.json()["next_cursor"]}', headers=headers())
    assert not set(x['event_id'] for x in r.json()['events']) & set(x['event_id'] for x in again.json()['events'])
    all_events = (await client.get(f'/v1/sandboxes/{sid}/events', headers=headers())).json()['events']
    assert {'sandbox.created', 'run.started', 'run.completed', 'sandbox.stopped', 'sandbox.resumed'} <= {x['type'] for x in all_events}
    assert all(x['actor_id'] == 'client-a' and x['owner_id'] == 'owner-a' for x in all_events)
    assert (await client.get(f'/v1/sandboxes/{sid}/events?cursor=bad', headers=headers())).status_code == 400
    async with app.state.service.db.tx() as c:
        with pytest.raises(Exception):
            await c.execute('UPDATE audit_events SET status=\'tampered\' WHERE sandbox_id=%s', (sid,))


async def test_ownership_delegation_and_two_sandbox_isolation_mocked(env):
    _, client, _, runtime = env
    a, b = await create(client), await create(client, 'workspace-b', TOKEN_B)
    rid = await execute(client, a); await wait_run(client, a, rid)
    assert (await client.get(f'/v1/sandboxes/{a}', headers=headers(TOKEN_B))).status_code == 404
    assert (await client.get(f'/v1/sandboxes/{a}/events', headers=headers(TOKEN_B))).status_code == 404
    rid2 = await execute(client, b, 'other-read', 'fixture-read-file:v1', {'file': 'hello-world.txt'}, TOKEN_B)
    assert (await wait_run(client, b, rid2, TOKEN_B))['status'] == 'failed'
    assert (await client.get(f'/v1/sandboxes/{a}', headers=headers(TOKEN_DELEGATE, **{'X-Owner-ID': 'owner-a'}))).status_code == 200
    events = (await client.get(f'/v1/sandboxes/{a}/events', headers=headers())).json()['events']
    assert all('arguments' not in e['detail'] for e in events)


async def test_denied_workloads_args_and_artifact_transfer(env):
    _, client, _, runtime = env
    sid = await create(client)
    base = {'execution_ref': 'run-a', 'profile': 'unknown', 'arguments': {}, 'timeout_seconds': 1}
    path = f'/v1/sandboxes/{sid}/execute'
    assert (await client.post(path, headers=headers(), json=base)).status_code == 403
    base |= {'profile': 'fixture-write-file:v1', 'arguments': {'file': '../secret', 'text': 'x'}}
    assert (await client.post(path, headers=headers(), json=base)).status_code == 422
    base['arguments'] = {'file': 'safe.txt', 'text': 'safe'}; base['artifact_output_ref'] = 'https://internal.invalid/secret'
    assert (await client.post(path, headers=headers(), json=base)).json()['code'] == 'unsupported_artifact_transfer'
    assert runtime.executes == 0


async def test_concurrent_execute_duplicate_and_busy_stop(env):
    _, client, _, runtime = env
    sid = await create(client)
    payload = {'execution_ref': 'one-run', 'profile': 'fixture-delay:v1', 'arguments': {'seconds': .4}, 'timeout_seconds': 2}
    path = f'/v1/sandboxes/{sid}/execute'
    results = await asyncio.gather(*[client.post(path, headers=headers(key='duplicate'), json=payload) for _ in range(8)])
    assert all(r.status_code == 202 for r in results)
    ids = {r.json()['run_id'] for r in results}; assert len(ids) == 1
    assert (await client.post(f'/v1/sandboxes/{sid}/stop', headers=headers(), json={})).status_code == 409
    assert (await client.post(f'/v1/sandboxes/{sid}/destroy', headers=headers(), json={'confirm': True, 'reason': 'test'})).status_code == 409
    payload['execution_ref'] = 'second-run'
    assert (await client.post(path, headers=headers(key='second-run'), json=payload)).status_code == 409
    await wait_run(client, sid, ids.pop())
    assert runtime.executes == 1 and runtime.max_active[sid] == 1


async def test_cancellation_and_timeout(env):
    _, client, _, runtime = env
    sid = await create(client)
    rid = await execute(client, sid, 'long-run', 'fixture-delay:v1', {'seconds': 3}, timeout=5)
    await asyncio.sleep(.1)
    r = await client.post(f'/v1/sandboxes/{sid}/runs/{rid}/cancel', headers=headers(), json={'reason': 'user'})
    assert r.status_code == 202
    assert (await wait_run(client, sid, rid))['status'] == 'cancelled'
    rid = await execute(client, sid, 'timeout-run', 'fixture-delay:v1', {'seconds': 3}, timeout=1)
    assert (await wait_run(client, sid, rid))['status'] == 'timed_out'
    assert runtime.removes == 0


async def test_execution_reference_dedupe_and_exit_failure(env):
    _, client, _, runtime = env
    sid = await create(client)
    rid = await execute(client, sid, 'ref', 'fixture-exit:v1', {'code': 3})
    assert (await wait_run(client, sid, rid))['status'] == 'failed'
    payload = {'execution_ref': 'ref', 'profile': 'fixture-exit:v1', 'arguments': {'code': 3}, 'timeout_seconds': 30}
    r = await client.post(f'/v1/sandboxes/{sid}/execute', headers=headers(key='new-transport-key'), json=payload)
    assert r.status_code == 202 and r.json()['run_id'] == rid
    payload['arguments']['code'] = 0
    assert (await client.post(f'/v1/sandboxes/{sid}/execute', headers=headers(key='different'), json=payload)).status_code == 409
    assert runtime.executes == 1


async def test_runtime_unavailable_creation_reconciles_identity(env):
    _, client, _, runtime = env
    runtime.available = False
    body = {'owner_ref': 'reconcile', 'profile': 'minimal-linux:v1', 'persistent': True}
    assert (await client.post('/v1/sandboxes', headers=headers(), json=body)).status_code == 503
    runtime.available = True
    r = await client.post('/v1/sandboxes', headers=headers(), json=body)
    assert r.status_code == 201 and runtime.creates == 1


async def test_explicit_destroy_tombstone_and_permissions(env):
    _, client, settings, runtime = env
    sid = await create(client)
    assert (await client.post(f'/v1/sandboxes/{sid}/destroy', headers=headers(), json={'confirm': False, 'reason': 'no'})).status_code == 422
    settings.auth[0]['permissions'] = []
    assert (await client.post(f'/v1/sandboxes/{sid}/destroy', headers=headers(), json={'confirm': True, 'reason': 'yes'})).status_code == 403
    settings.auth[0]['permissions'] = ['sandbox:' + action for action in ('read', 'create', 'start', 'stop', 'execute', 'cancel', 'destroy')]
    for _ in range(2):
        r = await client.post(f'/v1/sandboxes/{sid}/destroy', headers=headers(), json={'confirm': True, 'reason': 'disposable'})
        assert r.status_code == 200 and r.json()['status'] == 'destroyed'
    assert runtime.removes == 1
    assert (await client.post(f'/v1/sandboxes/{sid}/start', headers=headers(), json={})).status_code == 409
    assert (await client.post('/v1/sandboxes', headers=headers(key='new'), json={'owner_ref': 'workspace-a', 'profile': 'minimal-linux:v1', 'persistent': True})).status_code == 409


async def test_fake_readiness_never_claims_boxlite(env):
    _, client, _, _ = env
    conform('Health', (await client.get('/health/live')).json())
    r = await client.get('/health/ready')
    assert r.status_code == 503 and r.json()['checks']['runtime'] == 'disabled'


async def test_future_workload_requires_only_configuration(env):
    _, client, _, _ = env
    sid = await create(client)
    rid = await execute(client, sid, 'future', 'future-workload:v7', {})
    assert (await wait_run(client, sid, rid))['result']['stdout'] == 'new configured profile'


async def test_cancel_by_reference_fences_delayed_execute(env):
    _, client, _, runtime = env
    sid = await create(client)
    path = f'/v1/sandboxes/{sid}'
    cancel = await client.post(path + '/runs/cancel-by-reference', headers=headers(), json={'execution_ref': 'cancel-before-send', 'reason': 'deadline'})
    assert cancel.status_code == 202 and cancel.json()['status'] == 'fenced' and cancel.json()['run_id'] is None
    payload = {'execution_ref': 'cancel-before-send', 'profile': 'fixture-write-file:v1', 'arguments': {'file': 'late.txt', 'text': 'must-not-write'}, 'timeout_seconds': 1}
    r = await client.post(path + '/execute', headers=headers(), json=payload)
    assert r.status_code == 409 and r.json()['code'] == 'execution_cancelled'
    assert runtime.executes == 0


async def test_cancel_by_reference_existing_and_race(env):
    _, client, _, runtime = env
    sid = await create(client)
    path = f'/v1/sandboxes/{sid}'
    rid = await execute(client, sid, 'existing-ref', 'fixture-delay:v1', {'seconds': 2}, timeout=5)
    r = await client.post(path + '/runs/cancel-by-reference', headers=headers(), json={'execution_ref': 'existing-ref'})
    assert r.status_code == 202 and r.json()['run_id'] == rid and r.json()['status'] == 'cancelling'
    assert (await wait_run(client, sid, rid))['status'] == 'cancelled'
    assert runtime.removes == 0


async def test_quota_output_bound_log_redaction_and_cursor_overflow(env, caplog):
    import logging
    caplog.set_level(logging.INFO, logger='sandbox-provider')
    app, client, settings, runtime = env
    sid = await create(client)
    settings.max_sandboxes = 1
    r = await client.post('/v1/sandboxes', headers=headers(key='over-quota'), json={'owner_ref': 'another', 'profile': 'minimal-linux:v1', 'persistent': True})
    assert r.status_code == 429
    settings.max_output = 8
    rid = await execute(client, sid, 'bounded-output', arguments={'file': 'test.txt', 'text': 'sensitive-payload-never-in-logs'})
    result = await wait_run(client, sid, rid)
    assert result['result']['stdout'] == 'sensitiv' and result['result']['output_truncated'] is True
    for cursor in ['v1:9999999999999999999999999', 'v1:-1', 'v1:01']:
        assert (await client.get(f'/v1/sandboxes/{sid}/events', headers=headers(), params={'cursor': cursor})).status_code == 400
    text = '\n'.join(record.message for record in caplog.records)
    assert TOKEN_A not in text and 'sensitive-payload-never-in-logs' not in text
    logs = [json.loads(record.message) for record in caplog.records]
    assert all(v.get('service') == 'sandbox-provider' and 'timestamp' in v and 'duration_ms' in v for v in logs)
    assert any(v.get('correlation_id') == 'test-correlation' and v.get('sandbox_id') == sid for v in logs)


async def test_post_schema_header_content_type_and_migration_idempotency(env):
    app, client, _, _ = env
    await app.state.service.db.open()  # independent schema migration replay
    sid = await create(client)
    r = await client.post(f'/v1/sandboxes/{sid}/start', headers=headers(), content='{}')
    assert r.status_code == 415
    assert (await client.post(f'/v1/sandboxes/{sid}/start', headers=headers(), json={'force': True})).status_code == 422
    r = await client.get(f'/v1/sandboxes/{sid}', headers={'Authorization': 'Bearer ' + TOKEN_A, 'X-Correlation-ID': 'not valid'})
    assert r.status_code == 400
    conform('Error', r.json())


async def test_cancel_fence_and_execute_race_has_no_duplicate_active_work(env):
    _, client, _, runtime = env
    sid = await create(client)
    path = f'/v1/sandboxes/{sid}'
    for i in range(5):
        ref = f'race-{i}'
        payload = {'execution_ref': ref, 'profile': 'fixture-delay:v1', 'arguments': {'seconds': .4}, 'timeout_seconds': 2}
        submitted, cancelled = await asyncio.gather(client.post(path + '/execute', headers=headers(key=ref), json=payload),
                                                  client.post(path + '/runs/cancel-by-reference', headers=headers(), json={'execution_ref': ref}))
        assert submitted.status_code in {202, 409}
        assert cancelled.status_code == 202
        if submitted.status_code == 202:
            assert (await wait_run(client, sid, submitted.json()['run_id']))['status'] in {'cancelled', 'completed'}
        replay = await client.post(path + '/execute', headers=headers(key=ref + '-retry'), json=payload)
        assert replay.status_code == 409 or replay.json()['status'] in {'cancelled', 'completed'}
    assert runtime.max_active.get(sid, 0) <= 1


async def test_read_only_credentials_cannot_mutate_runtime(env):
    _, client, settings, runtime = env
    sid = await create(client)
    settings.auth[0]['permissions'] = ['sandbox:read']
    assert (await client.get(f'/v1/sandboxes/{sid}', headers=headers())).status_code == 200
    for path, payload in [(f'/v1/sandboxes/{sid}/start', {}), (f'/v1/sandboxes/{sid}/stop', {}),
                          (f'/v1/sandboxes/{sid}/execute', {'execution_ref': 'denied', 'profile': 'fixture-read-file:v1', 'arguments': {'file': 'file.txt'}, 'timeout_seconds': 1}),
                          (f'/v1/sandboxes/{sid}/runs/cancel-by-reference', {'execution_ref': 'denied'}),
                          ('/v1/sandboxes', {'owner_ref': 'denied', 'profile': 'minimal-linux:v1', 'persistent': True})]:
        assert (await client.post(path, headers=headers(), json=payload)).status_code == 403
    assert runtime.executes == 0 and runtime.creates == 1


async def test_authenticated_metrics_scope_to_effective_owner(env):
    _, client, _, _ = env
    sid = await create(client)
    assert (await client.get('/metrics')).status_code == 401
    a = await client.get('/metrics', headers=headers())
    b = await client.get('/metrics', headers=headers(TOKEN_B))
    assert a.status_code == b.status_code == 200
    assert 'sandbox_provider_sandboxes{state="running"} 1' in a.text
    assert 'sandbox_provider_sandboxes{state=' not in b.text
    assert sid not in a.text and 'owner-a' not in a.text
