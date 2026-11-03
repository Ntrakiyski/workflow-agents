import asyncio
import pytest
from httpx import ASGITransport, AsyncClient
from provider.app import create_app
from provider.db import one
from .test_provider import create, execute, wait_run, headers

pytestmark = pytest.mark.integration


async def test_provider_process_model_restart_recovers_identity_and_retained_data(env):
    app, client, settings, runtime = env
    sid = await create(client)
    rid = await execute(client, sid)
    await wait_run(client, sid, rid)
    await client.post(f'/v1/sandboxes/{sid}/stop', headers=headers(), json={})
    await app.state.service.close()
    second = create_app(settings, runtime)
    async with second.router.lifespan_context(second):
        async with AsyncClient(transport=ASGITransport(app=second), base_url='http://provider.test') as c:
            assert (await c.get(f'/v1/sandboxes/{sid}', headers=headers())).json()['status'] == 'stopped'
            await c.post(f'/v1/sandboxes/{sid}/start', headers=headers(), json={})
            rid = await execute(c, sid, 'read-after-restart', 'fixture-read-file:v1', {'file': 'hello-world.txt'})
            assert (await wait_run(c, sid, rid))['result']['stdout'] == 'hello'
            events = (await c.get(f'/v1/sandboxes/{sid}/events', headers=headers())).json()['events']
            assert 'sandbox.recovered' in {x['type'] for x in events}
    assert runtime.creates == 1


async def test_inflight_execution_reattaches_without_duplicate(env):
    app, client, settings, runtime = env
    sid = await create(client)
    rid = await execute(client, sid, 'recover-run', 'fixture-delay:v1', {'seconds': .6}, timeout=5)
    for _ in range(50):
        async with app.state.service.db.tx() as c:
            run = await one(c, 'SELECT * FROM runs WHERE run_id=%s', (rid,))
        if run['runtime_execution_id']:
            break
        await asyncio.sleep(.01)
    assert run['runtime_execution_id']
    await app.state.service.close()
    second = create_app(settings, runtime)
    async with second.router.lifespan_context(second):
        async with AsyncClient(transport=ASGITransport(app=second), base_url='http://provider.test') as c:
            assert (await wait_run(c, sid, rid))['status'] == 'completed'
    assert runtime.executes == 1


async def test_ambiguous_dispatch_is_stopped_and_never_reexecuted(env):
    app, client, settings, runtime = env
    sid = await create(client)
    # Model crash between durable dispatch intent and SDK execution identity write.
    app.state.service.loop_task.cancel()
    await asyncio.gather(app.state.service.loop_task, return_exceptions=True)
    rid = await execute(client, sid, 'unknown-side-effect')
    async with app.state.service.db.tx() as c:
        await c.execute("UPDATE runs SET status='running',started_at=now() WHERE run_id=%s", (rid,))
    await app.state.service.close()
    second = create_app(settings, runtime)
    async with second.router.lifespan_context(second):
        async with AsyncClient(transport=ASGITransport(app=second), base_url='http://provider.test') as c:
            result = await wait_run(c, sid, rid)
            assert result['status'] == 'failed' and result['error']['code'] == 'ambiguous_execution'
            assert result['error']['retryable'] is False
    assert runtime.executes == 0 and runtime.boxes[sid]['running'] is False


async def test_missing_retained_box_is_not_recreated(env):
    app, client, settings, runtime = env
    sid = await create(client)
    await app.state.service.close()
    runtime.boxes.pop(sid)
    second = create_app(settings, runtime)
    async with second.router.lifespan_context(second):
        async with AsyncClient(transport=ASGITransport(app=second), base_url='http://provider.test') as c:
            result = await c.get(f'/v1/sandboxes/{sid}', headers=headers())
            assert result.json()['status'] == 'failed' and result.json()['error']['code'] == 'missing_runtime'
            assert (await c.post(f'/v1/sandboxes/{sid}/start', headers=headers(), json={})).status_code == 409
    assert runtime.creates == 1


async def test_destroy_success_with_lost_response_reconciles_tombstone(env):
    app, client, settings, runtime = env
    sid = await create(client)
    original = runtime.destroy
    async def remove_then_throw(name):
        await original(name)
        raise RuntimeError('Model success followed by lost runtime response')
    runtime.destroy = remove_then_throw
    r = await client.post(f'/v1/sandboxes/{sid}/destroy', headers=headers(), json={'confirm': True, 'reason': 'disposable'})
    assert r.status_code == 503
    async with app.state.service.db.tx() as c:
        row = await one(c, 'SELECT * FROM sandboxes WHERE sandbox_id=%s', (sid,))
        assert row['status'] == 'destroying'
    runtime.destroy = original
    await app.state.service.close()
    second = create_app(settings, runtime)
    async with second.router.lifespan_context(second):
        async with AsyncClient(transport=ASGITransport(app=second), base_url='http://provider.test') as c:
            r = await c.get(f'/v1/sandboxes/{sid}', headers=headers())
            assert r.json()['status'] == 'destroyed'
            assert (await c.post(f'/v1/sandboxes/{sid}/destroy', headers=headers(), json={'confirm': True, 'reason': 'again'})).json()['status'] == 'destroyed'
    assert runtime.removes == 1
