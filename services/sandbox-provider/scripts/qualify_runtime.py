"""Operator-only real-runtime qualification; never a production runtime fallback.

Each explicit session has an isolated SDK home inside the persistent volume.
No Provider PostgreSQL/API state is touched. Only this session's newly created
box names may be stopped or removed. CLI replay is safe for repeated cron runs.
"""
import argparse
import asyncio
import fcntl
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import re
import tempfile
import time
import traceback
from urllib.parse import quote, unquote, urlsplit

from provider.config import Settings, canonical
from provider.runtime import BoxLiteRuntime


FORMAT = 'workflow-agents-runtime-qualification-v1'
SCOPE = 'Direct runtime adapter in isolated SDK home; excludes service API/DB recovery and host restart.'
PROFILES = ('minimal-linux:v1', 'fixture-write-file:v1', 'fixture-read-file:v1')


class QualificationError(Exception):
    pass


def require(condition, code):
    if not condition:
        raise QualificationError(code)


def safe_error(exc):
    if isinstance(exc, QualificationError):
        return str(exc)
    if isinstance(exc, TimeoutError):
        return 'qualification_timeout'
    if isinstance(exc, PermissionError):
        return 'permission_denied'
    if getattr(exc, 'code', None) == 'runtime_unavailable':
        return 'runtime_unavailable'
    # Native errors can contain paths/registry details; emit only classifications.
    message = str(exc).lower()
    for fragments, classification in (
        (('operation not permitted',), 'operation_not_permitted'),
        (('permission denied',), 'permission_denied'),
        (('namespace',), 'namespace_operation_failed'),
        (('seccomp',), 'seccomp_operation_failed'),
        (('unsupported', 'kvm'), 'unsupported_kvm'),
        (('image', 'manifest', 'registry'), 'image_operation_failed'),
    ):
        if any(fragment in message for fragment in fragments):
            return classification
    return 'runtime_operation_failed'


def diagnostics():
    status = {}
    for line in Path('/proc/self/status').read_text().splitlines():
        key, _, value = line.partition(':')
        if key in {'NoNewPrivs', 'CapEff', 'Seccomp'}:
            status[key] = value.strip()
    return {'uid': os.getuid(), 'groups': os.getgroups(), 'kvm_access': os.access('/dev/kvm', os.R_OK | os.W_OK),
            'sdk_version': importlib.metadata.version('boxlite'), 'process_id': os.getpid(),
            'container_identity_sha256': hashlib.sha256(os.uname().nodename.encode()).hexdigest(),
            'process_security': status}


