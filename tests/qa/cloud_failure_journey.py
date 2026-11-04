#!/usr/bin/env python3
"""Opt-in real Cloud failure qualification against isolated local service processes.

No shared host restart or production database access. Transport faults are
injected by a local HTTP proxy; all admitted workloads execute on BoxLite Cloud.
Required: built Runner dependencies, Provider Python environment, Docker and a
private BoxLite key file. Evidence distinguishes this from GCC deployment proof.
"""
import argparse
import concurrent.futures
import hashlib
import http.server
import json
import os
from pathlib import Path
import secrets
import signal
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[2]
TERMINAL = {'completed', 'failed', 'cancelled', 'timed_out'}


def free_port():
    with socket.socket() as connection:
        connection.bind(('127.0.0.1', 0))
        return connection.getsockname()[1]


def wait_for(read, predicate, seconds=100):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            value = read()
            if predicate(value):
                return value
        except (OSError, urllib.error.URLError):
            pass
        time.sleep(.2)
    raise RuntimeError('qualification_wait_timeout')


class Journey:
    def __init__(self, args):
        self.args = args
        self.session = uuid.uuid4().hex
        self.private = ROOT / 'private' / ('cloud-failures-' + self.session)
        self.private.mkdir(parents=True, mode=0o700)
        self.owner = 'cloud-qa-' + self.session
        self.tokens = {key: secrets.token_urlsafe(32) for key in ('runner', 'provider', 'other')}
        self.ports = {key: free_port() for key in ('runner', 'provider', 'proxy', 'runner_db', 'provider_db')}
        self.boxes, self.containers, self.children, self.logs = [], [], {}, []
        self.checks = []
        self.fault = None
        self.uncertain_creation = False
        self.fault_lock = threading.Lock()
        self.proxy = None

    def request(self, service, method, path, body=None, key=None, expected=(200, 201, 202)):
        headers = {'Authorization': 'Bearer ' + self.tokens[service],
                   'X-Correlation-ID': 'qa_' + self.session}
        if service == 'provider':
            headers['X-Owner-ID'] = self.owner
        if key:
            headers['Idempotency-Key'] = key
        data = None if body is None else json.dumps(body).encode()
        if data is not None:
            headers['Content-Type'] = 'application/json'
        request = urllib.request.Request(f'http://127.0.0.1:{self.ports[service]}' + path,
                                         data=data, headers=headers, method=method)
        try:
            response = urllib.request.urlopen(request, timeout=30)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            value = json.loads(response.read(2 * 1024 * 1024))
            if service == 'provider' and method == 'POST' and path == '/v1/sandboxes' and value.get('sandbox_id'):
                if value['sandbox_id'] not in self.boxes:
                    self.boxes.append(value['sandbox_id'])
            if response.status not in expected:
                raise RuntimeError('unexpected_http_' + str(response.status) + '_' + str(value.get('code')))
            return value

    def start_service(self, name):
        path = ROOT / 'services' / name
        env = self.environments[name]
        log = (self.private / (name + '.jsonl')).open('ab')
        self.logs.append(log)
        cmd = [self.args.python, '-m', 'provider.app'] if name == 'sandbox-provider' else ['node', 'dist/main.js']
        self.children[name] = subprocess.Popen(cmd, cwd=path, env=env, stdout=log, stderr=log,
                                                start_new_session=True)
        role = 'provider' if name == 'sandbox-provider' else 'runner'
        wait_for(lambda: self.request(role, 'GET', '/health/ready'),
                 lambda value: value.get('status') == 'ok', 60)

    def crash(self, name):
        process = self.children[name]
        os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=10)
        self.start_service(name)

    def setup(self):
        profiles = json.loads((ROOT / 'deploy/profiles.cloud.staging.json').read_text())
        fixture = {
            'sandbox_profiles': ['cloud-minimal-linux:v1'], 'working_directory': '/',
            'max_duration_seconds': 45, 'max_output_bytes': 4096, 'environment': {},
            'arguments_schema': {'type': 'object', 'properties': {}, 'additionalProperties': False},
            'argv': ['/usr/local/bin/python3', '-c',
                     'import pathlib,time; p=pathlib.Path("/opt/workflow-fixture/count.txt"); '
                     'p.parent.mkdir(parents=True,exist_ok=True); '
                     'n=int(p.read_text())+1 if p.exists() else 1; '
                     'p.write_text(str(n)); time.sleep(6); print(str(n))']}
        profiles['workloads']['fixture-count-effect:v1'] = fixture
        # Refuse accidental execution with a profile that changes its image or policy.
        profile = profiles['sandboxes']['cloud-minimal-linux:v1']
        assert profile['network'] == 'denied' and profile['memory_mib'] == 1024
        assert '@sha256:' in profile['image']
        permissions = ['sandbox:read', 'sandbox:create', 'sandbox:start', 'sandbox:stop',
                       'sandbox:execute', 'sandbox:cancel', 'sandbox:destroy',
                       'sandbox:file:read', 'sandbox:file:write',
                       'job:submit', 'job:read', 'job:cancel', 'schedule:write']
        policy = {'actor_id': 'cloud-qualification', 'owner_id': self.owner,
                  'permissions': permissions, 'sandbox_profiles': list(profiles['sandboxes']),
                  'workload_profiles': list(profiles['workloads']), 'allow_resume': True}
        self.environments = {}
        for service, role in (('job-runner', 'runner'), ('sandbox-provider', 'provider')):
            name = 'workflow-cloud-qa-' + role + '-' + self.session[:10]
            password = secrets.token_urlsafe(32)
            env = dict(os.environ, POSTGRES_PASSWORD=password)
            subprocess.run(['docker', 'run', '-d', '--name', name, '--label', 'workflow-agents.qa=' + self.session,
                            '--memory=256m', '--cpus=.5', '-p', f'127.0.0.1:{self.ports[role+"_db"]}:5432',
                            '-e', 'POSTGRES_PASSWORD', 'postgres:16-alpine'],
                           env=env, check=True, stdout=subprocess.DEVNULL)
            self.containers.append(name)
            wait_for(lambda: subprocess.run(['docker', 'exec', name, 'pg_isready', '-U', 'postgres'],
                                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode,
                     lambda value: value == 0, 30)
            database_url = f'postgresql://postgres:{password}@127.0.0.1:{self.ports[role+"_db"]}/postgres'
            env = dict(os.environ, DATABASE_URL=database_url, HOST='127.0.0.1', PORT=str(self.ports[role]))
            if role == 'provider':
                env.update(PROVIDER_AUTH_JSON=json.dumps([{**policy, 'token': self.tokens[role],
                           'delegate_owners': [self.owner]}]), PROVIDER_PROFILES_JSON=json.dumps(profiles),
                           SANDBOX_RUNTIME_MODE='cloud', BOXLITE_REST_URL='https://api.boxlite.ai',
                           BOXLITE_API_KEY=Path(self.args.key_file).read_text().strip(),
                           BOXLITE_ACCOUNT_SCOPE='workflow-qa-' + self.session[:16],
                           BOX_ROOT=str(self.private / 'boxlite'), RUN_POLL_SECONDS='.1')
            else:
                env.update(RUNNER_AUTH_JSON=json.dumps([{**policy, 'token': self.tokens[role]}]),
                           RUNNER_PROFILES_JSON=json.dumps(profiles),
                           SANDBOX_PROVIDER_URL=f'http://127.0.0.1:{self.ports["proxy"]}',
                           SANDBOX_PROVIDER_TOKEN=self.tokens['provider'], PROVIDER_TIMEOUT_MS='2000',
                           POLL_INTERVAL_MS='200', RETRY_BACKOFF_SECONDS='1',
                           QUEUE_CONCURRENCY='2', MAX_GLOBAL_CONCURRENCY='2', MAX_OWNER_CONCURRENCY='2')
            self.environments[service] = env
        (self.private / 'recovery.json').write_text(json.dumps({
            'session': self.session, 'owner': self.owner, 'tokens': self.tokens,
            'ports': self.ports, 'containers': self.containers,
            'database_urls': {name: env['DATABASE_URL'] for name, env in self.environments.items()}}))
        (self.private / 'recovery.json').chmod(0o600)
        self.start_service('sandbox-provider')
        journey = self

        class Proxy(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_GET(self):
                self.forward()

            def do_POST(self):
                self.forward()

            def forward(self):
                fault = None
                if self.command == 'POST' and self.path.endswith('/execute'):
                    with journey.fault_lock:
                        fault, journey.fault = journey.fault, None
                body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
                if fault in ('before', 'before_timeout'):
                    if fault == 'before_timeout':
                        time.sleep(5)
                    result = json.dumps({'code': 'injected_transient', 'message': 'Controlled transport failure',
                                         'retryable': True, 'correlation_id': 'qa_' + journey.session}).encode()
                    status = 503
                else:
                    request = urllib.request.Request(f'http://127.0.0.1:{journey.ports["provider"]}' + self.path,
                                                     method=self.command, data=body if self.command == 'POST' else None,
                                                     headers={k: v for k, v in self.headers.items()
                                                              if k.lower() not in ('host', 'content-length')})
                    try:
                        response = urllib.request.urlopen(request, timeout=35)
                    except urllib.error.HTTPError as error:
                        response = error
                    except urllib.error.URLError:
                        response = None
                    if response is None:
                        status, result = 503, json.dumps({'code': 'dependency_unavailable',
                            'message': 'Controlled service outage', 'retryable': True,
                            'correlation_id': 'qa_' + journey.session}).encode()
                    else:
                        with response:
                            status, result = response.status, response.read(2 * 1024 * 1024)
                    if fault == 'after':
                        time.sleep(5)
                try:
                    self.send_response(status)
                    self.send_header('Content-Type', 'application/json')
                    self.send_header('Content-Length', str(len(result)))
                    self.end_headers()
                    self.wfile.write(result)
                except (BrokenPipeError, ConnectionResetError):
                    pass

        self.proxy = http.server.ThreadingHTTPServer(('127.0.0.1', self.ports['proxy']), Proxy)
        threading.Thread(target=self.proxy.serve_forever, daemon=True).start()
        self.start_service('job-runner')

    def box(self, scenario):
        self.uncertain_creation = True
        box = self.request('provider', 'POST', '/v1/sandboxes', {
            'owner_ref': self.owner + ':' + scenario, 'profile': 'cloud-minimal-linux:v1', 'persistent': True},
            key=self.session + ':' + scenario)
        self.uncertain_creation = False
        return wait_for(lambda: self.request('provider', 'GET', '/v1/sandboxes/' + box['sandbox_id']),
                        lambda value: value['status'] == 'running', 150)['sandbox_id']

    def job(self, sid, key, workload='fixture-count-effect:v1', arguments=None):
        return self.request('runner', 'POST', '/v1/jobs', {
            'client_reference': self.owner + ':' + key,
            'sandbox': {'mode': 'reuse', 'sandbox_id': sid},
            'workload': {'profile': workload, 'arguments': arguments or {}},
            'limits': {'max_duration_seconds': 40, 'max_attempts': 2, 'retry_backoff_seconds': 1}}, key=key)

    def state(self, jid):
        return self.request('runner', 'GET', '/v1/jobs/' + jid)

    def finish(self, jid):
        return wait_for(lambda: self.state(jid), lambda value: value['status'] in TERMINAL, 90)

    def events(self, service, sid):
        route = ('/v1/jobs/' if service == 'runner' else '/v1/sandboxes/') + sid + '/events'
        events, cursor = [], None
        for _ in range(30):
            page = self.request(service, 'GET', route + ('?cursor=' + cursor if cursor else ''))
            events.extend(page['events'])
            cursor = page.get('next_cursor')
            if not cursor:
                return events
        raise RuntimeError('audit_pagination_bound')

    def run(self):
        for scenario in ('duplicate', 'transient_before_effect', 'timeout_before_effect', 'timeout_after_effect', 'worker_crash',
                         'provider_crash', 'cancellation_race'):
            sid = self.box(scenario)
            try:
                self.fault = 'before' if scenario == 'transient_before_effect' else (
                    'before_timeout' if scenario == 'timeout_before_effect' else (
                    'after' if scenario in ('timeout_after_effect', 'cancellation_race') else None)
                )
                key = scenario + ':' + self.session
                if scenario == 'duplicate':
                    with concurrent.futures.ThreadPoolExecutor(4) as executor:
                        jobs = list(executor.map(lambda _: self.job(sid, key), range(4)))
                    assert len({job['job_id'] for job in jobs}) == 1
                    job = jobs[0]
                else:
                    job = self.job(sid, key)
                jid = job['job_id']
                if scenario in ('worker_crash', 'provider_crash', 'cancellation_race'):
                    wait_for(lambda: self.events('provider', sid),
                             lambda values: any(event['type'] == 'run.started' for event in values), 60)
                    time.sleep(1)
                    if scenario == 'cancellation_race':
                        self.request('runner', 'POST', '/v1/jobs/' + jid + '/cancel', {})
                    else:
                        self.crash('job-runner' if scenario == 'worker_crash' else 'sandbox-provider')
                final = self.finish(jid)
                expected = 'failed' if scenario == 'provider_crash' else (
                    'cancelled' if scenario == 'cancellation_race' else 'completed')
                assert final['status'] == expected, (scenario, final['status'], final.get('error'))
                if scenario == 'provider_crash':
                    assert final['error']['code'] == 'ambiguous_execution'
                events = self.events('provider', sid)
                admitted = [event for event in events if event['type'] == 'run.queued']
                assert len(admitted) == 1, 'uncertain_side_effect_was_replayed'
                assert final['attempt_count'] == 1, 'transport_retry_created_new_attempt'
                # Read durable effect independently after restarting the same environment.
                read = self.job(sid, key + ':verify', 'fixture-read-file:v1', {'file': 'count.txt'})
                observed = self.finish(read['job_id'])
                assert observed['status'] == 'completed' and observed['result']['stdout'] == '1'
                runner_events = self.events('runner', jid)
                assert runner_events and all(event['owner_id'] == self.owner for event in runner_events)
                self.checks.append({'scenario': scenario, 'outcome': 'passed', 'job_id': jid,
                                    'sandbox_id': sid, 'status': final['status'], 'attempt_count': 1,
                                    'admitted_runs': 1, 'durable_effect_count': 1,
                                    'runner_audit_events': len(runner_events),
                                    'provider_audit_events': len(events)})
                print(json.dumps(self.checks[-1]), flush=True)
            finally:
                self.destroy(sid)

    def destroy(self, sid):
        box = self.request('provider', 'GET', '/v1/sandboxes/' + sid)
        if box['status'] == 'destroyed':
            return
        self.request('provider', 'POST', '/v1/sandboxes/' + sid + '/stop', {})
        self.request('provider', 'POST', '/v1/sandboxes/' + sid + '/destroy',
                     {'confirm': True, 'reason': 'Explicit exact qualification fixture cleanup'})
        wait_for(lambda: self.request('provider', 'GET', '/v1/sandboxes/' + sid),
                 lambda value: value['status'] == 'destroyed', 90)

    def close(self):
        cleanup_errors = []
        for sid in self.boxes:
            try:
                self.destroy(sid)
            except Exception:
                cleanup_errors.append(sid)
        for process in self.children.values():
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
        if self.proxy:
            self.proxy.shutdown()
        for log in self.logs:
            log.close()
        # Preserve registry evidence if a guest could not be cleaned up.
        if self.uncertain_creation:
            cleanup_errors.append('uncertain_creation_requires_registry_reconciliation')
        if not cleanup_errors:
            for name in self.containers:
                subprocess.run(['docker', 'rm', '-f', name], stdout=subprocess.DEVNULL, check=True)
        return cleanup_errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--key-file', required=True)
    parser.add_argument('--python', required=True)
    parser.add_argument('--evidence', required=True)
    args = parser.parse_args()
    journey = Journey(args)
    outcome, error = 'passed', None
    try:
        journey.setup()
        journey.run()
    except Exception as failure:
        outcome, error = 'failed', type(failure).__name__
        # Private trace may contain database addresses; never print it.
        import traceback
        (journey.private / 'failure.txt').write_text(traceback.format_exc())
    finally:
        cleanup_errors = journey.close()
    evidence = {'version': 1, 'session': journey.session, 'outcome': outcome,
                'error_classification': error, 'checks': journey.checks,
                'cleanup_pending_sandboxes': cleanup_errors,
                'runtime': 'real BoxLite Cloud', 'databases': 'isolated real PostgreSQL 16',
                'services': 'local real processes from current source; not GCC deployment proof',
                'faults': 'controlled local HTTP proxy and SIGKILL of owned service processes',
                'host_reboot': 'not performed'}
    Path(args.evidence).write_text(json.dumps(evidence, indent=2) + '\n')
    print(json.dumps(evidence))
    return 0 if outcome == 'passed' and not cleanup_errors else 1


if __name__ == '__main__':
    raise SystemExit(main())
