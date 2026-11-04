"""Build a checksummed uploaded tool bundle; no VM image or clone is produced."""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent
MAX_BUNDLE = 256 * 1024 * 1024


def download(spec, destination):
    if not spec['url'].startswith('https://'):
        raise ValueError('HTTPS dependency required')
    with urlopen(spec['url'], timeout=60) as source, destination.open('wb') as target:
        shutil.copyfileobj(source, target)
    with destination.open('rb') as source:
        if hashlib.file_digest(source, 'sha256').hexdigest() != spec['sha256']:
            raise ValueError('Dependency checksum mismatch')


def copy_icu(lock, bundle):
    """Extract exact ICU ELF bytes only from the locked immutable image, not the host."""
    spec = lock['icu']
    container = subprocess.check_output(['docker', 'create', '--network', 'none',
        '--label', 'workflow-agents.workload-build=pi-document-agent', spec['source_image'], '/bin/true'], text=True).strip()
    try:
        with tempfile.TemporaryDirectory() as metadata_temp:
            status = Path(metadata_temp) / 'status'
            subprocess.run(['docker', 'cp', container + ':/var/lib/dpkg/status', str(status)], check=True)
            packages = [entry for entry in status.read_text().split('\n\n')
                        if entry.startswith('Package: ' + spec['package'] + '\n')]
            if (len(packages) != 1 or '\nVersion: ' + spec['version'] + '\n' not in packages[0]
                    or '\nArchitecture: ' + spec['architecture'] + '\n' not in packages[0]):
                raise ValueError('ICU source package identity mismatch')
        directory = bundle / 'lib'
        directory.mkdir()
        for item in spec['files']:
            target = directory / item['filename']
            subprocess.run(['docker', 'cp', '-L', container + ':' + item['source_path'], str(target)], check=True)
            with target.open('rb') as source:
                digest = hashlib.file_digest(source, 'sha256').hexdigest()
            if target.is_symlink() or target.stat().st_size != item['size_bytes'] or digest != item['sha256']:
                raise ValueError('ICU library checksum mismatch')
        copyright_path = directory / 'ICU-COPYRIGHT'
        subprocess.run(['docker', 'cp', '-L', container + ':' + spec['copyright_source'], str(copyright_path)], check=True)
        if hashlib.sha256(copyright_path.read_bytes()).hexdigest() != spec['copyright_sha256']:
            raise ValueError('ICU copyright checksum mismatch')
        (directory / 'icu-provenance.json').write_text(json.dumps(spec, indent=2) + '\n')
    finally:
        subprocess.run(['docker', 'rm', container], check=True, stdout=subprocess.DEVNULL)


def build(output):
    lock = json.loads((ROOT / 'runtime-lock.json').read_text())
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=output) as temp:
        stage = Path(temp)
        node_archive, office = stage / 'node.tar.xz', stage / 'officecli'
        download(lock['node'], node_archive)
        download(lock['officecli'], office)
        bundle = stage / 'runtime'
        bundle.mkdir()
        copy_icu(lock, bundle)
        with tarfile.open(node_archive) as source:
            member = source.getmember('node-v' + lock['node']['version'] + '-linux-x64/bin/node')
            stream = source.extractfile(member)
            if stream is None:
                raise ValueError('Missing Node executable')
            with (bundle / 'node').open('wb') as target:
                shutil.copyfileobj(stream, target)
        (bundle / 'node').chmod(0o755)
        shutil.copyfile(office, bundle / 'officecli')
        (bundle / 'officecli').chmod(0o755)
        for name in ('package.json', 'package-lock.json'):
            shutil.copyfile(ROOT / name, bundle / name)
        env = os.environ | {'PATH': str(bundle) + ':' + os.environ['PATH']}
        subprocess.run(['npm', 'ci', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund'],
                       cwd=bundle, env=env, check=True, stdout=subprocess.DEVNULL)
        for name in ('guest.py', 'validation.py', 'officecli-tool.ts', 'officecli-arguments.mjs', 'runtime-lock.json'):
            shutil.copyfile(ROOT / name, bundle / name)
        # Packing dereferences npm's .bin links; guest extraction accepts regular files only.
        archive = output / 'runtime-bundle.tar.gz'
        with archive.open('wb') as raw, gzip.GzipFile(filename='', fileobj=raw, mode='wb', mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode='w', dereference=True) as target:
                for path in sorted(bundle.rglob('*')):
                    if path.is_dir():
                        continue
                    name = path.relative_to(bundle).as_posix()
                    info = target.gettarinfo(str(path.resolve()), arcname=name)
                    info.uid = info.gid = info.mtime = 0
                    info.uname = info.gname = ''
                    info.mode = 0o755 if os.access(path, os.X_OK) else 0o644
                    with path.open('rb') as source:
                        target.addfile(info, source)
        if archive.stat().st_size > MAX_BUNDLE:
            archive.unlink()
            raise ValueError('Bundle exceeds scoped transfer limit')
        with archive.open('rb') as source:
            digest = hashlib.file_digest(source, 'sha256').hexdigest()
        metadata = {'schema_version': 1, 'workload_version': lock['workload_version'],
                    'architecture': lock['architecture'], 'size_bytes': archive.stat().st_size,
                    'sha256': digest,
                    'expanded_bytes': sum(p.stat().st_size for p in bundle.rglob('*') if p.is_file()),
                    'node_version': lock['node']['version'], 'pi_version': lock['pi']['version'],
                    'officecli_version': lock['officecli']['version'],
                    'icu': lock['icu'],
                    'source_sha256': {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
                                      for name in ('guest.py', 'validation.py', 'officecli-tool.ts', 'officecli-arguments.mjs', 'runtime-lock.json')},
                    'package_lock_sha256': hashlib.sha256((ROOT / 'package-lock.json').read_bytes()).hexdigest()}
        (output / 'runtime-bundle.json').write_text(json.dumps(metadata, indent=2) + '\n')
        print(json.dumps(metadata))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'output')
    build(parser.parse_args().output.resolve())
