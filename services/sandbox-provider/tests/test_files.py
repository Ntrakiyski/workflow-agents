"""Real filesystem helper and PostgreSQL API tests; no hosted Cloud claim."""
import base64
import hashlib
import os
import pytest
from provider import guest_files
from provider.errors import ServiceError
from .test_provider import create, headers, conform, execute, wait_run
from .conftest import TOKEN_B


def sha(data):
    return hashlib.sha256(data).hexdigest()


def helper(root, monkeypatch):
    monkeypatch.setattr(guest_files, 'ROOT', str(root))
    root.mkdir(exist_ok=True)
    return guest_files.operate


def test_actual_guest_files_chunk_replay_partial_write_and_immutable_complete(tmp_path, monkeypatch):
    run = helper(tmp_path / 'guest', monkeypatch)
    data = b'hello file contents'
    upload = dict(upload_id='upl_' + 'a' * 32, path='inputs/original.txt', size_bytes=len(data), sha256=sha(data))
    chunk = upload | dict(operation='chunk', data_base64=base64.b64encode(data[:7]).decode(), offset=0, sha256=sha(data[:7]))
    assert run(chunk) == {'offset': 7}
    assert run(chunk) == {'offset': 7}
    chunk2 = upload | dict(operation='chunk', data_base64=base64.b64encode(data[7:]).decode(), offset=7, sha256=sha(data[7:]))
    staging = tmp_path / 'guest' / '.uploads' / upload['upload_id']
    with staging.open('ab') as stream:
        stream.write(data[7:10])  # interruption during the second chunk
    assert run(chunk2) == {'offset': len(data)}
    assert run(upload | {'operation': 'complete'}) == {'completed': True}
    assert run(upload | {'operation': 'complete'}) == {'completed': True}
    result = run({'operation': 'read', 'path': upload['path'], 'offset': 3, 'max_bytes': 5})
    assert base64.b64decode(result['data_base64']) == data[3:8]
    assert result['sha256'] == sha(data) and result['size_bytes'] == len(data) and not result['eof']
    with pytest.raises(ValueError):
        run(upload | {'operation': 'complete', 'sha256': sha(b'different')})
    assert (tmp_path / 'guest' / upload['path']).read_bytes() == data


def test_actual_guest_files_publication_recovers_after_link_before_ack(tmp_path, monkeypatch):
    run = helper(tmp_path / 'guest', monkeypatch)
    data = b'preserved'
    upload = dict(upload_id='upl_' + 'a' * 32, path='inputs/a.txt', size_bytes=len(data), sha256=sha(data))
    run(upload | dict(operation='chunk', data_base64=base64.b64encode(data).decode(), offset=0))
    (tmp_path / 'guest' / 'inputs').mkdir()
    os.link(tmp_path / 'guest' / '.uploads' / upload['upload_id'], tmp_path / 'guest' / upload['path'])
    assert run(upload | {'operation': 'complete'}) == {'completed': True}
    assert (tmp_path / 'guest' / upload['path']).stat().st_nlink == 1


def test_actual_guest_files_reject_paths_symlinks_special_files_and_conflicting_replay(tmp_path, monkeypatch):
    run = helper(tmp_path / 'guest', monkeypatch)
    outside = tmp_path / 'outside'
    outside.mkdir()
    (outside / 'secret.txt').write_bytes(b'secret')
    (tmp_path / 'guest' / 'link').symlink_to(outside, target_is_directory=True)
    (tmp_path / 'guest' / 'filelink.txt').symlink_to(outside / 'secret.txt')
    os.mkfifo(tmp_path / 'guest' / 'pipe')
    os.link(outside / 'secret.txt', tmp_path / 'guest' / 'hardlink.txt')
    for path in ('../outside/secret.txt', '/etc/passwd', 'a//b', '.uploads/a', 'link/secret.txt', 'filelink.txt', 'hardlink.txt', 'pipe'):
        with pytest.raises((ValueError, OSError)):
            run({'operation': 'read', 'path': path, 'offset': 0, 'max_bytes': 10})
    data = b'abc'
    upload = dict(upload_id='upl_' + 'b' * 32, path='a.txt', size_bytes=3, sha256=sha(data))
    run(upload | dict(operation='chunk', data_base64=base64.b64encode(data).decode(), offset=0))
    with pytest.raises(ValueError):
        run(upload | dict(operation='chunk', data_base64=base64.b64encode(b'xyz').decode(), sha256=sha(b'xyz'), offset=0))
    assert (outside / 'secret.txt').read_bytes() == b'secret'


