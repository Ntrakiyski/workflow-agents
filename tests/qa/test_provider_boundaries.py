"""QA-owned API/DB regressions with an independent, explicitly mocked runtime.

Run against only the dedicated QA logical database. No microVM is created.
"""
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import uuid
import pytest
from httpx import ASGITransport, AsyncClient
from provider.app import create_app
from provider.config import Settings
from provider.errors import ServiceError
from provider.runtime import RuntimeIdentity

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('contract_response', ROOT / 'contracts/assert_response.py')
contract = importlib.util.module_from_spec(spec)
spec.loader.exec_module(contract)
TOKEN = 'qa-reviewed-client-token-' + 'a' * 24
OTHER_TOKEN = 'qa-reviewed-other-token-' + 'b' * 24


class Execution:
    def __init__(self, value):
        self.key = 'qae_' + uuid.uuid4().hex
        self.value = value
        self.task = asyncio.create_task(asyncio.sleep(.1))
    def id(self):
        return self.key


class QARuntime:
    kind = 'qa-mocked-runtime'
    def __init__(self):
        self.boxes, self.executions, self.commands = {}, {}, []
    async def ready(self):
        return True
    async def ensure(self, name, profile):
        self.boxes[name] = True
        return await self.inspect(name)
    async def inspect(self, name):
        return RuntimeIdentity(name, name, self.boxes[name]) if name in self.boxes else None
    async def start(self, name):
        self.boxes[name] = True
        return await self.inspect(name)
    async def stop(self, name):
        if name not in self.boxes:
            raise ServiceError(409, 'missing_runtime', 'Retained environment could not be located.')
        self.boxes[name] = False
        for execution in self.executions.values():
            execution.task.cancel()
        await asyncio.gather(*(x.task for x in self.executions.values()), return_exceptions=True)
    async def destroy(self, name):
        self.boxes.pop(name, None)
    async def execute(self, name, argv, profile, timeout):
        self.commands.append((name, argv, timeout))
        execution = Execution(argv[1])
        self.executions[execution.key] = execution
        return execution
    async def attach(self, name, execution_id):
        return self.executions[execution_id]
    async def collect(self, execution, max_output):
        await asyncio.shield(execution.task)
        raw = execution.value.encode()
        return {'exit_code': 0, 'stdout': raw[:max_output].decode(errors='replace'), 'stderr': '',
                'output_truncated': len(raw) > max_output, 'artifacts': []}
    async def cancel(self, execution):
        execution.task.cancel()
        await asyncio.gather(execution.task, return_exceptions=True)
    async def close(self):
        pass


def settings():
    url = os.environ.get('TEST_DATABASE_URL')
    if not url:
        pytest.skip('Dedicated QA PostgreSQL required')
    policy = {'permissions': ['sandbox:' + a for a in ('read', 'create', 'start', 'stop', 'execute', 'cancel', 'destroy')], 'sandbox_profiles': ['qa-environment:v2'], 'workload_profiles': ['qa-new-program:v9']}
    auth = [dict(policy, token=TOKEN, actor_id='qa-actor', owner_id='qa-owner'),
            dict(policy, token=OTHER_TOKEN, actor_id='qa-other-actor', owner_id='qa-other-owner')]
    profiles = {'version': 1, 'sandboxes': {'qa-environment:v2': {'image': 'example.invalid/qa@sha256:' + 'a' * 64,
                'cpus': 1, 'memory_mib': 128, 'disk_mib': 1024, 'network': 'denied'}},
                'workloads': {'qa-new-program:v9': {'argv': ['/operator-approved-program', '${arg:message}'],
                'arguments_schema': {'type': 'object', 'properties': {'message': {'type': 'string', 'maxLength': 512}},
                                     'required': ['message'], 'additionalProperties': False},
                'sandbox_profiles': ['qa-environment:v2'], 'working_directory': '/',
                'max_duration_seconds': 5, 'max_output_bytes': 64}}}
    return Settings(url, auth, profiles, poll_seconds=.05)


def headers(key='qa-create', token=TOKEN):
    return {'Authorization': 'Bearer ' + token, 'Idempotency-Key': key, 'X-Correlation-ID': 'qa-independent-correlation'}


