"""Fixed trusted profile bootstrap; the SHA256 comes from the operator, never a request."""
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import runpy
import shutil
import stat
import sys
import tarfile

ROOT = Path('/opt/workflow-transfer')
MAX_EXPANDED = 2 * 1024 * 1024 * 1024


def install(archive, target, expected_sha256):
    if not re.fullmatch('[a-f0-9]{64}', expected_sha256):
        raise ValueError('Pinned runtime checksum required')
    with archive.open('rb') as source:
        if hashlib.file_digest(source, 'sha256').hexdigest() != expected_sha256:
            raise ValueError('Runtime bundle checksum mismatch')
    if target.exists():
        # No blind reinstall/replay; installed files are checked against the exact archive.
        if target.is_symlink() or (target / '.bundle-sha256').read_text() != expected_sha256:
            raise ValueError('Installed runtime identity mismatch')
        expected = {'.bundle-sha256'}
        with tarfile.open(archive) as source:
            for item in source:
                expected.add(item.name)
                if not item.isfile():
                    raise ValueError('Runtime archive contains non-regular entry')
                data = source.extractfile(item)
                path = target / item.name
                if data is None or path.is_symlink() or not path.is_file():
                    raise ValueError('Installed runtime file missing')
                with path.open('rb') as installed:
                    if hashlib.file_digest(data, 'sha256').digest() != hashlib.file_digest(installed, 'sha256').digest():
                        raise ValueError('Installed runtime file changed')
        actual = set()
        for path in target.rglob('*'):
            if path.is_symlink():
                raise ValueError('Installed runtime contains a symlink')
            if path.is_file():
                actual.add(path.relative_to(target).as_posix())
        if actual != expected:
            raise ValueError('Installed runtime contains unexpected files')
        return
    temp = target.with_name(target.name + '.installing')
    temp.mkdir(mode=0o700)
    try:
        with tarfile.open(archive) as source:
            total, names = 0, set()
            for item in source:
                name = PurePosixPath(item.name)
                if (not item.isfile() or name.is_absolute() or '..' in name.parts
                        or '\\' in item.name or item.name in names or not name.parts):
                    raise ValueError('Unsafe runtime archive entry')
                names.add(item.name)
                total += item.size
                if total > MAX_EXPANDED or len(names) > 40000:
                    raise ValueError('Runtime archive exceeds expansion bound')
                path = temp.joinpath(*name.parts)
                path.parent.mkdir(parents=True, exist_ok=True)
                data = source.extractfile(item)
                if data is None:
                    raise ValueError('Runtime file missing')
                with path.open('xb') as target_file:
                    shutil.copyfileobj(data, target_file)
                path.chmod(0o555 if item.mode & 0o111 else 0o444)
        marker = temp / '.bundle-sha256'
        with marker.open('x') as stream:
            stream.write(expected_sha256)
            stream.flush()
            os.fsync(stream.fileno())
        marker.chmod(0o444)
        for directory in sorted((path for path in temp.rglob('*') if path.is_dir()), reverse=True):
            directory.chmod(0o555)
        temp.chmod(0o555)
        temp.rename(target)
        descriptor = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    except BaseException:
        if temp.exists():
            temp.chmod(0o700)
            for directory in temp.rglob('*'):
                if directory.is_dir():
                    directory.chmod(0o700)
            shutil.rmtree(temp)
        raise


def require_prepared(runtime, expected_sha256):
    """Check the atomically published identity without rescanning shared tools per request."""
    if (not re.fullmatch('[a-f0-9]{64}', expected_sha256)
            or runtime.name != expected_sha256 or runtime.is_symlink()
            or not runtime.is_dir() or runtime.resolve() != runtime
            or runtime.stat().st_mode & 0o222):
        raise ValueError('Prepared runtime identity mismatch')
    marker = runtime / '.bundle-sha256'
    descriptor = os.open(marker, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, 'r') as source:
        info = os.fstat(source.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_mode & 0o222
                or source.read(65) != expected_sha256):
            raise ValueError('Prepared runtime marker mismatch')
    for name in ('guest.py', 'runtime-lock.json', 'node', 'officecli'):
        path = runtime / name
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o222:
            raise ValueError('Prepared runtime is not immutable')


def prepare(root, expected_sha256):
    if not re.fullmatch('[a-f0-9]{64}', expected_sha256):
        raise ValueError('Pinned runtime checksum required')
    directory = root / 'runtime'
    if directory.is_symlink() or directory.resolve() != directory:
        raise ValueError('Unsafe runtime directory')
    runtime = directory / expected_sha256
    # Preparation is a distinct tracked job. Never expose a half-installed runtime.
    descriptor = os.open(directory / (expected_sha256 + '.prepare.lock'),
                         os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'r+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        install(directory / 'runtime-bundle.tar.gz', runtime, expected_sha256)
        require_prepared(runtime, expected_sha256)
    return {'schema_version': 1, 'prepared': True, 'runtime_sha256': expected_sha256}


def run_controller(runtime, request_id, source):
    """Publish the profile-pinned small controller inside this request, reusing tools."""
    root = ROOT / 'requests' / request_id
    if (not re.fullmatch('[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}', request_id)
            or root.is_symlink() or root.resolve() != root or not root.is_dir()
            or not isinstance(source, str) or len(source.encode()) > 128 * 1024):
        raise ValueError('Controller request identity mismatch')
    config = root / 'config'
    if config.is_symlink():
        raise ValueError('Unsafe controller directory')
    config.mkdir(mode=0o700, exist_ok=True)
    encoded = source.encode()
    path = config / ('controller-' + hashlib.sha256(encoded).hexdigest() + '.py')
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o400)
    except FileExistsError:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(descriptor, 'rb') as current:
            info = os.fstat(current.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o222 or current.read(len(encoded) + 1) != encoded:
                raise ValueError('Controller identity mismatch')
    else:
        with os.fdopen(descriptor, 'wb') as target:
            target.write(encoded)
            target.flush()
            os.fsync(target.fileno())
        descriptor = os.open(config, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(runtime))
    module = runpy.run_path(str(path), init_globals={'PREPARED_RUNTIME_PATH': str(runtime)},
                            run_name='workflow_document_controller')
    return module['run'](request_id)


def main():
    digest, operation = sys.argv[1:]
    if platform.machine() != 'x86_64':
        raise ValueError('Architecture mismatch')
    if operation == '--prepare':
        print(json.dumps(prepare(ROOT, digest), separators=(',', ':')), flush=True)
        return
    if not re.fullmatch('[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}', operation):
        raise ValueError('Request identity mismatch')
    runtime = ROOT / 'runtime' / digest
    require_prepared(runtime, digest)
    if globals().get('CONTROLLER_SOURCE') is not None:
        raise SystemExit(run_controller(runtime, operation, CONTROLLER_SOURCE))
    os.execv(sys.executable, [sys.executable, '-B', str(runtime / 'guest.py'), operation])


if __name__ == '__main__':
    main()
