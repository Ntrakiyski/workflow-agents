import copy
import pytest
from provider.config import Settings
from provider.errors import ServiceError
from provider.runtime import BoxLiteRuntime
from .conftest import policies, profiles


def test_configuration_rejects_mutable_images_shell_interpolation_and_disk_rounding():
    for mutate in [lambda p: p['sandboxes']['minimal-linux:v1'].update(image='python:latest'),
                   lambda p: p['sandboxes']['minimal-linux:v1'].update(disk_mib=512),
                   lambda p: p['workloads']['fixture-write-file:v1'].update(argv=['sh', '-c', 'echo ${arg:text}']),
                   lambda p: p['workloads']['fixture-write-file:v1'].update(argv=['${arg:text}'])]:
        p = profiles(); mutate(p)
        with pytest.raises(Exception):
            Settings('postgresql://unused', policies(), p)


async def test_real_runtime_probe_fails_when_kvm_absent(tmp_path):
    import os
    if os.path.exists('/dev/kvm'):
        pytest.skip('Host has a KVM device; dedicated real-runtime suite must qualify it.')
    r = BoxLiteRuntime(tmp_path)
    assert not await r.ready()
    with pytest.raises(ServiceError) as err:
        await r.ensure('test-box', profiles()['sandboxes']['minimal-linux:v1'])
    assert err.value.code == 'runtime_unavailable'
    assert r.runtime is None


def test_unicode_credential_and_invalid_delegate_policy_fail_safely():
    s = Settings('postgresql://unused', policies(), profiles())
    with pytest.raises(ServiceError) as err:
        s.authenticate('Bearer ébad-token', None)
    assert err.value.status == 401
    for value in ['owner-a', ['bad owner'], [123], []]:
        auth = policies(); auth[2]['delegate_owners'] = value
        with pytest.raises(ValueError):
            Settings('postgresql://unused', auth, profiles())


def test_concurrency_configuration_preserves_pool_safety():
    assert Settings('postgresql://unused', policies(), profiles(), max_concurrent_runs=1).max_concurrent_runs == 1
    for value in (0, 5, True, 1.5):
        with pytest.raises(ValueError):
            Settings('postgresql://unused', policies(), profiles(), max_concurrent_runs=value)