@pytest.fixture
async def env():
    runtime = QARuntime()
    app = create_app(settings(), runtime)
    async with app.router.lifespan_context(app):
        async with app.state.service.db.tx() as c:
            await c.execute('TRUNCATE sandboxes,idempotency CASCADE')
        async with AsyncClient(transport=ASGITransport(app=app), base_url='http://qa.invalid') as client:
            yield app, client, runtime


async def create(client):
    result = await client.post('/v1/sandboxes', headers=headers(), json={'owner_ref': 'qa-new-client', 'profile': 'qa-environment:v2', 'persistent': True})
    assert result.status_code == 201, result.text
    contract.assert_response('provider', 'POST', '/v1/sandboxes', 201, result.json())
    return result.json()['sandbox_id']


async def poll(client, sid, rid):
    for _ in range(80):
        result = await client.get(f'/v1/sandboxes/{sid}/runs/{rid}', headers=headers())
        assert result.status_code == 200
        contract.assert_response('provider', 'GET', f'/v1/sandboxes/{sid}/runs/{rid}', 200, result.json())
        if result.json()['status'] in {'completed', 'failed', 'cancelled', 'timed_out'}:
            return result.json()
        await asyncio.sleep(.025)
    raise AssertionError('Mocked run did not finish')


async def test_non_ascii_credentials_and_strict_body_errors(env):
    _, client, _ = env
    r = await client.get('/v1/sandboxes/missing', headers=[(b'authorization', b'Bearer \xe9bad-token')])
    assert r.status_code == 401, r.text
    contract.assert_response('provider', 'GET', '/v1/sandboxes/missing', 401, r.json())
    malformed_host = await client.get('/v1/sandboxes/missing', headers={'Host': 'qa.invalid/not-protected?x='})
    assert malformed_host.status_code in {400, 401}, malformed_host.text
    for raw, content_type, status in [(b'x' * 65537, 'application/json', 413), (b'{}', 'text/plain', 415), (b'{', 'application/json', 400)]:
        r = await client.post('/v1/sandboxes', headers=headers() | {'Content-Type': content_type}, content=raw)
        assert r.status_code == status, r.text
        contract.assert_response('provider', 'POST', '/v1/sandboxes', status, r.json())


async def test_unfamiliar_configured_profile_and_wrong_owner(env):
    _, client, runtime = env
    sid = await create(client)
    r = await client.post(f'/v1/sandboxes/{sid}/execute', headers=headers('qa-new-profile'), json={
        'execution_ref': 'qa-new-reference', 'profile': 'qa-new-program:v9', 'arguments': {'message': 'hello independent client'}, 'timeout_seconds': 2})
    assert r.status_code == 202, r.text
    done = await poll(client, sid, r.json()['run_id'])
    assert done['status'] == 'completed' and done['result']['stdout'] == 'hello independent client'
    assert runtime.commands[0][1] == ['/operator-approved-program', 'hello independent client']
    for suffix in ['', '/events', '/runs/' + done['run_id']]:
        r = await client.get(f'/v1/sandboxes/{sid}' + suffix, headers=headers(token=OTHER_TOKEN))
        assert r.status_code == 404
    r = await client.get(f'/v1/sandboxes/{sid}/events?cursor=v1:999999999999999999999999', headers=headers())
    assert r.status_code == 400
    # A configured argument is passed as one literal argv element; it is not shell-interpolated.
    attack = '$(touch /should-never-run); echo shell'
    r = await client.post(f'/v1/sandboxes/{sid}/execute', headers=headers('qa-literal-argv'), json={
        'execution_ref': 'qa-literal-reference', 'profile': 'qa-new-program:v9', 'arguments': {'message': attack}, 'timeout_seconds': 2})
    assert r.status_code == 202
    await poll(client, sid, r.json()['run_id'])
    assert runtime.commands[-1][1] == ['/operator-approved-program', attack]


