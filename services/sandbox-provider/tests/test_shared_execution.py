"""Shared scheduling uses real PostgreSQL and a deterministic runtime double."""
import asyncio
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
    args = [sys.executable, '-c', text, 'run', 'nonce-a', 'run_aaa', '32768', '[]', sys.executable, '-c', parent]
    a = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    b = subprocess.Popen([sys.executable, '-c', text, 'run', 'nonce-b', 'run_bbb', '32768', '[]', sys.executable, '-c', 'import time;time.sleep(.5);print("sibling")'], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
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
    result = subprocess.run([sys.executable, '-c', text, 'run', 'nonce', 'run_delayed', '32768', '[]', sys.executable, '-c', 'open(' + repr(str(marker)) + ',"w").write("bad")'], capture_output=True, timeout=5)
    assert result.returncode == 0 and json.loads(result.stdout)['result']['exit_code'] == -9
    assert not marker.exists()
    result = subprocess.run([sys.executable, '-c', text, 'control', 'run_delayed', 'wrong-nonce', 'cancel'], capture_output=True, timeout=5)
    assert result.returncode != 0
