#!/usr/bin/env python3
"""Independent consumer of the published v1 APIs; no service source imports.

Set QA_RUNNER_URL, QA_PROVIDER_URL and optional QA_{RUNNER,PROVIDER}_TOKEN.
QA_PROVIDER_OWNER supplies X-Owner-ID only for a configured delegate credential.
Without --exercise only health/auth checks run. --exercise submits disposable
fixture workloads, explicitly stops/restarts and destroys its own test boxes.
Runtime evidence is labelled by QA_RUNTIME_KIND (boxlite|mock|unavailable).
"""
import argparse
import copy
import importlib.util
import json
import os
from pathlib import Path
import sys
import time
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('contract_response', ROOT / 'contracts/assert_response.py')
contract = importlib.util.module_from_spec(spec)
spec.loader.exec_module(contract)
TERMINAL = {'completed', 'failed', 'cancelled', 'timed_out'}


class Probe:
    def __init__(self):
        self.trace = 'qa_' + uuid.uuid4().hex
        self.urls = {s: os.environ['QA_' + s.upper() + '_URL'].rstrip('/') for s in ('runner', 'provider')}
        self.tokens = {s: os.getenv('QA_' + s.upper() + '_TOKEN', '') for s in self.urls}
        self.owner = os.getenv('QA_PROVIDER_OWNER')
        self.results = []
        self.kind = os.getenv('QA_RUNTIME_KIND', 'unavailable')

    def record(self, name, **detail):
        self.results.append({'check': name, 'outcome': 'pass', **detail})

    def request(self, service, method, path, body=None, expected=200, key=None, anonymous=False, token=None):
        headers = {'X-Correlation-ID': self.trace}
        credential = self.tokens[service] if token is None else token
        if credential and not anonymous:
            headers['Authorization'] = 'Bearer ' + credential
        if service == 'provider' and self.owner and not anonymous:
            headers['X-Owner-ID'] = self.owner
        if key:
            headers['Idempotency-Key'] = key
        data = None if body is None else json.dumps(body).encode()
        if data is not None:
            headers['Content-Type'] = 'application/json'
        request = urllib.request.Request(self.urls[service] + path, data=data, method=method, headers=headers)
        try:
            response = urllib.request.urlopen(request, timeout=30)
        except urllib.error.HTTPError as error:
            response = error
        raw = response.read(131073)
        assert len(raw) <= 131072, 'Response exceeds independent probe bound'
        payload = json.loads(raw)
        assert response.status == expected, f'{service} {method} {path}: expected {expected}, got {response.status}, code={payload.get("code")}'
        contract.assert_response(service, method, path.split('?')[0], response.status, payload)
        assert response.headers.get('X-Correlation-ID') == self.trace, 'Correlation header missing or changed'
        return payload

    def poll(self, service, path, field='status', states=TERMINAL, limit=45):
        end = time.monotonic() + limit
        while time.monotonic() < end:
            resource = self.request(service, 'GET', path)
            if resource[field] in states:
                return resource
            time.sleep(.15)
        raise AssertionError(f'{service} resource did not reach expected state: {path}')

    def health_and_auth(self):
        for service in self.urls:
            live = self.request(service, 'GET', '/health/live', anonymous=True)
            assert live['status'] == 'ok'
            self.record(service + '.liveness_contract')
            target = '/v1/jobs/qa_missing' if service == 'runner' else '/v1/sandboxes/qa_missing'
            self.request(service, 'GET', target, anonymous=True, expected=401)
            self.request(service, 'GET', target, token='qa-invalid-token-with-sufficient-length', expected=401)
            self.record(service + '.authentication_negative')

    def fixture(self):
        assert all(self.tokens.values()), 'Authenticated fixture needs both QA tokens'
        unique = uuid.uuid4().hex
        marker = 'hello-world-' + unique
        args = {'file': 'hello-world.txt', 'text': marker}
        body = {'client_reference': 'independent-qa:' + unique,
                'workload': {'profile': 'fixture-write-file:v1', 'arguments': args},
                'sandbox': {'mode': 'ensure', 'owner_ref': 'independent-qa:' + unique,
                            'profile': 'minimal-linux:v1', 'persistent': True},
                'limits': {'max_duration_seconds': 30, 'max_attempts': 2}}
        key = 'qa_submit_' + unique
        job = self.request('runner', 'POST', '/v1/jobs', body, 202, key)
        replay = self.request('runner', 'POST', '/v1/jobs', body, 202, key)
        assert replay['job_id'] == job['job_id']
        changed = copy.deepcopy(body)
        changed['workload']['arguments']['text'] += '-changed'
        self.request('runner', 'POST', '/v1/jobs', changed, 409, key)
        self.record('runner.idempotent_submission_and_conflict')
        job = self.poll('runner', '/v1/jobs/' + job['job_id'])
        if job['status'] != 'completed':
            raise AssertionError(f'Fixture job {job["status"]}, safe error code={(job.get("error") or {}).get("code")}; runtime_kind={self.kind}')
        assert job['result']['exit_code'] == 0
        box = job['sandbox_id']
        assert box
        self.record('cross_service.write', runtime_kind=self.kind)
        events = self.request('runner', 'GET', '/v1/jobs/' + job['job_id'] + '/events')
        types = {e['type'] for e in events['events']}
        assert {'job.submitted', 'job.dispatched', 'job.completed'} <= types
        assert all(e['actor_id'] and e['owner_id'] and e['occurred_at'] for e in events['events'])
        self.record('runner.durable_events')
        self.request('provider', 'POST', f'/v1/sandboxes/{box}/stop', {})
        box_state = self.request('provider', 'GET', f'/v1/sandboxes/{box}')
        assert box_state['status'] == 'stopped'
        self.request('provider', 'POST', f'/v1/sandboxes/{box}/start', {})
        resume = {'workload': {'profile': 'fixture-read-file:v1', 'arguments': {'file': args['file']}},
                  'limits': body['limits']}
        read_job = self.request('runner', 'POST', f'/v1/jobs/{job["job_id"]}/resume', resume, 202, 'qa_resume_' + unique)
        assert read_job['job_id'] != job['job_id']
        read_job = self.poll('runner', '/v1/jobs/' + read_job['job_id'])
        assert read_job['status'] == 'completed' and read_job['sandbox_id'] == box
        assert read_job['result']['stdout'] == marker
        self.record('cross_service.stop_start_same_box_file', runtime_kind=self.kind)
        provider_events = self.request('provider', 'GET', f'/v1/sandboxes/{box}/events')
        assert all(e['actor_id'] and e['owner_id'] for e in provider_events['events'])
        assert {'sandbox.created', 'sandbox.stopped'} <= {e['type'] for e in provider_events['events']}
        self.record('provider.durable_events')
        self.request('provider', 'POST', f'/v1/sandboxes/{box}/destroy', {'confirm': True, 'reason': 'Independent disposable QA fixture cleanup'})
        assert self.request('provider', 'GET', f'/v1/sandboxes/{box}')['status'] == 'destroyed'
        self.record('provider.explicit_destruction', runtime_kind=self.kind)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--exercise', action='store_true')
    options = p.parse_args()
    probe = Probe()
    error = None
    try:
        probe.health_and_auth()
        if options.exercise:
            probe.fixture()
    except Exception as exc:
        error = str(exc)
    print(json.dumps({'runtime_kind': probe.kind, 'correlation_id': probe.trace,
                      'executed_checks': probe.results, 'error': error}, indent=2))
    return 1 if error else 0


if __name__ == '__main__':
    sys.exit(main())