async def test_durable_cancellation_fence_prevents_any_later_execute(env):
    app, client, runtime = env
    sid = await create(client)
    path = f'/v1/sandboxes/{sid}'
    body = {'execution_ref': 'qa-fence-first', 'reason': 'Cancel before uncertain HTTP dispatch'}
    for _ in range(2):
        r = await client.post(path + '/runs/cancel-by-reference', headers=headers(), json=body)
        assert r.status_code == 202 and r.json()['status'] == 'fenced'
        contract.assert_response('provider', 'POST', path + '/runs/cancel-by-reference', 202, r.json())
    async with app.state.service.db.tx() as c:
        found = await (await c.execute('SELECT count(*) AS n FROM cancellation_fences WHERE sandbox_id=%s', (sid,))).fetchone()
        assert found['n'] == 1
    execute = {'execution_ref': body['execution_ref'], 'profile': 'qa-new-program:v9', 'arguments': {'message': 'must not run'}, 'timeout_seconds': 2}
    replies = await asyncio.gather(*(client.post(path + '/execute', headers=headers('qa-late-' + str(i)), json=execute) for i in range(12)))
    assert all(r.status_code == 409 and r.json()['code'] == 'execution_cancelled' for r in replies)
    assert runtime.commands == []


async def test_two_provider_instances_share_database_execution_claim(env):
    app, client, runtime = env
    second = create_app(settings(), runtime)
    async with second.router.lifespan_context(second):
        sid = await create(client)
        payload = {'execution_ref': 'qa-duplicate-ref', 'profile': 'qa-new-program:v9', 'arguments': {'message': 'one physical execution'}, 'timeout_seconds': 2}
        requests = await asyncio.gather(*(client.post(f'/v1/sandboxes/{sid}/execute', headers=headers('qa-duplicate'), json=payload) for _ in range(12)))
        assert all(r.status_code == 202 for r in requests)
        run_ids = {r.json()['run_id'] for r in requests}
        assert len(run_ids) == 1
        done = await poll(client, sid, run_ids.pop())
        assert done['status'] == 'completed'
        assert len(runtime.commands) == 1


async def test_destroy_reconciles_removal_after_lost_success_response(env):
    app, client, runtime = env
    sid = await create(client)
    original_destroy = runtime.destroy
    first = True
    async def remove_then_lose_response(name):
        nonlocal first
        await original_destroy(name)
        if first:
            first = False
            raise ServiceError(503, 'runtime_unavailable', 'Lost runtime removal response.', True)
    runtime.destroy = remove_then_lose_response
    path = f'/v1/sandboxes/{sid}/destroy'
    payload = {'confirm': True, 'reason': 'QA explicit disposable destruction'}
    first_response = await client.post(path, headers=headers(), json=payload)
    assert first_response.status_code in {200, 503}, first_response.text
    retried = await client.post(path, headers=headers(), json=payload)
    assert retried.status_code == 200 and retried.json()['status'] == 'destroyed', retried.text
    assert runtime.boxes == {}


async def test_read_only_identity_cannot_mutate_even_with_profile_access(env):
    app, client, runtime = env
    sid = await create(client)
    token = 'qa-readonly-token-' + 'r' * 24
    original = app.state.service.settings.auth[0]
    app.state.service.settings.auth.append(dict(original, token=token, actor_id='qa-readonly', permissions=['sandbox:read']))
    readonly = headers('qa-readonly', token)
    assert (await client.get(f'/v1/sandboxes/{sid}', headers=readonly)).status_code == 200
    assert (await client.get(f'/v1/sandboxes/{sid}/events', headers=readonly)).status_code == 200
    requests = [('/v1/sandboxes', {'owner_ref': 'readonly-disallowed', 'profile': 'qa-environment:v2', 'persistent': True}),
                (f'/v1/sandboxes/{sid}/start', {}), (f'/v1/sandboxes/{sid}/stop', {}),
                (f'/v1/sandboxes/{sid}/destroy', {'confirm': True, 'reason': 'must be denied'}),
                (f'/v1/sandboxes/{sid}/execute', {'execution_ref': 'readonly-execute', 'profile': 'qa-new-program:v9',
                    'arguments': {'message': 'must not run'}, 'timeout_seconds': 1}),
                (f'/v1/sandboxes/{sid}/runs/cancel-by-reference', {'execution_ref': 'readonly-fence'})]
    for path, body in requests:
        r = await client.post(path, headers=readonly, json=body)
        assert r.status_code == 403, (path, r.text)
        contract.assert_response('provider', 'POST', path, 403, r.json())
    assert runtime.commands == []
