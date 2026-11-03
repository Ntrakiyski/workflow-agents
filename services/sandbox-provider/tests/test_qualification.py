"""Operator cleanup/replay safeguards. Fake runtime; no microVM claims."""
import json
import os
import pytest

from provider.config import Settings
from provider.runtime import RuntimeIdentity
from scripts.qualify_runtime import Qualification, QualificationError
from .conftest import policies, profiles
from .fake_runtime import FakeRuntime


SESSION = 'a' * 32


def configured(tmp_path):
    return Settings('postgresql://qualification-not-connected', policies(), profiles(), tmp_path / 'production-boxlite')


@pytest.mark.asyncio
async def test_lifecycle_replay_creates_and_destroys_only_two_own_boxes(tmp_path):
    settings, runtime = configured(tmp_path), FakeRuntime()
    factory = lambda _: runtime
    result = await Qualification(settings, SESSION, factory).run('lifecycle')
    assert result['outcome'] == 'passed' and result['runtime_kind'] == 'fake-test-only'
    assert 'box_b_cannot_read_box_a_marker' in result['checks']
    assert runtime.creates == runtime.removes == 2 and runtime.boxes == {}
    replay = await Qualification(settings, SESSION, factory).run('lifecycle')
    assert replay['replayed'] and replay['outcome'] == 'passed'
    assert runtime.creates == runtime.removes == 2
    state = next((tmp_path / '.runtime-qualification').glob('*/state.json'))
    assert state.stat().st_mode & 0o777 == 0o600


@pytest.mark.asyncio
async def test_separate_prepare_verify_cleanup_preserve_stopped_marker(tmp_path):
    settings, runtime = configured(tmp_path), FakeRuntime()
    homes = []
    def factory(home):
        homes.append(home)
        return runtime
    prepared = await Qualification(settings, SESSION, factory).run('prepare')
    assert prepared['outcome'] == 'passed' and runtime.creates == 1
    assert all(not box['running'] for box in runtime.boxes.values())
    verified = await Qualification(settings, SESSION, factory).run('verify')
    assert verified['outcome'] == 'passed' and runtime.creates == 2
    assert verified['runtime_identity_sha256']['a'] == prepared['runtime_identity_sha256']['a']
    assert all(not box['running'] for box in runtime.boxes.values())
    assert all(home != settings.box_root for home in homes)
    assert len(set(homes)) == 1
    cleaned = await Qualification(settings, SESSION, factory).run('cleanup')
    assert cleaned['outcome'] == 'passed' and runtime.removes == 2 and runtime.boxes == {}


@pytest.mark.asyncio
async def test_preexisting_box_is_never_adopted_stopped_or_destroyed(tmp_path):
    settings, runtime = configured(tmp_path), FakeRuntime()
    probe = Qualification(settings, SESSION, lambda _: runtime)
    runtime.boxes[probe.name('a')] = {'running': True, 'files': {'unrelated.txt': 'preserve'}}
    result = await probe.run('lifecycle')
    assert result['outcome'] == 'failed' and result['error_classification'] == 'preexisting_box_refused'
    assert runtime.creates == runtime.removes == 0
    assert runtime.boxes[probe.name('a')] == {'running': True, 'files': {'unrelated.txt': 'preserve'}}


@pytest.mark.asyncio
async def test_cleanup_refuses_replaced_runtime_identity(tmp_path):
    settings, runtime = configured(tmp_path), FakeRuntime()
    factory = lambda _: runtime
    assert (await Qualification(settings, SESSION, factory).run('prepare'))['outcome'] == 'passed'
    original = runtime.inspect
    async def replaced(name):
        found = await original(name)
        return RuntimeIdentity('replacement', 'replacement', found.running) if found else None
    runtime.inspect = replaced
    result = await Qualification(settings, SESSION, factory).run('cleanup')
    assert result['outcome'] == 'failed' and result['error_classification'] == 'cleanup_runtime_identity_mismatch'
    assert runtime.removes == 0 and runtime.creates == 1
    # A failed cleanup is retryable after the operator resolves its blocker.
    runtime.inspect = original
    result = await Qualification(settings, SESSION, factory).run('cleanup')
    assert result['outcome'] == 'passed' and runtime.removes == 1


def test_invalid_session_and_symlink_refused(tmp_path):
    settings = configured(tmp_path)
    with pytest.raises(QualificationError, match='invalid_session'):
        Qualification(settings, '../production-boxlite')
    (tmp_path / '.runtime-qualification').symlink_to(tmp_path / 'production-boxlite')
    with pytest.raises(QualificationError, match='unsafe_session_directory'):
        Qualification(settings, SESSION)


@pytest.mark.asyncio
async def test_failure_is_redacted_and_disposable_box_is_cleaned(tmp_path):
    settings, runtime = configured(tmp_path), FakeRuntime()
    runtime.execute_error = True
    result = await Qualification(settings, SESSION, lambda _: runtime).run('lifecycle')
    encoded = json.dumps(result)
    assert result['outcome'] == 'failed' and result['error_classification'] == 'runtime_operation_failed'
    assert 'sensitive runtime failure' not in encoded and 'qualification-' + SESSION not in encoded
    assert all(policy['token'] not in encoded for policy in settings.auth)
    assert runtime.creates == runtime.removes == 1 and runtime.boxes == {}
    assert not list((tmp_path / '.runtime-qualification').glob('*/diagnostic-*.json'))


@pytest.mark.asyncio
async def test_opt_in_diagnostic_keeps_useful_cause_but_redacts_credentials_and_payload(tmp_path):
    settings, runtime = configured(tmp_path), FakeRuntime()
    settings.profiles['workloads']['fixture-write-file:v1']['environment'] = {'API_SECRET': 'private-config-value'}
    async def failing_create(name, profile):
        try:
            raise PermissionError(1, 'Operation not permitted')
        except PermissionError as cause:
            raise RuntimeError('create failed ' + settings.auth[0]['token'] + ' qualification-' + SESSION
                               + ' private-config-value') from cause
    runtime.ensure = failing_create
    probe = Qualification(settings, SESSION, lambda _: runtime, diagnostics_enabled=True)
    result = await probe.run('lifecycle')
    summary = json.dumps(result)
    diagnostic = probe.directory / result['operator_diagnostic']['file']
    private = diagnostic.read_text()
    assert result['outcome'] == 'failed' and result['failed_stage'] == 'create_a'
    assert 'Operation not permitted' in summary and 'builtins.PermissionError' in summary
    assert 'traceback' in private and diagnostic.stat().st_mode & 0o777 == 0o600
    for sensitive in (settings.auth[0]['token'], 'qualification-' + SESSION, 'private-config-value'):
        assert sensitive not in summary and sensitive not in private
    assert runtime.removes == 0


def test_changed_profile_manifest_cannot_be_reused(tmp_path):
    settings = configured(tmp_path)
    probe = Qualification(settings, SESSION)
    probe.save()
    settings.profiles['sandboxes']['minimal-linux:v1']['memory_mib'] = 256
    with pytest.raises(QualificationError, match='session_identity_mismatch'):
        Qualification(settings, SESSION)


@pytest.mark.asyncio
@pytest.mark.skipif(os.path.exists('/dev/kvm'), reason='Negative path requires absent KVM')
async def test_production_adapter_without_kvm_is_blocked_without_fake_fallback(tmp_path):
    probe = Qualification(configured(tmp_path), SESSION)
    result = await probe.run('lifecycle')
    assert result['outcome'] == 'blocked' and result['error_classification'] == 'runtime_not_ready'
    assert result['retained_boxes'] == []
