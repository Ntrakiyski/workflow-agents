"""Actual pinned SDK against a loopback HTTP stub, never hosted Cloud/KVM."""
import copy
import json
import os
import threading
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace

import pytest

from provider.cloud_runtime import BoxLiteCloudRuntime
from provider.config import Settings
from provider.errors import ServiceError
from provider.runtime import configured_runtime
from provider.app import create_app
from httpx import ASGITransport, AsyncClient
from .conftest import policies, profiles


KEY = 'fake-cloud-key-for-loopback-only-123'
NAME = 'workflow-test-sbx_' + 'a' * 32


def configured(tmp_path):
    configured_profiles = profiles()
    configured_profiles['sandboxes']['minimal-linux:v1'].update(
        memory_mib=1024, entrypoint=['/bin/sleep', 'infinity'], cmd=[])
    return Settings('postgresql://not-connected', policies(), configured_profiles, tmp_path / 'unused',
                    runtime_mode='cloud', boxlite_rest_url='https://cloud.example.invalid',
                    boxlite_api_key=KEY, boxlite_account_scope='workflow-test', runtime_request_timeout=1)


class CloudStub:
    def __init__(self):
        self.boxes, self.requests = {}, []
        self.fail_create, self.unauthorized, self.mutate, self.pending_stops = False, False, None, {}

    def box(self, payload):
        network = payload['network']
        if 'outbound' not in network:
            network = {'outbound': network | {'allow_net': network.get('allow_net', [])},
                       'inbound': {'mode': 'disabled', 'allow_net': []}, 'published_ports': None}
        value = {'box_id': 'cloud-box-1', 'name': payload['name'], 'status': 'configured',
                 'created_at': '2026-11-03T00:00:00Z', 'updated_at': '2026-11-03T00:00:00Z',
                 'image': payload['image'], 'cpus': payload['cpus'], 'memory_mib': payload['memory_mib'],
                 'network': network, 'auto_stop': payload['auto_stop'],
                 'auto_delete': payload['auto_delete'], 'auto_resume': payload['auto_resume']}
        if self.mutate:
            self.mutate(value)
        return value


@contextmanager
def cloud_server():
    stub = CloudStub()
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass
        def do_GET(self):
            self.respond('GET')
        def do_POST(self):
            self.respond('POST')
        def do_DELETE(self):
            self.respond('DELETE')
        def respond(self, method):
            length = int(self.headers.get('Content-Length', '0'))
            payload = json.loads(self.rfile.read(length) or b'{}')
            stub.requests.append((method, self.path, payload))
            code, result = 200, {}
            parts = self.path.removeprefix('/v1/boxes').strip('/').split('/')
            if stub.unauthorized or self.headers.get('Authorization') != 'Bearer ' + KEY:
                code, result = 401, {'message': 'denied ' + KEY}
            elif self.path == '/v1/boxes' and method == 'GET':
                result = {'boxes': list(stub.boxes.values()), 'next_page_token': None}
            elif self.path == '/v1/boxes' and method == 'POST':
                if stub.fail_create:
                    code, result = 503, {'message': 'unavailable ' + KEY}
                else:
                    box = stub.box(payload)
                    stub.boxes[box['box_id']] = box
                    result = box
            elif parts[0] in stub.boxes:
                box = stub.boxes[parts[0]]
                result = box
                if len(parts) == 1 and method == 'GET' and parts[0] in stub.pending_stops:
                    stub.pending_stops[parts[0]] -= 1
                    if stub.pending_stops[parts[0]] <= 0:
                        box['status'] = 'stopped'
                        del stub.pending_stops[parts[0]]
                elif len(parts) == 1 and method == 'DELETE':
                    del stub.boxes[parts[0]]
                    code, result = 204, None
                elif parts[1:] == ['start'] and method == 'POST':
                    box['status'] = 'running'
                elif parts[1:] == ['stop'] and method == 'POST':
                    box['status'] = 'stopping'
                    stub.pending_stops[parts[0]] = 2
                elif parts[1:] == ['exec'] and method == 'POST':
                    result = {'execution_id': 'exec-1'}
                elif len(parts) > 1:
                    code, result = 503, {'message': 'stub has no guest execution or WebSocket'}
            else:
                code, result = 404, {'message': 'not found'}
            data = json.dumps(copy.deepcopy(result)).encode() if result is not None else b''
            self.send_response(code)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield stub, 'http://127.0.0.1:' + str(server.server_port)
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


def runtime_for(settings, url):
    # Production Settings rejects cleartext origins; only this loopback stub
    # overrides an already validated test Settings instance.
    settings.boxlite_rest_url = url
    return BoxLiteCloudRuntime(settings)


