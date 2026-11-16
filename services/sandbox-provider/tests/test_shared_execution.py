"""Shared scheduling uses real PostgreSQL and a deterministic runtime double."""
import asyncio
import fcntl
import json
import os
import subprocess
import sys
import time
from pathlib import Path
import pytest
from provider.db import one
from .conftest import TOKEN_A


def headers(key=None):
    return {'Authorization': 'Bearer ' + TOKEN_A} | ({'Idempotency-Key': key} if key else {})


async def setup(env, capacity=2):
    app, client, settings, runtime = env
    settings.profiles['sandboxes']['minimal-linux:v1']['max_concurrent_runs'] = capacity
    response = await client.post('/v1/sandboxes', headers=headers('shared-box'), json={'owner_ref': 'shared-box', 'profile': 'minimal-linux:v1', 'persistent': True})
    assert response.status_code == 201
    return app.state.service, client, runtime, response.json()['sandbox_id']


async def start(client, sid, key, seconds=1, timeout=10):
    return await client.post('/v1/sandboxes/' + sid + '/execute', headers=headers(key), json={
        'execution_ref': key, 'profile': 'fixture-delay:v1', 'arguments': {'seconds': seconds}, 'timeout_seconds': timeout})


async def wait(client, sid, rid, expected):
    for _ in range(150):
        result = (await client.get(f'/v1/sandboxes/{sid}/runs/{rid}', headers=headers())).json()
        if result['status'] in expected:
            return result
        await asyncio.sleep(.025)
    raise AssertionError('run did not reach expected state')


async def test_two_runs_overlap_capacity_replay_and_sibling_cancel(env):
    service, client, runtime, sid = await setup(env)
    first, second = await asyncio.gather(start(client, sid, 'first'), start(client, sid, 'second'))
    assert first.status_code == second.status_code == 202
    a, b = first.json()['run_id'], second.json()['run_id']
    assert (await start(client, sid, 'third')).status_code == 409
    assert (await start(client, sid, 'first')).json()['run_id'] == a
    await wait(client, sid, a, {'running'})
    await wait(client, sid, b, {'running'})
    # Startup must skip old migration001's exclusive index over active rows.
    from provider.db import Database
    second_registry = Database(service.settings.database_url)
    await second_registry.open()
    await second_registry.close()
    assert (await client.post(f'/v1/sandboxes/{sid}/stop', headers=headers(), json={})).status_code == 409
    await client.post(f'/v1/sandboxes/{sid}/runs/{a}/cancel', headers=headers(), json={})
    await wait(client, sid, a, {'cancelled'})
    assert (await client.get('/v1/sandboxes/' + sid, headers=headers())).json()['active_run_id'] == b
    assert (await client.post(f'/v1/sandboxes/{sid}/stop', headers=headers(), json={})).status_code == 409
    assert (await wait(client, sid, b, {'completed'}))['result']['exit_code'] == 0
    assert max(runtime.max_active.values()) == 2
    assert (await client.get('/v1/sandboxes/' + sid, headers=headers())).json()['active_run_id'] is None
    assert next(iter(runtime.boxes.values()))['running']


async def test_default_capacity_one_and_deadline_preserve_sibling(env):
    service, client, runtime, sid = await setup(env)
    a = (await start(client, sid, 'timeout', seconds=3, timeout=1)).json()['run_id']
    b = (await start(client, sid, 'sibling', seconds=2)).json()['run_id']
    await wait(client, sid, a, {'timed_out'})
    await wait(client, sid, b, {'completed'})
    assert next(iter(runtime.boxes.values()))['running']


async def test_pending_transfer_failure_never_stops_sibling(env):
    from provider.transfers import fail_transfer
    service, client, runtime, sid = await setup(env)
    rid = (await start(client, sid, 'sibling', seconds=.5)).json()['run_id']
    await wait(client, sid, rid, {'running'})
    async with service.db.tx() as c:
        await c.execute("UPDATE sandboxes SET file_operation_pending=true,file_operation_id='own-generation' WHERE sandbox_id=%s", (sid,))
        sb = await one(c, 'SELECT * FROM sandboxes WHERE sandbox_id=%s', (sid,))
    identity = service.settings.authenticate('Bearer ' + TOKEN_A, None)
    await fail_transfer(service, identity, sb, 'test-shared-transfer', 'own-generation')
    assert next(iter(runtime.boxes.values()))['running']
    async with service.db.tx() as c:
        current = await one(c, 'SELECT * FROM sandboxes WHERE sandbox_id=%s', (sid,))
        assert current['file_operation_pending'] and current['file_operation_recovery_required']
    await wait(client, sid, rid, {'completed'})
    for _ in range(40):
        if not next(iter(runtime.boxes.values()))['running']:
            break
        await asyncio.sleep(.025)
    assert not next(iter(runtime.boxes.values()))['running']


