"""Opt-in LOCAL service processes -> actual Cloud qualification.

Run only with two newly provisioned disposable databases. This script never
targets GCC deployments and never creates an account-wide cleanup operation.
Database URLs and the Cloud key are read from private files, never argv values.
"""
import argparse
import asyncio
import base64
import hashlib
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlsplit
from datetime import datetime, timezone
import httpx


def port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


async def main(args):
    root = Path(__file__).resolve().parents[3]
    provider_root, runner_root = root / 'services/sandbox-provider', root / 'services/job-runner'
    for path in (args.provider_database_url_file, args.runner_database_url_file):
        parsed = urlsplit(path.read_text().strip())
        if parsed.hostname not in ('127.0.0.1', 'localhost') or not parsed.path.startswith('/workflow_shared_probe_'):
            raise RuntimeError('Use fresh disposable local workflow_shared_probe_* databases only.')
    state = Path(tempfile.mkdtemp(prefix='workflow-shared-proof-'))
    state.chmod(0o700)
    owner = 'shared-proof-' + secrets.token_hex(8)
    provider_token, runner_token = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
    pp, rp = port(), port()
    provider_url, runner_url = 'http://127.0.0.1:' + str(pp), 'http://127.0.0.1:' + str(rp)
    base = json.loads((root / 'deploy/profiles.cloud.staging.json').read_text())['sandboxes']['cloud-minimal-linux:v1']
    child = 'import os,time;os.setsid();time.sleep(120)'
    source = 'import subprocess,sys,time;mode=sys.argv[1];seconds=float(sys.argv[2]);subprocess.Popen(["python3","-c",' + repr(child) + ']) if mode=="descendant" else None;time.sleep(seconds);print("shared-proof-completed")'
    profiles = {'version': 1, 'sandboxes': {'shared-proof:v3': base | {'max_concurrent_runs': 2}}, 'workloads': {
        'shared-proof:v3': {'sandbox_profiles': ['shared-proof:v3'], 'argv': ['python3', '-c', source, '${arg:mode}', '${arg:seconds}'],
            'arguments_schema': {'type': 'object', 'properties': {'mode': {'enum': ['sleep', 'descendant']}, 'seconds': {'type': 'number', 'minimum': .01, 'maximum': 120}}, 'required': ['mode', 'seconds'], 'additionalProperties': False},
            'working_directory': '/', 'max_duration_seconds': 120, 'max_output_bytes': 32768}}}
    policy = {'owner_id': owner, 'sandbox_profiles': ['shared-proof:v3'], 'workload_profiles': ['shared-proof:v3']}
    provider_auth = [policy | {'token': provider_token, 'actor_id': 'shared-proof-provider-client', 'delegate_owners': [owner],
        'permissions': ['sandbox:' + a for a in ('read', 'create', 'start', 'stop', 'execute', 'cancel', 'destroy', 'file:read', 'file:write')]}]
    runner_auth = [policy | {'token': runner_token, 'actor_id': 'shared-proof-client', 'permissions': ['job:submit', 'job:read', 'job:cancel', 'schedule:write'], 'max_concurrency': 2}]
    pe = os.environ | {'DATABASE_URL': args.provider_database_url_file.read_text().strip(), 'PROVIDER_AUTH_JSON': json.dumps(provider_auth), 'PROVIDER_PROFILES_JSON': json.dumps(profiles),
        'SANDBOX_RUNTIME_MODE': 'cloud', 'BOXLITE_REST_URL': 'https://api.boxlite.ai', 'BOXLITE_ACCOUNT_SCOPE': 'workflow-agents-phase1-gcc',
        'BOXLITE_API_KEY': args.key_file.read_text().strip(), 'HOST': '127.0.0.1', 'PORT': str(pp), 'MAX_CONCURRENT_RUNS': '4', 'RUN_POLL_SECONDS': '.1', 'RUNTIME_REQUEST_TIMEOUT_SECONDS': '30'}
    re = os.environ | {'DATABASE_URL': args.runner_database_url_file.read_text().strip(), 'RUNNER_AUTH_JSON': json.dumps(runner_auth), 'RUNNER_PROFILES_JSON': json.dumps(profiles),
        'SANDBOX_PROVIDER_URL': provider_url, 'SANDBOX_PROVIDER_TOKEN': provider_token, 'HOST': '127.0.0.1', 'PORT': str(rp), 'QUEUE_CONCURRENCY': '4',
        'MAX_GLOBAL_CONCURRENCY': '4', 'MAX_OWNER_CONCURRENCY': '2', 'PROVIDER_TIMEOUT_MS': '120000', 'POLL_INTERVAL_MS': '100'}
    evidence = {'scope': 'local Provider and Runner processes, disposable real PostgreSQL, actual BoxLite Cloud, synthetic Python workloads; no GCC deployment or Pi',
        'started_at': datetime.now(timezone.utc).isoformat(), 'source_commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip(),
        'source_dirty': bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=root)), 'owner_id': owner, 'checks': {}}
    proof_sources = [*provider_root.joinpath('provider').glob('*.py'), *provider_root.joinpath('migrations').glob('*.sql'),
        *runner_root.joinpath('src').glob('*.ts'), *runner_root.joinpath('migrations').glob('*.sql'), Path(__file__).resolve()]
    evidence['source_files_sha256'] = {str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(proof_sources)}
    processes, handles, jobs, sid = [], [], [], None
    async with httpx.AsyncClient(timeout=150) as client:
        async def ready(url):
            end = time.monotonic() + 60
            while time.monotonic() < end:
                try:
                    result = await client.get(url + '/health/ready')
                    if result.status_code == 200:
                        return
                except httpx.HTTPError:
                    pass
                await asyncio.sleep(.2)
            raise RuntimeError('local_fixture_startup_failed; private logs: ' + str(state))
        async def request(base_url, method, path, body=None, key=None):
            provider = base_url == provider_url
            headers = {'Authorization': 'Bearer ' + (provider_token if provider else runner_token), 'X-Correlation-ID': 'shared-proof'}
            if provider:
                headers['X-Owner-ID'] = owner
            if key:
                headers['Idempotency-Key'] = key
            response = await client.request(method, base_url + path, headers=headers, json=body)
            if response.status_code >= 400:
                raise RuntimeError('fixture_api_' + str(response.status_code) + ':' + response.json().get('code', 'unknown'))
            return response.json()
        def launch_provider():
            handle = (state / ('provider-' + str(len(processes)) + '.log')).open('wb');handles.append(handle)
            process = subprocess.Popen([sys.executable, '-m', 'provider.app'], cwd=provider_root, env=pe, stdout=handle, stderr=subprocess.STDOUT);processes.append(process)
            return process
        async def submit(seconds, mode='sleep', timeout=60, ensure=False):
            body = {'workload': {'profile': 'shared-proof:v3', 'arguments': {'mode': mode, 'seconds': seconds}},
                'sandbox': {'mode': 'ensure', 'owner_ref': owner, 'profile': 'shared-proof:v3', 'persistent': True} if ensure else {'mode': 'reuse', 'sandbox_id': sid},
                'limits': {'max_duration_seconds': timeout, 'max_attempts': 1}}
            job = await request(runner_url, 'POST', '/v1/jobs', body, 'job-' + secrets.token_hex(12));jobs.append(job['job_id'])
            return job['job_id']
        async def wait(job_id, statuses, limit=120):
            end = time.monotonic() + limit
            while time.monotonic() < end:
                job = await request(runner_url, 'GET', '/v1/jobs/' + job_id)
                if job['status'] in statuses:
                    return job
                if job['status'] in ('completed', 'failed', 'cancelled', 'timed_out'):
                    raise RuntimeError('unexpected_job_state:' + job['status'] + ':' + str((job.get('error') or {}).get('code')))
                await asyncio.sleep(.2)
            raise RuntimeError('job_wait_timeout')
        try:
            provider_process = launch_provider()
            await ready(provider_url)
            handle = (state / 'runner.log').open('wb');handles.append(handle)
            processes.append(subprocess.Popen(['node', 'dist/main.js'], cwd=runner_root, env=re, stdout=handle, stderr=subprocess.STDOUT))
            await ready(runner_url)
            prepared = await wait(await submit(.01, ensure=True), {'completed'}, 240)
            sid = prepared['sandbox_id'];evidence['sandbox_id'] = sid
            a, b = await asyncio.gather(submit(90, 'descendant'), submit(18))
            await asyncio.gather(wait(a, {'running'}), wait(b, {'running'}));await asyncio.sleep(2)
            overlapping = await asyncio.gather(*[request(runner_url, 'GET', '/v1/jobs/' + j) for j in (a, b)])
            evidence['checks']['two_running'] = all(j['status'] == 'running' for j in overlapping)
            # Scoped immutable upload while both runs are active.
            digest = hashlib.sha256(b'x').hexdigest()
            upload = await request(provider_url, 'POST', '/v1/sandboxes/' + sid + '/files/uploads', {'path': 'proof/input.txt', 'size_bytes': 1, 'sha256': digest}, 'proof-upload')
            await request(provider_url, 'PATCH', f'/v1/sandboxes/{sid}/files/uploads/' + upload['upload_id'], {'offset': 0, 'data_base64': base64.b64encode(b'x').decode(), 'sha256': digest})
            await request(provider_url, 'POST', f'/v1/sandboxes/{sid}/files/uploads/' + upload['upload_id'] + '/complete', {})
            evidence['checks']['transfer_during_execution'] = True
            await request(runner_url, 'POST', '/v1/jobs/' + a + '/cancel', {})
            stopped = await wait(a, {'cancelled'})
            sibling = await wait(b, {'completed'})
            evidence['checks']['independent_cancel_and_descendant_reap'] = stopped['status'] == 'cancelled' and sibling['result']['stdout'] == 'shared-proof-completed\n'
            c, d = await asyncio.gather(submit(10), submit(10))
            await asyncio.gather(wait(c, {'running'}), wait(d, {'running'}));await asyncio.sleep(2)
            provider_process.kill();provider_process.wait(timeout=10)
            provider_process = launch_provider();await ready(provider_url)
            recovered = await asyncio.gather(wait(c, {'completed'}), wait(d, {'completed'}))
            evidence['checks']['provider_sigkill_journal_recovery_without_replay'] = all(j['attempt_count'] == 1 and j['result']['stdout'] == 'shared-proof-completed\n' for j in recovered)
            e, f = await asyncio.gather(submit(90, 'descendant', timeout=4), submit(12))
            timeout_job, timeout_sibling = await asyncio.gather(wait(e, {'timed_out'}), wait(f, {'completed'}))
            evidence['checks']['independent_deadline_and_descendant_reap'] = timeout_job['status'] == 'timed_out' and timeout_sibling['result']['stdout'] == 'shared-proof-completed\n'
            evidence['jobs'] = [{'job_id': j, **{k: (await request(runner_url, 'GET', '/v1/jobs/' + j))[k] for k in ('sandbox_id', 'run_id', 'status', 'attempt_count')}} for j in jobs]
            evidence['checks']['same_sandbox_retained_running'] = (await request(provider_url, 'GET', '/v1/sandboxes/' + sid))['status'] == 'running'
            evidence['passed'] = all(evidence['checks'].values())
        finally:
            if sid:
                for j in jobs:
                    try:
                        await request(runner_url, 'POST', '/v1/jobs/' + j + '/cancel', {})
                    except Exception:
                        pass
                for _ in range(120):
                    try:
                        box = await request(provider_url, 'GET', '/v1/sandboxes/' + sid)
                        if box['active_run_id'] is None:
                            await request(provider_url, 'POST', '/v1/sandboxes/' + sid + '/destroy', {'confirm': True, 'reason': 'Owned shared execution qualification fixture cleanup.'})
                            evidence['fixture_destroyed'] = True
                            break
                    except Exception:
                        pass
                    await asyncio.sleep(.25)
            for process in reversed(processes):
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=15)
                    except subprocess.TimeoutExpired:
                        process.kill();process.wait(timeout=10)
            for handle in handles:
                handle.close()
            evidence['finished_at'] = datetime.now(timezone.utc).isoformat()
            args.evidence.write_text(json.dumps(evidence, indent=2) + '\n')
            print(json.dumps({'passed': evidence.get('passed', False), 'checks': evidence['checks'], 'fixture_destroyed': evidence.get('fixture_destroyed', False), 'evidence': str(args.evidence), 'private_log_directory': str(state)}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('provider-database-url-file', 'runner-database-url-file', 'key-file', 'evidence'):
        parser.add_argument('--' + name, type=Path, required=True)
    asyncio.run(main(parser.parse_args()))
