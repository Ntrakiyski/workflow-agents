"""Real BoxLite probe. Never substitutes a fake or treats a skip as a pass."""
import os
import uuid
import pytest
from provider.config import Settings
from provider.runtime import BoxLiteRuntime

pytestmark = pytest.mark.real_runtime


async def test_real_boxlite_persistence_restart_and_two_box_isolation():
    if not os.path.exists('/dev/kvm'):
        pytest.skip('BLOCKED: /dev/kvm is absent on this execution host; real BoxLite cannot start.')
    if not all(k in os.environ for k in ('DATABASE_URL', 'PROVIDER_AUTH_JSON', 'PROVIDER_PROFILES_JSON', 'BOX_ROOT')):
        pytest.skip('BLOCKED: real runtime requires explicit approved digest profiles, credentials and persistent BOX_ROOT.')
    settings = Settings.from_env()
    runtime = BoxLiteRuntime(settings.box_root)
    assert await runtime.ready(), 'KVM device, SDK or persistent root unavailable'
    identity = settings.authenticate('Bearer ' + settings.auth[0]['token'], None)
    names = ['phase1-real-' + uuid.uuid4().hex for _ in range(2)]
    sandbox_profile = settings.sandbox_profile(identity, 'minimal-linux:v1')
    try:
        await runtime.ensure(names[0], sandbox_profile)
        profile, argv = settings.workload(identity, 'fixture-write-file:v1', 'minimal-linux:v1', {'file': 'hello-world.txt', 'text': 'retained-marker'}, 30)
        result = await runtime.collect(await runtime.execute(names[0], argv, profile, 30), 32768)
        assert result['exit_code'] == 0
        before = await runtime.inspect(names[0])
        await runtime.stop(names[0])
        assert (await runtime.inspect(names[0])).running is False
        await runtime.close()
        runtime = BoxLiteRuntime(settings.box_root)
        await runtime.start(names[0])
        assert (await runtime.inspect(names[0])).runtime_id == before.runtime_id
        profile, argv = settings.workload(identity, 'fixture-read-file:v1', 'minimal-linux:v1', {'file': 'hello-world.txt'}, 30)
        result = await runtime.collect(await runtime.execute(names[0], argv, profile, 30), 32768)
        assert result['exit_code'] == 0 and result['stdout'] == 'retained-marker'
        await runtime.ensure(names[1], sandbox_profile)
        result = await runtime.collect(await runtime.execute(names[1], argv, profile, 30), 32768)
        assert result['exit_code'] != 0, 'Marker from box A must not exist in box B'
    finally:
        for name in names:
            if await runtime.inspect(name):
                await runtime.stop(name)
                await runtime.destroy(name)
        await runtime.close()