def test_internal_fragmented_read_rejects_file_mutation_even_with_expected_hash(tmp_path,monkeypatch):
    run=helper(tmp_path/'guest',monkeypatch)
    file=tmp_path/'guest'/'file.bin';file.write_bytes(b'original')
    first=run({'operation':'read','path':'file.bin','offset':0,'max_bytes':2,'_include_stat':True})
    second={'operation':'read','path':'file.bin','offset':2,'max_bytes':2,
            '_expected_stat':first['_stat'],'_expected_sha256':first['sha256'],'_verify_sha256':True}
    assert base64.b64decode(run(second)['data_base64'])==b'ig'
    unchanged_metadata=file.stat()
    file.write_bytes(b'modified')
    # Some filesystems report identical metadata for rapid same-size writes.
    monkeypatch.setattr(guest_files.os,'fstat',lambda fd:unchanged_metadata)
    with pytest.raises(ValueError,match='file_changed'):
        run(second)


@pytest.mark.integration
async def test_files_api_owner_auth_checksum_idempotency_and_busy_run(env, tmp_path, monkeypatch):
    app, client, settings, runtime = env
    for policy in settings.auth:
        policy['permissions'] = policy['permissions'] + ['sandbox:file:read', 'sandbox:file:write']
    async def transfer(reference, request):
        root = tmp_path / reference
        root.mkdir(exist_ok=True)
        monkeypatch.setattr(guest_files, 'ROOT', str(root))
        try:
            return guest_files.operate(request)
        except (ValueError, OSError):
            raise ServiceError(409, 'file_transfer_rejected', 'Transfer rejected.') from None
    runtime.transfer = transfer
    sid = await create(client)
    data = b'original input'
    base = f'/v1/sandboxes/{sid}/files'
    body = dict(path='inputs/input.txt', size_bytes=len(data), sha256=sha(data))
    r = await client.post(base + '/uploads', headers=headers(key='upload-a'), json=body)
    assert r.status_code == 201, r.text
    conform('FileUpload', r.json())
    upload_id = r.json()['upload_id']
    assert (await client.post(base + '/uploads', headers=headers(key='upload-a'), json=body)).json() == r.json()
    assert (await client.post(base + '/uploads', headers=headers(key='upload-a'), json=body | {'path': 'different'})).status_code == 409
    assert (await client.post(base + '/uploads', headers=headers(TOKEN_B), json=body)).status_code == 404
    path = base + '/uploads/' + upload_id
    chunk = dict(offset=0, data_base64=base64.b64encode(data).decode(), sha256=sha(data))
    assert (await client.patch(path, headers=headers(), json=chunk | {'sha256': '0' * 64})).status_code == 422
    assert (await client.patch(path, headers=headers(), json=chunk)).json()['offset'] == len(data)
    assert (await client.patch(path, headers=headers(), json=chunk)).json()['offset'] == len(data)
    complete = await client.post(path + '/complete', headers=headers(), json={})
    assert complete.json()['status'] == 'completed'
    assert (await client.post(path + '/complete', headers=headers(), json={})).json() == complete.json()
    read = dict(path=body['path'], offset=0, max_bytes=1048576)
    r = await client.post(base + '/read', headers=headers(), json=read)
    assert r.status_code == 200 and base64.b64decode(r.json()['data_base64']) == data
    conform('FileChunk', r.json())
    assert (await client.post(base + '/read', headers=headers(TOKEN_B), json=read)).status_code == 404
    assert (await client.post(base + '/read', headers=headers(), json=read | {'path': '../secret'})).status_code == 422
    rid = await execute(client, sid, 'busy-files', 'fixture-delay:v1', {'seconds': .3})
    assert (await client.post(base + '/read', headers=headers(), json=read)).status_code == 409
    await wait_run(client, sid, rid)
    settings.auth[0]['permissions'] = [x for x in settings.auth[0]['permissions'] if x != 'sandbox:file:read']
    assert (await client.post(base + '/read', headers=headers(), json=read)).status_code == 403
    async with app.state.service.db.tx() as c:
        row = await (await c.execute('SELECT * FROM file_uploads WHERE upload_id=%s', (upload_id,))).fetchone()
        assert row['sha256'] == sha(data) and 'data_base64' not in row
        events = await (await c.execute("SELECT detail FROM audit_events WHERE type LIKE 'file.%'")).fetchall()
        assert all('path' not in e['detail'] and 'data_base64' not in e['detail'] for e in events)


