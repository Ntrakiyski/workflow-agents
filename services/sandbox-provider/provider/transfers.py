"""Generic owner-scoped immutable file transfer, independent of workloads."""
import base64
import binascii
import hashlib
import re
import uuid
from .audit import event
from .db import one
from .errors import ServiceError

MAX_FILE = 268435456
MAX_CHUNK = 1048576
MAX_BODY = 1500000
PATH = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}(?:/[A-Za-z0-9][A-Za-z0-9_.-]{0,127}){0,15}$')


def validate_path(path):
    if not isinstance(path, str) or len(path) > 512 or not PATH.fullmatch(path):
        raise ServiceError(422, 'invalid_path', 'Use a bounded relative path under the configured transfer root.')


def upload_json(row):
    return {k: row[k] for k in ('upload_id', 'sandbox_id', 'path', 'size_bytes', 'sha256', 'status')} | {'offset': row['offset_bytes']}


async def available(service, c, identity, sid):
    sb = await service.get_sandbox(c, identity, sid, lock=True)
    if sb['status'] != 'running' or sb['active_run_id'] or sb['file_operation_pending']:
        raise ServiceError(409, 'sandbox_busy', 'File transfer requires a running environment without an active execution.')
    await service.verify_runtime(sb)
    return sb


async def create_upload(service, identity, sid, key, body, correlation):
    from .service import uid
    validate_path(body['path'])
    async with service.db.tx() as c:
        sb = await service.get_sandbox(c, identity, sid, lock=True)
        upload_id = await service.replay(c, identity, 'file-upload:' + sid, key, body)
        if upload_id:
            row = await one(c, 'SELECT * FROM file_uploads WHERE upload_id=%s AND owner_id=%s', (upload_id, identity.owner))
            return upload_json(row)
        if sb['status'] != 'running' or sb['active_run_id'] or sb['file_operation_pending']:
            raise ServiceError(409, 'sandbox_busy', 'File transfer requires a running environment without an active execution.')
        existing = await one(c, 'SELECT upload_id FROM file_uploads WHERE sandbox_id=%s AND path=%s', (sid, body['path']))
        if existing:
            raise ServiceError(409, 'file_conflict', 'This destination is already reserved. Use a new immutable path.')
        upload_id = uid('upl')
        row = await one(c, '''INSERT INTO file_uploads(upload_id,sandbox_id,owner_id,path,size_bytes,sha256)
            VALUES(%s,%s,%s,%s,%s,%s) RETURNING *''',
            (upload_id, sid, identity.owner, body['path'], body['size_bytes'], body['sha256']))
        await service.remember(c, identity, 'file-upload:' + sid, key, body, upload_id)
        await event(c, sb, identity, correlation, 'file.upload_created', 'uploading', detail={'upload_id': upload_id})
        return upload_json(row)