async def test_real_sdk_wire_retention_policy_stop_settles_and_reconnect_uses_same_id(tmp_path):
    settings = configured(tmp_path)
    with cloud_server() as (stub, url):
        runtime = runtime_for(settings, url)
        assert await runtime.ready()  # No local /dev/kvm required.
        found = await runtime.ensure(NAME, settings.profiles['sandboxes']['minimal-linux:v1'])
        assert found.running and found.runtime_id == 'cloud-box-1'
        create = next(payload for method, path, payload in stub.requests if method == 'POST' and path == '/v1/boxes')
        assert create['auto_delete'] == create['auto_stop'] == 0 and create['auto_resume'] is False
        assert create['detach'] is True and create['memory_mib'] == 1024 and create['disk_size_gb'] == 1
        # SDK0.11 serializes disabled inbound with its legacy outbound-only
        # shape; actual metadata must still confirm both directions disabled.
        assert create['network'] == {'mode': 'disabled'}
        assert create['entrypoint'] == ['/bin/sleep', 'infinity'] and create['cmd'] == []
        assert 'advanced' not in create and not create.get('ports')
        await runtime.stop(found.runtime_id)
        assert stub.boxes[found.runtime_id]['status'] == 'stopped' and found.runtime_id not in stub.pending_stops
        await runtime.close()
        assert not any(method == 'DELETE' for method, _, _ in stub.requests)
        replacement = runtime_for(settings, url)
        assert (await replacement.start(found.runtime_id)).runtime_id == found.runtime_id
        await replacement.destroy(found.runtime_id)
        assert not stub.boxes
        assert sum(method == 'DELETE' for method, _, _ in stub.requests) == 1
        await replacement.close()


async def test_create_transport_failure_is_not_replayed_and_fenced_retry_cannot_create(tmp_path):
    settings = configured(tmp_path)
    with cloud_server() as (stub, url):
        runtime = runtime_for(settings, url)
        stub.fail_create = True
        with pytest.raises(ServiceError) as error:
            await runtime.ensure(NAME, settings.profiles['sandboxes']['minimal-linux:v1'])
        assert KEY not in str(error.value) and error.value.retryable
        with pytest.raises(ServiceError) as error:
            await runtime.ensure(NAME, settings.profiles['sandboxes']['minimal-linux:v1'], allow_create=False)
        assert error.value.code == 'ambiguous_creation' and not error.value.retryable
        assert sum(method == 'POST' and path == '/v1/boxes' for method, path, _ in stub.requests) == 1
        await runtime.close()


async def test_metadata_drift_and_preexisting_names_fail_closed(tmp_path):
    settings = configured(tmp_path)
    with cloud_server() as (stub, url):
        runtime = runtime_for(settings, url)
        found = await runtime.ensure(NAME, settings.profiles['sandboxes']['minimal-linux:v1'])
        with pytest.raises(ServiceError, match='runtime_identity_mismatch'):
            await runtime.ensure(NAME, settings.profiles['sandboxes']['minimal-linux:v1'])
        recovered = await runtime.ensure(NAME, settings.profiles['sandboxes']['minimal-linux:v1'], allow_create=False)
        assert recovered.runtime_id == found.runtime_id
        stub.boxes[found.runtime_id]['network']['inbound']['mode'] = 'enabled'
        with pytest.raises(ServiceError, match='runtime_policy_mismatch'):
            await runtime.verify(found.runtime_id, settings.profiles['sandboxes']['minimal-linux:v1'])
        await runtime.destroy(found.runtime_id)  # Explicit cleanup still allowed after policy drift.
        await runtime.close()


async def test_auth_failure_and_missing_retained_box_never_fall_back(tmp_path):
    settings = configured(tmp_path)
    with cloud_server() as (stub, url):
        runtime = runtime_for(settings, url)
        stub.unauthorized = True
        assert not await runtime.ready()
        with pytest.raises(ServiceError) as error:
            await runtime.start('cloud-box-1')
        assert error.value.code == 'runtime_authentication_failed' and not error.value.retryable
        assert KEY not in error.value.message
        stub.unauthorized = False
        with pytest.raises(ServiceError, match='missing_runtime'):
            await runtime.start('cloud-box-1')
        assert not any(method == 'POST' for method, _, _ in stub.requests)
        await runtime.close()


async def test_legacy_small_profile_remains_readable_but_is_refused_before_cloud_requests(tmp_path):
    settings = configured(tmp_path)
    settings.profiles['sandboxes']['minimal-linux:v1']['memory_mib'] = 256
    with cloud_server() as (stub, url):
        runtime = runtime_for(settings, url)
        with pytest.raises(ServiceError, match='runtime_policy_rejected'):
            await runtime.ensure(NAME, settings.profiles['sandboxes']['minimal-linux:v1'])
        assert stub.requests == []


def test_backend_binding_survives_key_rotation_but_not_account_or_origin_change(tmp_path):
    settings = configured(tmp_path)
    original = configured_runtime(settings).backend_id
    settings.boxlite_api_key = 'another-test-key-for-the-same-account'
    assert configured_runtime(settings).backend_id == original
    settings.boxlite_account_scope = 'different-cloud-account'
    assert configured_runtime(settings).backend_id != original
    for mode in ('mock', 'automatic'):
        with pytest.raises(ValueError):
            Settings('postgresql://unused', policies(), profiles(), runtime_mode=mode)


