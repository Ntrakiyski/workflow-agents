"""Fixed trusted profile bootstrap; the SHA256 comes from the operator, never a request."""
import hashlib
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
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
                path.chmod(0o755 if item.mode & 0o111 else 0o644)
        (temp / '.bundle-sha256').write_text(expected_sha256)
        temp.rename(target)
    except BaseException:
        shutil.rmtree(temp)
        raise


def main():
    digest, request_id = sys.argv[1:]
    if platform.machine() != 'x86_64' or not re.fullmatch('[a-f0-9-]{36}', request_id):
        raise ValueError('Architecture or request identity mismatch')
    runtime = ROOT / 'runtime' / digest
    install(ROOT / 'runtime/runtime-bundle.tar.gz', runtime, digest)
    os.execv(sys.executable, [sys.executable, '-B', str(runtime / 'guest.py'), request_id])


if __name__ == '__main__':
    main()
