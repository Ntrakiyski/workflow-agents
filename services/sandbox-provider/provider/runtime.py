"""Runtime boundary. Real entrypoint uses only BoxLite; test doubles live in tests."""
import asyncio
import os
import json
from pathlib import Path
from dataclasses import dataclass
from typing import Protocol
from .errors import ServiceError, unavailable


@dataclass
class RuntimeIdentity:
    runtime_id: str
    disk_ref: str
    running: bool


class SandboxRuntime(Protocol):
    kind: str
    async def ready(self) -> bool: ...
    async def ensure(self, name, profile) -> RuntimeIdentity: ...
    async def inspect(self, name) -> RuntimeIdentity | None: ...
    async def start(self, name) -> RuntimeIdentity: ...
    async def stop(self, name): ...
    async def destroy(self, name): ...
    async def execute(self, name, argv, profile, timeout): ...
    async def attach(self, name, execution_id): ...
    async def collect(self, execution, max_output): ...
    async def cancel(self, execution): ...
    async def transfer(self, name, request): ...
    async def close(self): ...


class BoxLiteRuntime:
    kind = 'boxlite'
    backend_id = 'boxlite-local'

    def __init__(self, root):
        self.root, self.runtime = root, None

    async def ready(self):
        if not (os.path.exists('/dev/kvm') and os.access('/dev/kvm', os.R_OK | os.W_OK)):
            return False
        try:
            # KVM_GET_API_VERSION is read-only and fails if this device is unusable.
            import fcntl
            with open('/dev/kvm', 'rb', buffering=0) as kvm:
                if fcntl.ioctl(kvm, 0xAE00) != 12:
                    return False
            import boxlite
            return boxlite.__version__ == '0.11.0'
        except Exception:
            return False

    async def _runtime(self):
        if not await self.ready():
            raise unavailable()
        if self.runtime is None:
            import boxlite
            self.root.mkdir(parents=True, exist_ok=True)
            self.runtime = boxlite.Boxlite(boxlite.Options(home_dir=str(self.root)))
        return self.runtime

    async def _box(self, name):
        runtime = await self._runtime()
        box = await runtime.get(name)
        if box is None:
            raise ServiceError(409, 'missing_runtime', 'Retained environment could not be located. Operator recovery is required.')
        return box

    async def inspect(self, name):
        runtime = await self._runtime()
        info = await runtime.get_info(name)
        if info is None:
            return None
        return RuntimeIdentity(info.id, info.id, info.state.running)

    async def ensure(self, name, profile, *, allow_create=True):
        import boxlite
        runtime = await self._runtime()
        found = await self.inspect(name)
        if found:
            return await self.start(name) if not found.running else found
        if not allow_create:
            raise ServiceError(409, 'ambiguous_creation', 'Environment creation requires operator reconciliation.')
        outbound = boxlite.OutboundNetworkSpec(mode='disabled' if profile['network'] == 'denied' else 'enabled',
                                              allow_net=profile.get('allowed_hosts', []))
        options = boxlite.BoxOptions(image=profile['image'], cpus=profile['cpus'], memory_mib=profile['memory_mib'],
                                     disk_size_gb=profile['disk_mib'] // 1024, working_dir='/',
                                     network=boxlite.NetworkSpec(outbound=outbound),
                                     auto_remove=False, auto_delete=0, detach=True,
                                     advanced=boxlite.AdvancedBoxOptions(security=boxlite.SecurityOptions.standard()))
        box = await runtime.create(options, name=name)
        await box.start()
        return await self.inspect(name)

    async def start(self, name):
        box = await self._box(name)
        info = await box.info()
        if not info.state.running:
            await box.start()
        return await self.inspect(name)

    async def stop(self, name):
        box = await self._box(name)
        info = await box.info()
        if info.state.running:
            await box.stop()

    async def destroy(self, name):
        runtime = await self._runtime()
        if await self.inspect(name):
            await runtime.remove(name, force=False)

    async def execute(self, name, argv, profile, timeout):
        box = await self._box(name)
        return await box.exec(argv[0], args=argv[1:], env=list(profile.get('environment', {}).items()),
                              cwd=profile['working_directory'], timeout_secs=timeout)

    async def attach(self, name, execution_id):
        box = await self._box(name)
        return await box.attach(execution_id=execution_id, stdin=False)

    async def collect(self, execution, max_output):
        truncated = False
        async def drain(stream):
            nonlocal truncated
            data = bytearray()
            async for chunk in stream:
                raw = chunk.encode() if isinstance(chunk, str) else bytes(chunk)
                remaining = max_output - len(data)
                if len(raw) > remaining:
                    truncated = True
                if remaining > 0:
                    data.extend(raw[:remaining])
            return data.decode('utf-8', errors='replace')[:32768]
        # Drain both pipes concurrently even after truncation to avoid deadlock.
        out, err, result = await asyncio.gather(drain(execution.stdout()), drain(execution.stderr()), execution.wait())
        if getattr(result, 'error_message', None):
            raise ServiceError(409, 'ambiguous_execution', 'Execution transport did not confirm a complete result. Environment requires recovery.')
        return {'exit_code': result.exit_code, 'stdout': out, 'stderr': err, 'output_truncated': truncated, 'artifacts': []}

    async def cancel(self, execution):
        await execution.kill()
        await execution.wait()

    async def transfer(self, name, request):
        """Run fixed guest code with bounded stdin; never use rootfs copy APIs.

        Cloud copy_in(overwrite=False) is unsupported in SDK0.11.0. Its copy
        APIs also do not provide the descriptor-relative symlink policy needed
        here. Both backends use the same explicit Python3 guest helper instead.
        """
        from .transfers import MAX_BODY
        box = await self._box(name)
        source = Path(__file__).with_name('guest_files.py').read_text()
        async def operation():
            execution = await box.exec('python3', args=['-c', source], cwd='/', timeout_secs=30)
            stdin = execution.stdin()
            async def send():
                await stdin.send_input(json.dumps(request, separators=(',', ':')).encode())
                await stdin.close()
            async def drain(stream):
                data = bytearray()
                async for part in stream:
                    raw = part.encode() if isinstance(part, str) else bytes(part)
                    if len(data) + len(raw) > MAX_BODY:
                        raise ValueError('transfer_output_too_large')
                    data.extend(raw)
                return bytes(data)
            _, out, _, result = await asyncio.gather(send(), drain(execution.stdout()), drain(execution.stderr()), execution.wait())
            if getattr(result, 'error_message', None):
                raise ValueError('incomplete_transfer_output')
            envelope = json.loads(out)
            if not isinstance(envelope, dict) or type(envelope.get('ok')) is not bool:
                raise ValueError('incomplete_transfer_output')
            if not envelope['ok']:
                raise ServiceError(409, 'file_transfer_rejected', 'Guest file safety, checksum or path validation refused this transfer.')
            if result.exit_code != 0 or not isinstance(envelope.get('value'), dict):
                raise ValueError('incomplete_transfer_output')
            return envelope['value']
        try:
            async with asyncio.timeout(35):
                return await operation()
        except ServiceError:
            raise
        except Exception:
            raise ServiceError(409, 'ambiguous_transfer', 'File transfer outcome is unknown. Retry the same upload and chunk; do not overwrite a destination.') from None

    async def close(self):
        if self.runtime is not None:
            # Detached boxes survive SDK handle close; normal API shutdown does not remove disks.
            self.runtime.close()
            self.runtime = None


def configured_runtime(settings):
    if settings.runtime_mode == 'cloud':
        from .cloud_runtime import BoxLiteCloudRuntime
        return BoxLiteCloudRuntime(settings)
    return BoxLiteRuntime(settings.box_root)