@pytest.mark.integration
async def test_real_postgres_create_fence_survives_failed_http_and_backend_changes_are_refused(tmp_path):
    database_url = os.getenv('TEST_DATABASE_URL')
    if not database_url:
        pytest.skip('Requires a dedicated disposable PostgreSQL database.')
    settings = configured(tmp_path)
    settings.database_url = database_url
    with cloud_server() as (stub, url):
        runtime = runtime_for(settings, url)
        app = create_app(settings, runtime, dispatcher=False)
        async with app.router.lifespan_context(app):
            async with app.state.service.db.tx() as c:
                await c.execute('TRUNCATE sandboxes,runs,idempotency,audit_events RESTART IDENTITY CASCADE')
            async with AsyncClient(transport=ASGITransport(app=app), base_url='http://provider.test') as client:
                headers = {'Authorization': 'Bearer ' + settings.auth[0]['token'], 'Idempotency-Key': 'cloud-fence'}
                body = {'owner_ref': 'cloud-fence-owner', 'profile': 'minimal-linux:v1', 'persistent': True}
                stub.fail_create = True
                assert (await client.post('/v1/sandboxes', headers=headers, json=body)).status_code == 503
                async with app.state.service.db.tx() as c:
                    row = await (await c.execute('SELECT * FROM sandboxes')).fetchone()
                    assert row['runtime_create_attempted'] and row['runtime_id'] is None
                    assert row['runtime_backend'] == runtime.backend_id
                retry = await client.post('/v1/sandboxes', headers=headers, json=body)
                assert retry.status_code == 409 and retry.json()['code'] == 'ambiguous_creation'
                assert sum(method == 'POST' and path == '/v1/boxes' for method, path, _ in stub.requests) == 1
                before = len(stub.requests)
                runtime.backend_id = 'boxlite-cloud:wrong-account'
                assert (await client.get('/v1/sandboxes/' + row['sandbox_id'], headers=headers)).status_code == 200
                denied = await client.post('/v1/sandboxes/' + row['sandbox_id'] + '/destroy', headers=headers,
                                          json={'confirm': True, 'reason': 'owned test cleanup'})
                assert denied.status_code == 409 and denied.json()['code'] == 'runtime_backend_mismatch'
                assert len(stub.requests) == before


@pytest.mark.integration
async def test_real_postgres_registry_reopens_with_same_cloud_id_and_retained_stub_state(tmp_path):
    database_url = os.getenv('TEST_DATABASE_URL')
    if not database_url:
        pytest.skip('Requires a dedicated disposable PostgreSQL database.')
    settings = configured(tmp_path)
    settings.database_url = database_url
    with cloud_server() as (stub, url):
        runtime = runtime_for(settings, url)
        app = create_app(settings, runtime, dispatcher=False)
        headers = {'Authorization': 'Bearer ' + settings.auth[0]['token'], 'Idempotency-Key': 'cloud-create'}
        async with app.router.lifespan_context(app):
            async with app.state.service.db.tx() as c:
                await c.execute('TRUNCATE sandboxes,runs,idempotency,audit_events RESTART IDENTITY CASCADE')
            async with AsyncClient(transport=ASGITransport(app=app), base_url='http://provider.test') as client:
                created = await client.post('/v1/sandboxes', headers=headers,
                    json={'owner_ref': 'cloud-retain', 'profile': 'minimal-linux:v1', 'persistent': True})
                assert created.status_code == 201, created.text
                sid = created.json()['sandbox_id']
                assert (await client.post('/v1/sandboxes/' + sid + '/stop', headers=headers, json={})).status_code == 200
                async with app.state.service.db.tx() as c:
                    row = await (await c.execute('SELECT runtime_id,disk_ref,runtime_name FROM sandboxes WHERE sandbox_id=%s', (sid,))).fetchone()
                    assert row['runtime_id'] == 'cloud-box-1' and row['runtime_name'].startswith('workflow-test-sbx_')
                    assert row['disk_ref'].endswith('/cloud-box-1')
        replacement = create_app(settings, runtime_for(settings, url), dispatcher=False)
        async with replacement.router.lifespan_context(replacement):
            async with AsyncClient(transport=ASGITransport(app=replacement), base_url='http://provider.test') as client:
                resumed = await client.post('/v1/sandboxes/' + sid + '/start', headers=headers, json={})
                assert resumed.status_code == 200 and resumed.json()['status'] == 'running'
                events = (await client.get('/v1/sandboxes/' + sid + '/events', headers=headers)).json()['events']
                assert any(item['type'] == 'sandbox.recovered' for item in events)
                assert sum(method == 'POST' and path == '/v1/boxes' for method, path, _ in stub.requests) == 1
                assert (await client.post('/v1/sandboxes/' + sid + '/destroy', headers=headers,
                    json={'confirm': True, 'reason': 'owned test cleanup'})).status_code == 200
                assert not stub.boxes