async def test_shared_profiles_rejected_by_unqualified_adapter(env):
    app, client, settings, runtime = env
    runtime.shared_execution_supported = False
    settings.profiles['sandboxes']['minimal-linux:v1']['max_concurrent_runs'] = 2
    result = await client.post('/v1/sandboxes', headers=headers('unqualified'), json={'owner_ref': 'unqualified', 'profile': 'minimal-linux:v1', 'persistent': True})
    assert result.status_code == 422 and result.json()['code'] == 'runtime_policy_rejected'
    assert runtime.creates == 0


async def test_shared_worker_recovery_preserves_nonce_deadline_and_execution(env):
    service, client, runtime, sid = await setup(env)
    rid = (await start(client, sid, 'recover-deadline', seconds=3, timeout=1)).json()['run_id']
    await wait(client, sid, rid, {'running'})
    await asyncio.sleep(.65)
    async with service.db.tx() as c:
        original = await one(c, 'SELECT runtime_nonce,started_at FROM runs WHERE run_id=%s', (rid,))
    started = time.monotonic()
    task = service.tasks[rid]
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
    await wait(client, sid, rid, {'timed_out'})
    assert time.monotonic() - started < .9
    async with service.db.tx() as c:
        recovered = await one(c, 'SELECT runtime_nonce,started_at FROM runs WHERE run_id=%s', (rid,))
    assert recovered == original and runtime.executes == 1


@pytest.mark.parametrize('late_cancel', [False, True])
async def test_proven_completed_journal_wins_late_deadline_or_cancel_poll(env, late_cancel):
    service, client, runtime, sid = await setup(env)
    service.settings.max_output = 64
    async def delayed_collection(execution, maximum):
        await asyncio.Event().wait()
    async def completed_journal(execution):
        assert execution.task.done()
        return {'termination_reason': 'completed', 'result': dict(execution.task.result()) | {'stdout': 'x' * 100}}
    runtime.collect = delayed_collection
    runtime.cancel = completed_journal
    response = await client.post('/v1/sandboxes/' + sid + '/execute', headers=headers('late-exit124'), json={
        'execution_ref': 'late-exit124', 'profile': 'fixture-exit:v1', 'arguments': {'code': 124}, 'timeout_seconds': 1})
    assert response.status_code == 202
    rid = response.json()['run_id']
    await wait(client, sid, rid, {'running'})
    await asyncio.sleep(.075)
    if late_cancel:
        await client.post(f'/v1/sandboxes/{sid}/runs/{rid}/cancel', headers=headers(), json={})
    else:
        # Simulate collecting an existing completed journal after its original
        # deadline while transport delivery is still delayed.
        async with service.db.tx() as c:
            await c.execute("UPDATE runs SET started_at=now()-interval '2 seconds' WHERE run_id=%s", (rid,))
        service.tasks[rid].cancel()
        await asyncio.gather(service.tasks[rid], return_exceptions=True)
    result = await wait(client, sid, rid, {'failed'})
    assert result['error']['code'] == 'execution_failed' and result['result']['exit_code'] == 124
    assert result['result']['stdout'] == 'x' * 64 and result['result']['output_truncated']


def source(tmp_path):
    text = Path(__file__).parents[1].joinpath('provider/guest_shared.py').read_text()
    parts = tuple(str(tmp_path).strip('/').split('/'))
    return text.replace("('opt', 'workflow-transfer', '.executions', reference)", repr(parts) + " + ('.executions', reference)")