async def update_upload(service, identity, sid, upload_id, body, correlation, complete=False):
    operation_id = uuid.uuid4().hex
    if not complete:
        try:
            raw = base64.b64decode(body['data_base64'], validate=True)
        except (ValueError, binascii.Error):
            raise ServiceError(422, 'invalid_chunk', 'Chunk must use canonical base64 encoding.') from None
        if not 0 < len(raw) <= MAX_CHUNK or hashlib.sha256(raw).hexdigest() != body['sha256']:
            raise ServiceError(422, 'checksum_mismatch', 'Chunk size or checksum is invalid.')
    async with service.db.tx() as c:
        sb = await service.get_sandbox(c, identity, sid, lock=True)
        row = await one(c, 'SELECT * FROM file_uploads WHERE upload_id=%s AND sandbox_id=%s AND owner_id=%s FOR UPDATE', (upload_id, sid, identity.owner))
        if not row:
            raise ServiceError(404, 'not_found', 'Upload was not found.')
        if complete and row['status'] == 'completed':
            return upload_json(row)
        if row['status'] == 'completed':
            raise ServiceError(409, 'file_conflict', 'Completed uploads are immutable.')
        await available(service, c, identity, sid)
        payload = {'operation': 'complete' if complete else 'chunk', 'upload_id': upload_id,
                   'path': row['path'], 'size_bytes': row['size_bytes'], 'sha256': row['sha256']}
        if not complete:
            offset = body['offset']
            if offset > row['offset_bytes'] or offset + len(raw) > row['size_bytes']:
                raise ServiceError(409, 'invalid_offset', 'Chunk offset is not contiguous or exceeds the declared file size.')
            payload.update(body)
        # Commit a durable fence before a guest side effect. A process crash
        # keeps execution/lifecycle admission blocked until same-box recovery.
        await c.execute('UPDATE sandboxes SET file_operation_pending=true,file_operation_id=%s WHERE sandbox_id=%s', (operation_id, sid))
    try:
        result = await service.runtime.transfer(service.runtime_reference(sb), payload)
        async with service.db.tx() as c:
            current = await service.get_sandbox(c, identity, sid, lock=True)
            if current['file_operation_id'] != operation_id:
                raise ServiceError(409, 'transfer_interrupted', 'This transfer was interrupted by a lifecycle operation. Inspect the same upload before continuing.')
            if complete:
                if result != {'completed': True}:
                    raise ServiceError(409, 'ambiguous_transfer', 'File publication could not be confirmed. Retry this same upload.')
                await c.execute("UPDATE file_uploads SET status='completed',offset_bytes=size_bytes,updated_at=now() WHERE upload_id=%s", (upload_id,))
                await event(c, sb, identity, correlation, 'file.upload_completed', 'completed', detail={'upload_id': upload_id, 'size_bytes': row['size_bytes'], 'sha256': row['sha256']})
            else:
                offset = result.get('offset')
                if type(offset) is not int or not row['offset_bytes'] <= offset <= row['size_bytes'] or offset < body['offset'] + len(raw):
                    raise ServiceError(409, 'ambiguous_transfer', 'Chunk completion could not be confirmed. Retry the same offset and bytes.')
                await c.execute('UPDATE file_uploads SET offset_bytes=%s,updated_at=now() WHERE upload_id=%s', (offset, upload_id))
            await c.execute('UPDATE sandboxes SET file_operation_pending=false,file_operation_id=NULL WHERE sandbox_id=%s', (sid,))
            return upload_json(await one(c, 'SELECT * FROM file_uploads WHERE upload_id=%s', (upload_id,)))
    except Exception:
        await fail_transfer(service, identity, sb, correlation, operation_id)
        raise


async def fail_transfer(service, identity, sb, correlation, operation_id):
    async with service.db.tx() as c:
        current = await service.get_sandbox(c, identity, sb['sandbox_id'], lock=True)
        if current['file_operation_id'] != operation_id:
            return  # A newer lifecycle/transfer owns this environment now.
        stopped = False
        try:
            await service.runtime.stop(service.runtime_reference(sb))
            stopped = True
        except Exception:
            pass
        await c.execute('UPDATE sandboxes SET status=%s,file_operation_pending=%s,file_operation_id=%s,updated_at=now() WHERE sandbox_id=%s',
                        ('stopped' if stopped else 'stopping', not stopped, None if stopped else operation_id, sb['sandbox_id']))
        await event(c, sb, identity, correlation, 'file.transfer_interrupted', 'stopped' if stopped else 'recovery_pending')


async def read_file(service, identity, sid, body, correlation):
    operation_id = uuid.uuid4().hex
    validate_path(body['path'])
    async with service.db.tx() as c:
        sb = await available(service, c, identity, sid)
        await c.execute('UPDATE sandboxes SET file_operation_pending=true,file_operation_id=%s WHERE sandbox_id=%s', (operation_id, sid))
    try:
        result = await service.runtime.transfer(service.runtime_reference(sb), {'operation': 'read'} | body)
        try:
            raw = base64.b64decode(result['data_base64'], validate=True)
            valid = (result['path'] == body['path'] and result['offset'] == body['offset']
                     and type(result['size_bytes']) is int and 0 <= result['size_bytes'] <= MAX_FILE
                     and re.fullmatch('[a-f0-9]{64}', result['sha256']) and len(raw) <= body['max_bytes']
                     and result['offset'] + len(raw) <= result['size_bytes']
                     and result['eof'] is (result['offset'] + len(raw) == result['size_bytes']))
        except (KeyError, TypeError, ValueError, binascii.Error):
            valid = False
        if not valid:
            raise ServiceError(409, 'ambiguous_transfer', 'A complete file chunk could not be confirmed. Retry this read.')
        async with service.db.tx() as c:
            current = await service.get_sandbox(c, identity, sid, lock=True)
            if current['file_operation_id'] != operation_id:
                raise ServiceError(409, 'transfer_interrupted', 'This read was interrupted by a lifecycle operation. Retry after inspecting the environment.')
            await c.execute('UPDATE sandboxes SET file_operation_pending=false,file_operation_id=NULL WHERE sandbox_id=%s', (sid,))
            if body['offset'] == 0:
                await event(c, sb, identity, correlation, 'file.download_started', 'completed', detail={'size_bytes': result['size_bytes'], 'sha256': result['sha256']})
        return result
    except Exception:
        await fail_transfer(service, identity, sb, correlation, operation_id)
        raise
