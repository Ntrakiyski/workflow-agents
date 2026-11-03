"""Offline verifier guard tests; subprocesses and Docker are never started."""
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location(
    'verify_offhost_restore', Path(__file__).resolve().parents[1] / 'verify-offhost-restore.py')
VERIFIER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VERIFIER)


def manifest():
    return {'outcome': 'passed', 'source_origin': 'https://hosting.gccssofia.com',
            'session': 'offline-review', 'archives': [
                {'service': 'job-runner', 'application_uuid': 'a' * 24,
                 'deployed_commit': 'a' * 40, 'sha256': hashlib.sha256(b'{}').hexdigest()},
                {'service': 'sandbox-provider', 'application_uuid': 'b' * 24,
                 'deployed_commit': 'b' * 40, 'sha256': hashlib.sha256(b'{}').hexdigest()},
            ]}


class VerifierGuards(unittest.TestCase):
    def invoke(self, source, command, subprocess_run):
        with tempfile.TemporaryDirectory(prefix='workflow-forensic-guards-') as name:
            root = Path(name)
            (root / 'manifest.json').write_text(json.dumps(source))
            (root / 'credentials.json').write_text(json.dumps({
                'provider_delegate_token': 'local-test-only',
                'provider_operator_token': 'local-test-only'}))
            for service in ('job-runner', 'sandbox-provider'):
                (root / (service + '.encrypted.json')).write_text('{}')
            evidence = root / 'evidence.json'
            argv = ['verify-offhost-restore.py', '--archive', str(root),
                    '--credentials', str(root / 'credentials.json'),
                    '--source-root', str(root / 'source'), '--python', sys.executable,
                    '--evidence', str(evidence), '--infrastructure-only',
                    '--forensic-registry-only']
            with patch.object(sys, 'argv', argv), \
                    patch.object(VERIFIER, 'ROOT', root / 'operator'), \
                    patch.object(VERIFIER, 'command', side_effect=command) as calls, \
                    patch.object(VERIFIER.subprocess, 'run', side_effect=subprocess_run), \
                    contextlib.redirect_stdout(io.StringIO()) as output:
                result = VERIFIER.main()
            return result, json.loads(evidence.read_text()), calls.call_args_list, output.getvalue()

    def test_invalid_missing_duplicate_and_conflicting_identities_fail_before_commands(self):
        cases = [None, [], {}]
        for archives in ([], manifest()['archives'][:1],
                         [dict(manifest()['archives'][0], service='application')],
                         manifest()['archives'] + [manifest()['archives'][0]],
                         [dict(manifest()['archives'][0], service='../job-runner'),
                          manifest()['archives'][1]]):
            value = manifest()
            value['archives'] = archives
            cases.append(value)
        for field, invalid in [('deployed_commit', 'HEAD'), ('deployed_commit', 'a' * 39),
                               ('sha256', None), ('sha256', 'not-a-digest'),
                               ('application_uuid', '../retained-db'),
                               ('source_deployment_uuid', 'bad-deployment')]:
            value = manifest()
            value['archives'][0][field] = invalid
            cases.append(value)
        value = manifest()
        value['archives'][1]['application_uuid'] = value['archives'][0]['application_uuid']
        cases.append(value)
        value = manifest()
        for archive in value['archives']:
            archive['source_deployment_uuid'] = 'c' * 24
        cases.append(value)
        for field, invalid in [('outcome', 'failed'), ('source_origin', 'https://example.com')]:
            value = manifest()
            value[field] = invalid
            cases.append(value)
        for value in cases:
            with self.subTest(manifest=value):
                code, evidence, calls, output = self.invoke(
                    value, lambda *_: self.fail('unexpected command'),
                    lambda *_args, **_kwargs: self.fail('unexpected subprocess'))
                self.assertEqual(code, 1)
                self.assertEqual(evidence['outcome'], 'failed')
                self.assertTrue(evidence['error_classification'].startswith('restore_manifest_'))
                self.assertEqual(calls, [])
                self.assertEqual(evidence['services'], [])
                self.assertNotIn('local-test-only', output)

    def test_stale_envelope_and_oversize_fail_before_commands(self):
        source = manifest()
        source['archives'][1]['sha256'] = '0' * 64
        for limit, value, classification in [
                (VERIFIER.MAX_ENVELOPE_BYTES, source, 'restore_envelope_checksum_mismatch'),
                (1, manifest(), 'restore_envelope_size_limit')]:
            with self.subTest(classification=classification), \
                    patch.object(VERIFIER, 'MAX_ENVELOPE_BYTES', limit):
                code, evidence, calls, output = self.invoke(
                    value, lambda *_: self.fail('unexpected command'),
                    lambda *_args, **_kwargs: self.fail('unexpected subprocess'))
            self.assertEqual(code, 1)
            self.assertEqual(evidence['error_classification'], classification)
            self.assertEqual(calls, [])
            self.assertEqual(evidence['services'], [])
            self.assertNotIn('local-test-only', output)

    def test_applied_runner_tree_mismatch_fails_before_docker(self):
        def command(args, _env, cwd):
            self.assertEqual(args[0], 'git')
            return ('c' if cwd.name == 'source' else 'd') * 40

        code, evidence, calls, _ = self.invoke(
            manifest(), command, lambda *_args, **_kwargs: self.fail('unexpected subprocess'))
        self.assertEqual(code, 1)
        self.assertEqual(evidence['error_classification'], 'restore_applied_migrations_mismatch')
        self.assertTrue(all(call.args[0][0] == 'git' for call in calls))
        self.assertEqual(evidence['services'], [])

    def test_cleanup_attempts_both_owned_volumes_and_failure_overrides_restore_pass(self):
        cleanups, restores = [], []

        def command(args, _env, _cwd):
            if args[0] == 'git':
                return 'c' * 40
            if '--restore' in args:
                restores.append(args)
                return json.dumps({'outcome': 'passed'})
            return ''

        def subprocess_run(args, **_kwargs):
            if args[:2] == ['docker', 'rm']:
                cleanups.append(args)
                return SimpleNamespace(returncode=1 if len(cleanups) == 1 else 0)
            self.assertEqual(args[:2], ['docker', 'exec'])
            return SimpleNamespace(returncode=0)

        code, evidence, _, _ = self.invoke(manifest(), command, subprocess_run)
        self.assertEqual(code, 1)
        self.assertEqual(evidence['outcome'], 'failed')
        self.assertEqual(evidence['error_classification'], 'restore_cleanup_failed')
        self.assertEqual(len(evidence['services']), 2)
        self.assertEqual(len(cleanups), 2)
        self.assertNotEqual(cleanups[0][-1], cleanups[1][-1])
        self.assertTrue(all(args[:4] == ['docker', 'rm', '-f', '-v'] for args in cleanups))
        self.assertEqual([item['outcome'] for item in evidence['cleanup']], ['failed', 'passed'])
        self.assertTrue(all('--allow-retained-runtime-records' not in args for args in restores[:2]))
        self.assertTrue(all('--allow-retained-runtime-records' in args for args in restores[2:]))
        self.assertFalse(evidence['runtime_client_started'])
        self.assertFalse(evidence['operational_provider_cutover_permitted'])


if __name__ == '__main__':
    unittest.main()