def control(text, reference, nonce, action):
    result = subprocess.run([sys.executable, '-c', text, 'control', reference, nonce, action], capture_output=True, timeout=5)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def test_supervisor_cancels_detached_descendants_and_preserves_sibling(tmp_path):
    text = source(tmp_path)
    marker = tmp_path / 'descendant.pid'
    child = 'import os,time;os.setsid();open(' + repr(str(marker)) + ',"w").write(str(os.getpid()));time.sleep(30)'
    parent = 'import subprocess,time;subprocess.Popen([' + repr(sys.executable) + ',"-c",' + repr(child) + ']);time.sleep(30)'
    args = [sys.executable, '-c', text, 'run', 'nonce-a', 'run_aaa', '32768', '[]', str(time.time() + 30), sys.executable, '-c', parent]
    a = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    b = subprocess.Popen([sys.executable, '-c', text, 'run', 'nonce-b', 'run_bbb', '32768', '[]', str(time.time() + 30), sys.executable, '-c', 'import time;time.sleep(.5);print("sibling")'], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        end = time.monotonic() + 5
        while not marker.exists() and time.monotonic() < end:
            time.sleep(.025)
        descendant = int(marker.read_text())
        assert control(text, 'run_aaa', 'nonce-a', 'cancel')['status'] in ('running', 'finished')
        out, err = a.communicate(timeout=10)
        assert a.returncode == 0 and not err and json.loads(out)['result']['exit_code'] == -9
        assert not Path('/proc/' + str(descendant)).exists()
        out, err = b.communicate(timeout=5)
        assert b.returncode == 0 and not err and json.loads(out)['result']['stdout'] == 'sibling\n'
        assert control(text, 'run_aaa', 'nonce-a', 'inspect')['status'] == 'finished'
    finally:
        for process in (a, b):
            if process.poll() is None:
                process.kill()
                process.wait()


def test_cancellation_fence_prevents_delayed_dispatch_and_wrong_nonce(tmp_path):
    text = source(tmp_path)
    marker = tmp_path / 'should-not-exist'
    assert control(text, 'run_delayed', 'nonce', 'cancel') == {'status': 'fenced'}
    result = subprocess.run([sys.executable, '-c', text, 'run', 'nonce', 'run_delayed', '32768', '[]', str(time.time() + 30), sys.executable, '-c', 'open(' + repr(str(marker)) + ',"w").write("bad")'], capture_output=True, timeout=5)
    assert result.returncode == 0 and json.loads(result.stdout)['result']['exit_code'] == -9
    assert not marker.exists()
    result = subprocess.run([sys.executable, '-c', text, 'control', 'run_delayed', 'wrong-nonce', 'cancel'], capture_output=True, timeout=5)
    assert result.returncode != 0


def test_guest_deadline_terminates_detached_descendants_without_provider(tmp_path):
    text = source(tmp_path)
    marker = tmp_path / 'deadline-descendant.pid'
    child = 'import os,time;os.setsid();open(' + repr(str(marker)) + ',"w").write(str(os.getpid()));time.sleep(30)'
    parent = 'import subprocess,time;subprocess.Popen([' + repr(sys.executable) + ',"-c",' + repr(child) + ']);time.sleep(30)'
    result = subprocess.run([sys.executable, '-c', text, 'run', 'nonce-deadline', 'run_deadline', '32768', '[]', str(time.time() + .2), sys.executable, '-c', parent], capture_output=True, timeout=5)
    assert result.returncode == 0 and not result.stderr
    envelope = json.loads(result.stdout)
    assert envelope['result']['exit_code'] == 124
    assert envelope['termination_reason'] == 'timed_out'
    assert not Path('/proc/' + marker.read_text()).exists()


def test_expired_absolute_guest_deadline_prevents_delayed_dispatch(tmp_path):
    text = source(tmp_path)
    marker = tmp_path / 'late-dispatch-must-not-start'
    result = subprocess.run([sys.executable, '-c', text, 'run', 'nonce-expired', 'run_expired', '32768', '[]', str(time.time() - 1), sys.executable, '-c', 'open(' + repr(str(marker)) + ',"w").write("bad")'], capture_output=True, timeout=5)
    assert result.returncode == 0 and not result.stderr
    assert json.loads(result.stdout)['result']['exit_code'] == 124
    assert not marker.exists()


def test_absolute_deadline_rechecked_after_control_lock_contention(tmp_path):
    text = source(tmp_path)
    journal = tmp_path / '.executions' / 'run_lock'
    journal.mkdir(parents=True)
    marker = tmp_path / 'lock-delayed-must-not-start'
    with (journal / 'control.lock').open('w+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        process = subprocess.Popen([sys.executable, '-c', text, 'run', 'nonce-lock', 'run_lock', '32768', '[]', str(time.time() + .15), sys.executable, '-c', 'open(' + repr(str(marker)) + ',"w").write("bad")'], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            time.sleep(.35)
            fcntl.flock(lock, fcntl.LOCK_UN)
            out, err = process.communicate(timeout=5)
            assert process.returncode == 0 and not err
            envelope = json.loads(out)
            assert envelope['termination_reason'] == 'timed_out' and envelope['result']['exit_code'] == 124
            assert not marker.exists()
        finally:
            if process.poll() is None:
                process.kill();process.wait()


@pytest.mark.parametrize('recovered', [False, True])
@pytest.mark.parametrize('late', [False, True])
async def test_ordinary_exit124_keeps_same_meaning_when_collected_after_deadline(tmp_path, recovered, late):
    from provider.cloud_runtime import JournalExecution
    from provider.runtime import configured_runtime
    from .test_cloud_runtime import configured
    from .test_result_envelope import Output
    text = source(tmp_path)
    deadline = time.time() + 1
    value = subprocess.run([sys.executable, '-c', text, 'run', 'nonce-124', 'run_early124', '32768', '[]', str(deadline), sys.executable, '-c', 'raise SystemExit(124)'], capture_output=True, timeout=5)
    assert value.returncode == 0 and not value.stderr
    envelope = json.loads(value.stdout)
    assert envelope['termination_reason'] == 'completed'
    if late:
        await asyncio.sleep(max(0, deadline - time.time()) + .025)
    runtime = configured_runtime(configured(tmp_path))
    if recovered:
        async def journal(execution, cancel=False):
            return {'status': 'finished', 'envelope': envelope}
        runtime._shared_control = journal
        execution = runtime.shared_execution('exact-runtime', 'run_early124', 'nonce-124')
    else:
        execution = JournalExecution(Output(value.stdout), 'nonce-124', 'exact-runtime', 'run_early124', True)
    assert (await runtime.collect(execution, 32768))['exit_code'] == 124


@pytest.mark.parametrize('recovered', [False, True])
async def test_actual_guest_timeout_is_explicit_in_native_and_recovered_results(tmp_path, recovered):
    from provider.cloud_runtime import JournalExecution
    from provider.errors import ServiceError
    from provider.runtime import configured_runtime
    from .test_cloud_runtime import configured
    from .test_result_envelope import Output
    value = subprocess.run([sys.executable, '-c', source(tmp_path), 'run', 'nonce-timeout', 'run_timeout', '32768', '[]', str(time.time() + .1), sys.executable, '-c', 'import time;time.sleep(30)'], capture_output=True, timeout=5)
    assert value.returncode == 0 and not value.stderr
    envelope = json.loads(value.stdout)
    runtime = configured_runtime(configured(tmp_path))
    if recovered:
        async def journal(execution, cancel=False):
            return {'status': 'finished', 'envelope': envelope}
        runtime._shared_control = journal
        execution = runtime.shared_execution('exact-runtime', 'run_timeout', 'nonce-timeout')
    else:
        execution = JournalExecution(Output(value.stdout), 'nonce-timeout', 'exact-runtime', 'run_timeout', True)
    with pytest.raises(ServiceError, match='deadline_exceeded'):
        await runtime.collect(execution, 32768)


async def test_shared_termination_reason_is_checksum_bound(tmp_path):
    from provider.cloud_runtime import JournalExecution
    from provider.errors import ServiceError
    from provider.runtime import configured_runtime
    from .test_cloud_runtime import configured
    from .test_result_envelope import Output
    value = subprocess.run([sys.executable, '-c', source(tmp_path), 'run', 'nonce-tamper', 'run_tamper', '32768', '[]', str(time.time() + 10), sys.executable, '-c', 'raise SystemExit(124)'], capture_output=True, timeout=5)
    envelope = json.loads(value.stdout)
    envelope['termination_reason'] = 'timed_out'
    runtime = configured_runtime(configured(tmp_path))
    with pytest.raises(ServiceError, match='ambiguous_execution'):
        await runtime.collect(JournalExecution(Output(json.dumps(envelope).encode()), 'nonce-tamper', 'exact-runtime', 'run_tamper', True), 32768)
