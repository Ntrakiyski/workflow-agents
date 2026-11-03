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
import re
import secrets
import socket
import subprocess
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]


class RestoreError(RuntimeError):
    """Fixed safe classification; never include subprocess or archive content."""


def command(args, env, cwd):
    result = subprocess.run(args, cwd=cwd, env=env, capture_output=True, timeout=90)
    if result.returncode:
        raise RestoreError('restore_subprocess_failed')
    return result.stdout.decode()


def selected_archives(manifest, infrastructure_only):
    if (not isinstance(manifest, dict) or manifest.get('outcome') != 'passed' or
            manifest.get('source_origin') != 'https://hosting.gccssofia.com' or
            not isinstance(manifest.get('session'), str) or
            not re.fullmatch(r'[A-Za-z0-9._:-]{1,128}', manifest['session']) or
            not isinstance(manifest.get('archives'), list)):
        raise RestoreError('restore_manifest_invalid')
    services, identities, deployments = set(), set(), set()
    for archive in manifest['archives']:
        if not isinstance(archive, dict):
            raise RestoreError('restore_manifest_invalid')
        name = archive.get('service')
        if name not in {'job-runner', 'sandbox-provider', 'application'} or name in services:
            raise RestoreError('restore_manifest_services_invalid')
        services.add(name)
        identity = archive.get('application_uuid')
        commit = archive.get('deployed_commit')
        deployment = archive.get('source_deployment_uuid')
        if (not isinstance(identity, str) or not re.fullmatch(r'[a-z0-9]{24}', identity) or
                identity in identities or not isinstance(commit, str) or
                not re.fullmatch(r'[0-9a-f]{40}', commit) or
                (deployment is not None and (not isinstance(deployment, str) or
                 not re.fullmatch(r'[a-z0-9]{24}', deployment) or deployment in deployments))):
            raise RestoreError('restore_manifest_identity_invalid')
        identities.add(identity)
        if deployment is not None:
            deployments.add(deployment)
    archives = [archive for archive in manifest['archives']
                if not infrastructure_only or archive['service'] != 'application']
    if {archive['service'] for archive in archives} != {'job-runner', 'sandbox-provider'}:
        raise RestoreError('restore_manifest_services_invalid')
    return archives


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
    evidence = {'version': 1, 'operation': 'isolated-offhost-logical-restore',
                'source_session': None, 'outcome': 'incomplete', 'services': [],
                'cloud_guest_restore': 'not exercised; source identities are destroyed tombstones or have no runtime',
                'runtime_client_started': False}
    if args.forensic_registry_only:
        evidence['operation'] = 'isolated-offhost-forensic-registry-restore'
        evidence['cloud_guest_restore'] = 'not exercised; retained external bindings are forensic records only, without attached guest disks'
        evidence['operational_provider_cutover_permitted'] = False
        evidence['forensic_registry_only'] = True
    containers = []
    try:
        manifest = json.loads((args.archive / 'manifest.json').read_text())
        archives = selected_archives(manifest, args.infrastructure_only)
        evidence['source_session'] = manifest['session']
        evidence['excluded_services'] = [archive['service'] for archive in manifest['archives'] if archive not in archives]
        credentials = json.loads(args.credentials.read_text())
        migration_trees = {}
        for archive in archives:
            name, commit = archive['service'], archive['deployed_commit']
            # Migrations must match the source being restored, not current HEAD.
            source_tree = command(['git', 'rev-parse', 'HEAD:services/' + name + '/migrations'], os.environ, args.source_root).strip()
            recorded_tree = command(['git', 'rev-parse', commit + ':services/' + name + '/migrations'], os.environ, args.source_root).strip()
            if source_tree != recorded_tree:
                raise RestoreError('restore_source_migrations_mismatch')
            applied_tree = source_tree
            if name == 'job-runner':
                applied_tree = command(['git', 'rev-parse', 'HEAD:services/job-runner/migrations'], os.environ, ROOT).strip()
                if applied_tree != recorded_tree:
                    raise RestoreError('restore_applied_migrations_mismatch')
            migration_trees[name] = (source_tree, applied_tree)
        for archive in archives:
            name, commit = archive['service'], archive['deployed_commit']
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
                raise RestoreError('restore_database_not_ready')
            service = args.source_root / 'services' / name
            env = dict(os.environ, DATABASE_URL=f'postgresql://postgres:{password}@127.0.0.1:{port}/postgres')
            if name == 'job-runner':
                # Preflight checked this actual migration tree as well as the
                # source worktree, before creating either disposable database.
                command(['node', 'dist/migrate-cli.js'], env, ROOT / 'services/job-runner')
                env.update(PHASE1_APP_ROOT=str(ROOT / 'services/job-runner'),
                           PHASE1_ARCHIVE_PASSWORD=credentials['provider_delegate_token'])
                executable = ['node', str(ROOT / 'deploy/migration-archive.mjs')]
            elif name == 'sandbox-provider':
                command([args.python, '-m', 'scripts.migrate'], env, service)
                env.update(PHASE1_ARCHIVE_PASSWORD=credentials['provider_operator_token'])
                executable = [args.python, str(ROOT / 'deploy/migration-archive.py')]
            else:
                raise RestoreError('unexpected_archive_service')
            env['PHASE1_ARCHIVE_ENVELOPE'] = (args.archive / (name + '.encrypted.json')).read_text()
            results = []
            restore_flags = ['--restore', '--allow-bootstrap-metadata']
            if name == 'sandbox-provider' and args.forensic_registry_only:
                restore_flags.append('--allow-retained-runtime-records')
            for replay in range(2):
                raw = command(executable + restore_flags, env, service)
                result = json.loads(raw)
                if result.get('outcome') != 'passed':
                    raise RestoreError('restore_result_not_passed')
                results.append(result)
            evidence['services'].append({'service': name, 'deployed_commit': commit,
                'migration_tree': migration_trees[name][0], 'applied_migration_tree': migration_trees[name][1],
                'first_restore': results[0], 'idempotent_replay': results[1]})
        evidence['outcome'] = 'passed'
    except Exception as error:
        evidence['outcome'] = 'failed'
        evidence['error_classification'] = str(error) if isinstance(error, RestoreError) else type(error).__name__
    finally:
        evidence['cleanup'] = []
        for container in containers:
            try:
                result = subprocess.run(['docker', 'rm', '-f', '-v', container],
                                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
                if result.returncode:
                    raise RestoreError('restore_cleanup_failed')
                evidence['cleanup'].append({'container': container, 'outcome': 'passed'})
            except Exception:
                evidence['cleanup'].append({'container': container, 'outcome': 'failed'})
                evidence['outcome'] = 'failed'
                evidence['error_classification'] = 'restore_cleanup_failed'
    args.evidence.parent.mkdir(parents=True, exist_ok=True)
    args.evidence.write_text(json.dumps(evidence, indent=2) + '\n')
    print(json.dumps({'operation': evidence['operation'], 'outcome': evidence['outcome'],
                      'services_restored': len(evidence['services'])}))
    return 0 if evidence['outcome'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