@pytest.mark.integration
async def test_transfer_lost_ack_and_persisted_interruption_fence(env, tmp_path, monkeypatch):
    app, client, settings, runtime = env
    settings.auth[0]['permissions'] += ['sandbox:file:read', 'sandbox:file:write']
    root = tmp_path / 'guest'
    root.mkdir()
    monkeypatch.setattr(guest_files, 'ROOT', str(root))
    lost_ack = True
    async def transfer(reference, request):
        nonlocal lost_ack
        result = guest_files.operate(request)
        if lost_ack:
            lost_ack = False
            raise ServiceError(409, 'ambiguous_transfer', 'Lost acknowledgement.')
        return result
    runtime.transfer = transfer
    sid = await create(client)
    base = f'/v1/sandboxes/{sid}'
    data = b'only once'
    body = dict(path='inputs/input.txt', size_bytes=len(data), sha256=sha(data))
    upload = (await client.post(base + '/files/uploads', headers=headers(key='lost-ack'), json=body)).json()
    path = base + '/files/uploads/' + upload['upload_id']
    chunk = dict(offset=0, data_base64=base64.b64encode(data).decode(), sha256=sha(data))
    assert (await client.patch(path, headers=headers(), json=chunk)).status_code == 409
    assert (await client.get(base, headers=headers())).json()['status'] == 'stopped'
    assert (await client.post(base + '/start', headers=headers(), json={})).status_code == 200
    assert (await client.patch(path, headers=headers(), json=chunk)).json()['offset'] == len(data)
    assert (await client.post(path + '/complete', headers=headers(), json={})).status_code == 200
    assert (root / body['path']).read_bytes() == data
    # Persist the exact state left when the Provider dies after dispatch.
    async with app.state.service.db.tx() as c:
        await c.execute("UPDATE sandboxes SET file_operation_pending=true,file_operation_id='interrupted' WHERE sandbox_id=%s", (sid,))
    request = {'execution_ref': 'blocked-by-transfer', 'profile': 'future-workload:v7', 'arguments': {}, 'timeout_seconds': 1}
    assert (await client.post(base + '/execute', headers=headers(key='blocked'), json=request)).status_code == 409
    assert (await client.post(base + '/start', headers=headers(), json={})).status_code == 409
    await app.state.service.recover()
    assert (await client.get(base, headers=headers())).json()['status'] == 'stopped'
    assert (root / body['path']).read_bytes() == data and runtime.executes == 0


@pytest.mark.integration
async def test_runtime_cancellation_stop_is_reflected_before_terminal_status(env):
    _, client, _, runtime = env
    runtime.cancellation_stops_environment = True
    original = runtime.cancel
    async def cancel(execution):
        await original(execution)
        await runtime.stop(execution.name)
    runtime.cancel = cancel
    sid = await create(client)
    rid = await execute(client, sid, 'cancel-stops-box', 'fixture-delay:v1', {'seconds': 3})
    import asyncio
    await asyncio.sleep(.1)
    await client.post(f'/v1/sandboxes/{sid}/runs/{rid}/cancel', headers=headers(), json={})
    assert (await wait_run(client,sid,rid))['status'] == 'cancelled'
    box = (await client.get(f'/v1/sandboxes/{sid}', headers=headers())).json()
    assert box['status'] == 'stopped' and box['active_run_id'] is None