class Qualification:
    def __init__(self, settings, session, runtime_factory=BoxLiteRuntime, diagnostics_enabled=False):
        require(bool(re.fullmatch('[a-f0-9]{32}', session)), 'invalid_session')
        self.settings, self.session, self.runtime_factory = settings, session, runtime_factory
        self.diagnostics_enabled = diagnostics_enabled
        self.sensitive_values = [p['token'] for p in settings.auth] + [settings.database_url, settings.boxlite_api_key]
        password = urlsplit(settings.database_url).password
        if password:
            self.sensitive_values.extend((password, unquote(password)))
        for profile in settings.profiles['workloads'].values():
            self.sensitive_values.extend(str(value) for value in profile.get('environment', {}).values() if value)
        self.anchor = settings.box_root.resolve().parent / '.runtime-qualification'
        require(not self.anchor.is_symlink(), 'unsafe_session_directory')
        self.anchor.mkdir(mode=0o700, exist_ok=True)
        self.directory = self.anchor / session
        require(not self.directory.is_symlink(), 'unsafe_session_directory')
        self.directory.mkdir(mode=0o700, exist_ok=True)
        self.home = self.directory / 'boxlite'
        require(not self.home.is_symlink(), 'unsafe_runtime_home')
        require(self.home.resolve() != settings.box_root.resolve(), 'production_runtime_home_forbidden')
        self.path = self.directory / 'state.json'
        require(not self.path.is_symlink(), 'unsafe_state_file')
        self.runtime, self.stage, self.checks = None, 'configuration', []
        required = {'sandbox:' + p for p in ('read', 'create', 'start', 'stop', 'execute', 'destroy')}
        policy = next((p for p in settings.auth if required <= set(p['permissions'])
                       and PROFILES[0] in p['sandbox_profiles']
                       and set(PROFILES[1:]) <= set(p['workload_profiles'])), None)
        require(policy is not None, 'qualification_operator_policy_missing')
        delegated = policy.get('delegate_owners', [None])[0]
        self.identity = settings.authenticate('Bearer ' + policy['token'], delegated)
        self.profile = settings.sandbox_profile(self.identity, PROFILES[0])
        self.fingerprint = hashlib.sha256(canonical(settings.profiles).encode()).hexdigest()
        if self.path.exists():
            require(self.path.stat().st_size <= 65536, 'invalid_session_state')
            self.state = json.loads(self.path.read_text())
            expected = {'a': self.name('a'), 'b': self.name('b')}
            require(self.state.get('format') == FORMAT and self.state.get('session') == session
                    and self.state.get('names') == expected and self.state.get('profiles_sha256') == self.fingerprint,
                    'session_identity_mismatch')
        else:
            self.state = {'format': FORMAT, 'session': session, 'profiles_sha256': self.fingerprint,
                          'names': {'a': self.name('a'), 'b': self.name('b')}, 'owned': {},
                          'marker': 'qualification-' + session, 'phase': 'new', 'reports': {}}
        self.sensitive_values.extend((self.state['marker'], 'qualification.txt'))

    def name(self, label):
        return 'phase1-qualification-' + self.session + '-' + label

    def save(self):
        with tempfile.NamedTemporaryFile(mode='w', dir=self.directory, delete=False) as handle:
            json.dump(self.state, handle, separators=(',', ':'))
            handle.flush()
            os.fsync(handle.fileno())
            temporary = handle.name
        os.replace(temporary, self.path)

    def redact_diagnostic(self, value):
        variants = set()
        for secret in self.sensitive_values:
            if secret:
                variants.update((secret, json.dumps(secret)[1:-1], quote(secret, safe='')))
        for secret in sorted(variants, key=len, reverse=True):
            value = value.replace(secret, '[REDACTED]')
        value = re.sub(r'(?i)(https?://)[^/\s@]+@', r'\1[REDACTED]@', value)
        value = re.sub(r'(?i)(bearer\s+)[A-Za-z0-9._~+/=-]+', r'\1[REDACTED]', value)
        value = re.sub(r'(?i)((?:token|password|secret|signature|api_key)=)[^\s&]+', r'\1[REDACTED]', value)
        return re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]', '?', value)

    def capture_diagnostic(self, exc, phase):
        """Explicit operator mode only; full redacted cause stays private."""
        chain, seen, current = [], set(), exc
        while current is not None and id(current) not in seen and len(chain) < 5:
            seen.add(id(current))
            typename = type(current).__module__ + '.' + type(current).__name__
            if not re.fullmatch(r'[A-Za-z0-9_.]{1,128}', typename):
                typename = 'unknown_exception'
            item = {'type': typename, 'message': self.redact_diagnostic(str(current))[:4096]}
            if isinstance(getattr(current, 'errno', None), int):
                item['errno'] = current.errno
            chain.append(item)
            current = current.__cause__ or current.__context__
        private = {'probe': FORMAT, 'session': self.session, 'stage': self.stage, 'phase': phase,
                   'exception_chain': chain,
                   'traceback': self.redact_diagnostic(''.join(traceback.format_exception(exc)))[:65536]}
        name = 'diagnostic-' + phase + '.json'
        target = self.directory / name
        require(not target.is_symlink(), 'unsafe_diagnostic_file')
        with tempfile.NamedTemporaryFile(mode='w', dir=self.directory, delete=False) as handle:
            json.dump(private, handle, separators=(',', ':'))
            handle.flush()
            os.fsync(handle.fileno())
            temporary = handle.name
        os.replace(temporary, target)
        return {'file': name, 'exception_chain': [item | {'message': item['message'][:1024]} for item in chain]}

    async def open(self):
        if self.runtime is None:
            self.runtime = self.runtime_factory(self.home)
            require(await self.runtime.ready(), 'runtime_not_ready')

    async def close(self):
        if self.runtime is not None:
            await self.runtime.close()
            self.runtime = None

    async def create(self, label):
        self.stage = 'create_' + label
        name = self.name(label)
        require(label not in self.state['owned'], 'incomplete_session_requires_cleanup')
        require(await self.runtime.inspect(name) is None, 'preexisting_box_refused')
        # Persist creation authority only after proving this isolated name absent.
        self.state['owned'][label] = {'runtime_id': None, 'removed': False}
        self.save()
        found = await self.runtime.ensure(name, self.profile)
        require(found is not None and found.running, 'box_not_running')
        self.state['owned'][label]['runtime_id'] = found.runtime_id
        self.save()
        self.checks.append('box_' + label + '_created')

    async def execute(self, label, profile, arguments):
        self.stage = 'execute_' + label
        self.sensitive_values.extend(str(value) for value in arguments.values() if value is not None)
        configured, argv = self.settings.workload(self.identity, profile, PROFILES[0], arguments, 30)
        result = await self.runtime.collect(await self.runtime.execute(self.name(label), argv, configured, 30),
                                            min(self.settings.max_output, configured['max_output_bytes']))
        require(not result['output_truncated'], 'fixture_output_truncated')
        return result

    async def stop(self, label):
        self.stage = 'stop_' + label
        await self.runtime.stop(self.name(label))
        found = await self.runtime.inspect(self.name(label))
        require(found is not None and not found.running, 'non_destructive_stop_failed')
        self.checks.append('box_' + label + '_stopped')

    async def prepare(self):
        require(self.state['phase'] == 'new', 'prepare_requires_new_session')
        await self.open()
        await self.create('a')
        result = await self.execute('a', PROFILES[1], {'file': 'qualification.txt', 'text': self.state['marker']})
        require(result['exit_code'] == 0, 'marker_write_failed')
        self.checks.append('marker_written')
        await self.stop('a')
        await self.close()
        self.state['phase'] = 'prepared'
        self.save()

    async def verify(self):
        require(self.state['phase'] == 'prepared', 'verify_requires_prepared_session')
        await self.open()
        before = await self.runtime.inspect(self.name('a'))
        require(before is not None, 'retained_box_missing')
        require(before.runtime_id == self.state['owned']['a']['runtime_id'], 'runtime_identity_changed')
        require(not before.running, 'prepared_box_not_stopped')
        await self.runtime.start(self.name('a'))
        result = await self.execute('a', PROFILES[2], {'file': 'qualification.txt'})
        require(result['exit_code'] == 0 and result['stdout'] == self.state['marker'], 'retained_marker_mismatch')
        self.checks.extend(['same_runtime_identity', 'marker_retained_after_adapter_reopen'])
        await self.create('b')
        result = await self.execute('b', PROFILES[2], {'file': 'qualification.txt'})
        require(result['exit_code'] != 0, 'two_box_isolation_failed')
        self.checks.append('box_b_cannot_read_box_a_marker')
        await self.stop('b')
        result = await self.execute('a', PROFILES[2], {'file': 'qualification.txt'})
        require(result['exit_code'] == 0 and result['stdout'] == self.state['marker'], 'box_a_marker_changed')
        await self.stop('a')
        await self.close()
        self.state['phase'] = 'verified'
        self.save()

    async def cleanup(self):
        self.stage = 'explicit_cleanup'
        require(self.path.exists(), 'session_state_missing')
        await self.open()
        for label, owned in self.state['owned'].items():
            require(label in {'a', 'b'}, 'invalid_owned_box')
            name = self.name(label)
            found = await self.runtime.inspect(name)
            if found is not None:
                require(not owned['removed'], 'removed_name_reappeared')
                require(owned['runtime_id'] is None or found.runtime_id == owned['runtime_id'],
                        'cleanup_runtime_identity_mismatch')
                await self.runtime.stop(name)
                await self.runtime.destroy(name)
                require(await self.runtime.inspect(name) is None, 'explicit_destroy_failed')
            owned['removed'] = True
            self.save()
        await self.close()
        self.state['phase'] = 'cleaned'
        self.save()
        self.checks.append('explicit_destroy_verified')

    async def run(self, mode):
        if mode in self.state['reports'] and self.state['reports'][mode]['outcome'] == 'passed':
            return self.state['reports'][mode] | {'replayed': True}
        started = time.monotonic()
        report = {'probe': FORMAT, 'session': self.session, 'mode': mode, 'scope': SCOPE,
                  'runtime_kind': 'boxlite', 'outcome': 'failed', 'checks': self.checks}
        try:
            async with asyncio.timeout(300):
                self.stage = 'preflight'
                await self.open()
                report['runtime_kind'] = self.runtime.kind
                if mode == 'lifecycle':
                    await self.prepare()
                    await self.verify()
                    await self.cleanup()
                else:
                    await getattr(self, mode)()
                report['outcome'] = 'passed'
        except Exception as exc:
            report.update(outcome='blocked' if safe_error(exc) == 'runtime_not_ready' else 'failed',
                          error_classification=safe_error(exc), failed_stage=self.stage)
            if self.diagnostics_enabled:
                try:
                    report['operator_diagnostic'] = self.capture_diagnostic(exc, mode)
                except Exception:
                    report['diagnostic_capture_error'] = 'private_capture_failed'
            if mode == 'lifecycle' and self.state['owned']:
                try:
                    async with asyncio.timeout(45):
                        await self.cleanup()
                except Exception as cleanup_error:
                    report['cleanup_error_classification'] = safe_error(cleanup_error)
        finally:
            try:
                await self.close()
            except Exception as close_error:
                report.update(outcome='failed', close_error_classification=safe_error(close_error))
        report['duration_ms'] = round((time.monotonic() - started) * 1000)
        report['marker_sha256'] = hashlib.sha256(self.state['marker'].encode()).hexdigest()
        report['runtime_identity_sha256'] = {k: hashlib.sha256(v['runtime_id'].encode()).hexdigest()
                                             for k, v in self.state['owned'].items() if v['runtime_id']}
        report['retained_boxes'] = [self.name(k) for k, v in self.state['owned'].items() if not v['removed']]
        self.state['reports'][mode] = report
        self.save()
        return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode', choices=('lifecycle', 'prepare', 'verify', 'cleanup'), default='lifecycle')
    parser.add_argument('--session', required=True, help='Explicit lowercase UUID hex; reuse on cron replay.')
    parser.add_argument('--diagnostics', action='store_true',
                        help='Operator-only redacted exception chain plus private mode600 traceback.')
    args = parser.parse_args()
    report = {'probe': FORMAT, 'mode': args.mode, 'outcome': 'failed', 'scope': SCOPE}
    try:
        report['host'] = diagnostics()
        settings = Settings.from_env()
        qualification = Qualification(settings, args.session, diagnostics_enabled=args.diagnostics)
        lock_path = qualification.anchor / '.lock'
        with os.fdopen(os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600), 'r+') as lock:
            # A global volume-local lock also serializes distinct qualification sessions.
            until = time.monotonic() + 330
            while True:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    require(time.monotonic() < until, 'qualification_busy')
                    time.sleep(.25)
            # Another cron process may have completed while this invocation waited.
            qualification = Qualification(settings, args.session, diagnostics_enabled=args.diagnostics)
            report.update(asyncio.run(qualification.run(args.mode)))
    except Exception as exc:
        report['error_classification'] = safe_error(exc)
    print(json.dumps(report, separators=(',', ':')))
    return 0 if report['outcome'] == 'passed' else 2 if report['outcome'] == 'blocked' else 1


if __name__ == '__main__':
    raise SystemExit(main())
