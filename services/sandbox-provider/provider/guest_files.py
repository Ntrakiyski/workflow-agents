"""Fixed Python guest helper. Its source is sent as argv; bounded data uses stdin.

This module also executes on the controller in subprocess-based security tests.
Only the fixed root is used in deployed guests. No caller-supplied executable,
host path, URL, shell expansion or archive extraction is supported.
"""
import base64
import hashlib
import json
import os
import re
import stat
import sys

ROOT = '/opt/workflow-transfer'
MAX_FILE = 268435456
MAX_CHUNK = 1048576
SEGMENT = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$')


def components(path):
    parts = path.split('/')
    if len(path) > 512 or len(parts) > 16 or any(not SEGMENT.fullmatch(p) for p in parts):
        raise ValueError('invalid_path')
    return parts


def directory(parts, create=False):
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in ROOT.strip('/').split('/') + parts:
            if create:
                try:
                    os.mkdir(part, 0o700, dir_fd=fd)
                except FileExistsError:
                    pass
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def digest(fd):
    metadata = os.fstat(fd)
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > MAX_FILE or metadata.st_nlink != 1:
        raise ValueError('unsafe_file')
    h = hashlib.sha256()
    offset = 0
    while True:
        part = os.pread(fd, MAX_CHUNK, offset)
        if not part:
            break
        h.update(part)
        offset += len(part)
        if offset > MAX_FILE:
            raise ValueError('file_too_large')
    after = os.fstat(fd)
    if (metadata.st_size, metadata.st_mtime_ns, metadata.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
        raise ValueError('file_changed')
    return offset, h.hexdigest()


def operate(value):
    operation = value['operation']
    parts = components(value['path'])
    if operation == 'read':
        parent = directory(parts[:-1])
        try:
            fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        finally:
            os.close(parent)
        try:
            size, checksum = digest(fd)
            offset, maximum = value['offset'], value['max_bytes']
            if not 0 <= offset <= size or not 1 <= maximum <= MAX_CHUNK:
                raise ValueError('invalid_offset')
            data = os.pread(fd, maximum, offset)
            if digest(fd) != (size, checksum):
                raise ValueError('file_changed')
            return dict(path=value['path'], offset=offset, data_base64=base64.b64encode(data).decode(),
                        size_bytes=size, sha256=checksum, eof=offset + len(data) == size)
        finally:
            os.close(fd)
    upload = value['upload_id']
    if not re.fullmatch(r'upl_[a-f0-9]{32}', upload):
        raise ValueError('invalid_upload')
    staging = directory(['.uploads'], create=True)
    try:
        if operation == 'chunk':
            data = base64.b64decode(value['data_base64'], validate=True)
            offset, total = value['offset'], value['size_bytes']
            if not 0 < len(data) <= MAX_CHUNK or not 0 <= offset <= total <= MAX_FILE or offset + len(data) > total:
                raise ValueError('invalid_chunk')
            if hashlib.sha256(data).hexdigest() != value['sha256']:
                raise ValueError('checksum_mismatch')
            fd = os.open(upload, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=staging)
            try:
                metadata = os.fstat(fd)
                if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1 or metadata.st_size > total:
                    raise ValueError('unsafe_file')
                if metadata.st_size < offset:
                    raise ValueError('invalid_offset')
                existing = os.pread(fd, len(data), offset)
                if existing != data[:len(existing)]:
                    raise ValueError('chunk_conflict')
                position = len(existing)
                while position < len(data):
                    count = os.pwrite(fd, data[position:], offset + position)
                    if not count:
                        raise ValueError('incomplete_write')
                    position += count
                os.fsync(fd)
                return {'offset': os.fstat(fd).st_size}
            finally:
                os.close(fd)
        if operation != 'complete':
            raise ValueError('invalid_operation')
        parent = directory(parts[:-1], create=True)
        try:
            try:
                fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            except FileNotFoundError:
                fd = os.open(upload, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=staging)
                try:
                    if digest(fd) != (value['size_bytes'], value['sha256']):
                        raise ValueError('checksum_mismatch')
                    os.fsync(fd)
                    os.link(upload, parts[-1], src_dir_fd=staging, dst_dir_fd=parent, follow_symlinks=False)
                    os.unlink(upload, dir_fd=staging)
                    os.fsync(parent)
                finally:
                    os.close(fd)
            else:
                try:
                    # A lost acknowledgement/crash may occur between link and
                    # unlink. Reconcile only the exact staging inode, never a
                    # different hardlink or an unrelated destination.
                    try:
                        staged = os.stat(upload, dir_fd=staging, follow_symlinks=False)
                    except FileNotFoundError:
                        staged = None
                    published = os.fstat(fd)
                    if staged and (staged.st_dev, staged.st_ino) == (published.st_dev, published.st_ino) and published.st_nlink == 2:
                        os.unlink(upload, dir_fd=staging)
                        os.fsync(staging)
                    if digest(fd) != (value['size_bytes'], value['sha256']):
                        raise ValueError('file_conflict')
                finally:
                    os.close(fd)
            return {'completed': True}
        finally:
            os.close(parent)
    finally:
        os.close(staging)


if __name__ == '__main__':
    try:
        request = json.loads(sys.stdin.buffer.read(1500001))
        print(json.dumps({'ok': True, 'value': operate(request)}, separators=(',', ':')))
    except (ValueError, KeyError, TypeError, OSError):
        print(json.dumps({'ok': False, 'code': 'file_transfer_rejected'}))
        sys.exit(1)
