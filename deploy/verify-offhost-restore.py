#!/usr/bin/env python3
"""Restore off-host encrypted infra archives into disposable databases only.

No Provider/Runner server or Cloud client is started. Historical destroyed
sandbox identities remain tombstones; retained guest identities are refused
unless the explicit offline forensic mode is selected. That mode preserves records
for comparison only and never permits starting a Provider or operational cutover.
"""
import argparse
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]


def command(args, env, cwd):
    result = subprocess.run(args, cwd=cwd, env=env, capture_output=True, timeout=90)
    if result.returncode:
        raise RuntimeError('restore_subprocess_failed')
    return result.stdout.decode()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--credentials', type=Path, required=True)
    parser.add_argument('--source-root', type=Path, required=True)
    parser.add_argument('--python', required=True)
    parser.add_argument('--evidence', type=Path, required=True)
    parser.add_argument('--infrastructure-only', action='store_true',
                        help='Exclude application archive; verify it with verify-application-restore.mjs')
    parser.add_argument('--forensic-registry-only', action='store_true',
                        help='Restore retained external bindings for offline comparison only; never permits a Provider startup/cutover')
    args = parser.parse_args()
    if args.forensic_registry_only and not args.infrastructure_only:
        parser.error('--forensic-registry-only requires --infrastructure-only')
    manifest = json.loads((args.archive / 'manifest.json').read_text())
    assert manifest['outcome'] == 'passed' and manifest['source_origin'] == 'https://hosting.gccssofia.com'
    credentials = json.loads(args.credentials.read_text())
    archives = [archive for archive in manifest['archives']
                if not args.infrastructure_only or archive['service'] != 'application']
    evidence = {'version': 1, 'operation': 'isolated-offhost-logical-restore',
                'source_session': manifest['session'], 'outcome': 'incomplete', 'services': [],
                'cloud_guest_restore': 'not exercised; source identities are destroyed tombstones or have no runtime',
                'runtime_client_started': False}
    if args.forensic_registry_only:
        evidence['operation'] = 'isolated-offhost-forensic-registry-restore'
        evidence['cloud_guest_restore'] = 'not exercised; retained external bindings are forensic records only, without attached guest disks'
        evidence['operational_provider_cutover_permitted'] = False
        evidence['forensic_registry_only'] = True
    evidence['excluded_services'] = [archive['service'] for archive in manifest['archives'] if archive not in archives]
    containers = []
    try:
        for archive in archives:
            name, commit = archive['service'], archive['deployed_commit']
            # Migrations must match the source being restored, not current HEAD.
            source_tree = command(['git', 'rev-parse', 'HEAD:services/' + name + '/migrations'], os.environ, args.source_root).strip()
            recorded_tree = command(['git', 'rev-parse', commit + ':services/' + name + '/migrations'], os.environ, args.source_root).strip()
            assert source_tree == recorded_tree, 'Restore migrations do not match backed-up source'
            container = 'workflow-offhost-restore-' + uuid.uuid4().hex[:12]
            password = secrets.token_urlsafe(32)
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', 0))
                port = sock.getsockname()[1]
            env = dict(os.environ, POSTGRES_PASSWORD=password)
            command(['docker', 'run', '-d', '--name', container, '--memory=256m', '--cpus=.5',
                     '--label', 'workflow-agents.restore=disposable', '-p', f'127.0.0.1:{port}:5432',
                     '-e', 'POSTGRES_PASSWORD', 'postgres:16-alpine'], env, ROOT)
            containers.append(container)
            for attempt in range(50):
                ready = subprocess.run(['docker', 'exec', container, 'pg_isready', '-U', 'postgres'],
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                if ready.returncode == 0:
                    break
                time.sleep(.2)
            else:
                raise RuntimeError('restore_database_not_ready')
            service = args.source_root / 'services' / name
            env = dict(os.environ, DATABASE_URL=f'postgresql://postgres:{password}@127.0.0.1:{port}/postgres')
            if name == 'job-runner':
                # The lead build is schema-identical; its migrations read the
                # same Runner SQL verified above, with pinned Graphile0.18.
                command(['node', 'dist/migrate-cli.js'], env, ROOT / 'services/job-runner')
                env.update(PHASE1_APP_ROOT=str(ROOT / 'services/job-runner'),
                           PHASE1_ARCHIVE_PASSWORD=credentials['provider_delegate_token'])
                executable = ['node', str(ROOT / 'deploy/migration-archive.mjs')]
            elif name == 'sandbox-provider':
                command([args.python, '-m', 'scripts.migrate'], env, service)
                env.update(PHASE1_ARCHIVE_PASSWORD=credentials['provider_operator_token'])
                executable = [args.python, str(ROOT / 'deploy/migration-archive.py')]
            else:
                raise RuntimeError('unexpected_archive_service')
            env['PHASE1_ARCHIVE_ENVELOPE'] = (args.archive / (name + '.encrypted.json')).read_text()
            results = []
            restore_flags = ['--restore', '--allow-bootstrap-metadata']
            if name == 'sandbox-provider' and args.forensic_registry_only:
                restore_flags.append('--allow-retained-runtime-records')
            for replay in range(2):
                raw = command(executable + restore_flags, env, service)
                result = json.loads(raw)
                assert result['outcome'] == 'passed'
                results.append(result)
            evidence['services'].append({'service': name, 'deployed_commit': commit,
                'migration_tree': source_tree, 'first_restore': results[0], 'idempotent_replay': results[1]})
        evidence['outcome'] = 'passed'
    except Exception as error:
        evidence['outcome'] = 'failed'
        evidence['error_classification'] = type(error).__name__
    finally:
        for container in containers:
            subprocess.run(['docker', 'rm', '-f', container], stdout=subprocess.DEVNULL, check=True)
    args.evidence.parent.mkdir(parents=True, exist_ok=True)
    args.evidence.write_text(json.dumps(evidence, indent=2) + '\n')
    print(json.dumps({'operation': evidence['operation'], 'outcome': evidence['outcome'],
                      'services_restored': len(evidence['services'])}))
    return 0 if evidence['outcome'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
