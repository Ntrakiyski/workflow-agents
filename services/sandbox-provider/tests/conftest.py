import json
import os
import pytest
from httpx import ASGITransport, AsyncClient
from provider.app import create_app
from provider.config import Settings
from .fake_runtime import FakeRuntime

TOKEN_A = 'test-client-a-token-000000000000'
TOKEN_B = 'test-client-b-token-000000000000'
TOKEN_DELEGATE = 'test-runner-token-0000000000000'


def policies():
    base = {'permissions': ['sandbox:' + action for action in ('read', 'create', 'start', 'stop', 'execute', 'cancel', 'destroy')], 'sandbox_profiles': ['minimal-linux:v1'],
            'workload_profiles': ['fixture-write-file:v1', 'fixture-read-file:v1', 'fixture-delay:v1', 'fixture-exit:v1', 'future-workload:v7']}
    return [dict(base, token=TOKEN_A, actor_id='client-a', owner_id='owner-a'),
            dict(base, token=TOKEN_B, actor_id='client-b', owner_id='owner-b'),
            dict(base, token=TOKEN_DELEGATE, actor_id='runner', owner_id='runner', delegate_owners=['owner-a', 'owner-b'])]


def profiles():
    file_schema = {'type': 'string', 'pattern': '^[A-Za-z0-9_-]+[.]txt$', 'maxLength': 64}
    def workload(argv, properties):
        return {'sandbox_profiles': ['minimal-linux:v1'], 'argv': argv,
                'arguments_schema': {'type': 'object', 'properties': properties, 'required': list(properties), 'additionalProperties': False},
                'working_directory': '/', 'max_duration_seconds': 30, 'max_output_bytes': 32768}
    return {'version': 1, 'sandboxes': {'minimal-linux:v1': {'image': 'example.invalid/fixture@sha256:' + 'a' * 64,
            'cpus': 1, 'memory_mib': 128, 'disk_mib': 1024, 'network': 'denied'}},
            'workloads': {
             'fixture-write-file:v1': workload(['/fixture/write', '${arg:file}', '${arg:text}'], {'file': file_schema, 'text': {'type': 'string', 'maxLength': 100000}}),
             'fixture-read-file:v1': workload(['/fixture/read', '${arg:file}'], {'file': file_schema}),
             'fixture-delay:v1': workload(['/fixture/delay', '${arg:seconds}'], {'seconds': {'type': 'number', 'minimum': .01, 'maximum': 10}}),
             'fixture-exit:v1': workload(['/fixture/exit', '${arg:code}'], {'code': {'type': 'integer', 'minimum': 0, 'maximum': 255}}),
             'future-workload:v7': workload(['/future/configured-program'], {})}}


@pytest.fixture
async def env(tmp_path):
    url = os.getenv('TEST_DATABASE_URL')
    if not url:
        pytest.skip('TEST_DATABASE_URL is required; integration tests use real isolated PostgreSQL.')
    settings = Settings(url, policies(), profiles(), str(tmp_path / 'boxes'), poll_seconds=.05)
    runtime = FakeRuntime()
    app = create_app(settings, runtime)
    async with app.router.lifespan_context(app):
        service = app.state.service
        async with service.db.tx() as c:
            await c.execute('TRUNCATE sandboxes,runs,idempotency,audit_events RESTART IDENTITY CASCADE')
        async with AsyncClient(transport=ASGITransport(app=app), base_url='http://provider.test') as client:
            yield app, client, settings, runtime
