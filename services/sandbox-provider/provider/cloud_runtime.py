"""Explicit hosted BoxLite SDK backend. Never falls back to local execution."""
import asyncio
import hashlib
import json
import secrets
import uuid
from dataclasses import dataclass
from pathlib import Path

from .errors import ServiceError, unavailable
from .runtime import BoxLiteRuntime, RuntimeIdentity


@dataclass
class JournalExecution:
    native: object
    nonce: str
    runtime_reference: str | None = None

    def id(self):
        return self.native.id()


class BoxLiteCloudRuntime(BoxLiteRuntime):
    requires_create_fence = True
    cancellation_stops_environment = True
    file_transfer_input = 'argv'

    def __init__(self, settings):
        self.settings, self.runtime = settings, None
        material = '\n'.join((settings.boxlite_rest_url, settings.boxlite_account_scope,
                              settings.boxlite_rest_path_prefix or ''))
        self.backend_id = 'boxlite-cloud:' + hashlib.sha256(material.encode()).hexdigest()

    async def _runtime(self):
        import boxlite
        if boxlite.__version__ != '0.11.0':
            raise unavailable('runtime_version_mismatch')
        if self.runtime is None:
            self.runtime = boxlite.Boxlite.rest(boxlite.BoxliteRestOptions(
                url=self.settings.boxlite_rest_url,
                credential=boxlite.ApiKeyCredential(self.settings.boxlite_api_key),
                path_prefix=self.settings.boxlite_rest_path_prefix))
        return self.runtime

    def creation_name(self, sandbox_id):
        return self.settings.boxlite_account_scope + '-' + sandbox_id

    async def _request(self, operation):
        import boxlite.errors as errors
        try:
            async with asyncio.timeout(self.settings.runtime_request_timeout):
                return await operation
        except ServiceError:
            raise
        except errors.ConfigError:
            raise ServiceError(503, 'runtime_authentication_failed', 'Execution backend authentication or configuration was refused.') from None
        except (errors.InvalidArgumentError, errors.UnsupportedError, errors.ImageError):
            raise ServiceError(422, 'runtime_policy_rejected', 'Execution backend refused the approved profile.') from None
        except errors.ResourceExhaustedError:
            raise unavailable('runtime_capacity_unavailable') from None
        except errors.NotFoundError:
            raise ServiceError(409, 'missing_runtime', 'Retained environment could not be located. Operator recovery is required.') from None
        except Exception:
            # Native messages can contain response bodies, URLs and credentials.
            raise unavailable() from None

    async def ready(self):
        try:
            runtime = await self._runtime()
            # A real authenticated read, not a local KVM/file existence probe.
            # No VM, image, port, tunnel, execution or deletion is created here.
            await self._request(runtime.list_info())
            return True
        except Exception:
            return False

    def _identity(self, info):
        return RuntimeIdentity(info.id, self.backend_id + '/' + info.id, info.state.running)

    async def inspect(self, reference):
        runtime = await self._runtime()
        info = await self._request(runtime.get_info(reference))
        if info is not None and info.id != reference:
            raise ServiceError(409, 'runtime_identity_mismatch', 'Retained environment identity does not match its registry.')
        return self._identity(info) if info else None

    async def find_creation(self, name):
        runtime = await self._runtime()
        matches = [info for info in await self._request(runtime.list_info()) if info.name == name]
        if len(matches) > 1:
            raise ServiceError(409, 'runtime_identity_mismatch', 'Environment creation requires operator reconciliation.')
        return matches[0] if matches else None

    async def verify(self, reference, profile):
        runtime = await self._runtime()
        info = await self._request(runtime.get_info(reference))
        if info is None:
            raise ServiceError(409, 'missing_runtime', 'Retained environment could not be located. Operator recovery is required.')
        if info.id != reference:
            raise ServiceError(409, 'runtime_identity_mismatch', 'Retained environment identity does not match its registry.')
        self._verify_profile(info, profile)

    @staticmethod
    def validate_profile(profile):
        if profile['cpus'] > 16 or profile['memory_mib'] < 1024 or profile['memory_mib'] % 1024:
            raise ServiceError(422, 'runtime_policy_rejected', 'Cloud profiles require at most 16 CPUs and whole-GiB memory; rounding is forbidden.')

    @staticmethod
    def _verify_profile(info, profile):
        network = info.network
        expected_mode = 'disabled' if profile['network'] == 'denied' else 'enabled'
        if (info.image != profile['image'] or info.cpus != profile['cpus']
                or info.memory_mib != profile['memory_mib'] or info.auto_delete != 0
                or info.auto_stop != 0 or info.auto_resume is not False
                or network is None or network.inbound.mode != 'disabled'
                or network.outbound.mode != expected_mode
                or sorted(network.outbound.allow_net) != sorted(profile.get('allowed_hosts', []))):
            raise ServiceError(409, 'runtime_policy_mismatch', 'Execution backend metadata does not match the approved profile.')

    async def ensure(self, name, profile, *, allow_create=True):
        import boxlite
        self.validate_profile(profile)
        runtime = await self._runtime()
        # Names recover only the first ambiguous create. All retained operations
        # use the server ID committed in the Provider registry, never a name.
        info = await self.find_creation(name)
        if info:
            if allow_create:
                raise ServiceError(409, 'runtime_identity_mismatch', 'Preexisting environment cannot be adopted during first creation.')
            self._verify_profile(info, profile)
            return await self.start(info.id) if not info.state.running else self._identity(info)
        if not allow_create:
            raise ServiceError(409, 'ambiguous_creation', 'Environment creation requires operator reconciliation.')
        outbound = boxlite.OutboundNetworkSpec(
            mode='disabled' if profile['network'] == 'denied' else 'enabled',
            allow_net=profile.get('allowed_hosts', []))
        options = boxlite.BoxOptions(
            image=profile['image'], cpus=profile['cpus'], memory_mib=profile['memory_mib'],
            disk_size_gb=profile['disk_mib'] // 1024, working_dir='/',
            network=boxlite.NetworkSpec(outbound=outbound, inbound=boxlite.InboundNetworkSpec(mode='disabled')),
            auto_remove=False, auto_delete=0, auto_stop=0, auto_resume=False, detach=True,
            entrypoint=profile.get('entrypoint'), cmd=profile.get('cmd'))
        box = await self._request(runtime.create(options, name=name))
        # Server-owned jailer policy is intentionally not overridden by client.
        info = await self._request(box.info())
        self._verify_profile(info, profile)
        return await self.start(info.id)

    async def _box(self, reference):
        runtime = await self._runtime()
        box = await self._request(runtime.get(reference))
        if box is None:
            raise ServiceError(409, 'missing_runtime', 'Retained environment could not be located. Operator recovery is required.')
        if box.id != reference:
            raise ServiceError(409, 'runtime_identity_mismatch', 'Retained environment identity does not match its registry.')
        return box

    async def start(self, reference):
        box = await self._box(reference)
        info = await self._request(box.info())
        if info.state.status in ('unknown', 'stopping'):
            info = await self._wait_settled(reference)
        if not info.state.running:
            await self._request(box.start())
        return self._identity(await self._wait_state(reference, {'running'}))

    async def _wait_state(self, reference, states):
        runtime = await self._runtime()
        try:
            async with asyncio.timeout(self.settings.runtime_request_timeout):
                while True:
                    info = await self._request(runtime.get_info(reference))
                    if info is None:
                        raise ServiceError(409, 'missing_runtime', 'Retained environment could not be located. Operator recovery is required.')
                    if info.id != reference:
                        raise ServiceError(409, 'runtime_identity_mismatch', 'Retained environment identity does not match its registry.')
                    if info.state.status in states:
                        return info
                    if info.state.status == 'failed' and 'failed' not in states:
                        raise ServiceError(409, 'invalid_state', 'Execution backend reported a failed environment.')
                    await asyncio.sleep(.25)
        except TimeoutError:
            raise unavailable('runtime_transition_pending') from None

    async def _wait_settled(self, reference):
        return await self._wait_state(reference, {'running', 'configured', 'stopped', 'paused', 'failed'})

    async def stop(self, reference):
        box = await self._box(reference)
        info = await self._request(box.info())
        if info.state.status == 'unknown':
            info = await self._wait_settled(reference)
        if info.state.running:
            await self._request(box.stop())
        await self._wait_state(reference, {'stopped', 'configured', 'paused', 'failed'})

    async def destroy(self, reference):
        runtime = await self._runtime()
        if await self.inspect(reference):
            await self.stop(reference)
            for attempt in range(3):
                try:
                    await self._request(runtime.remove(reference, force=False))
                    break
                except ServiceError as error:
                    if await self.inspect(reference) is None:
                        return
                    if error.code != 'runtime_policy_rejected' or attempt == 2:
                        raise
                    await asyncio.sleep(.25)
                    await self._wait_settled(reference)
            try:
                async with asyncio.timeout(self.settings.runtime_request_timeout):
                    while await self.inspect(reference) is not None:
                        await asyncio.sleep(.25)
            except TimeoutError:
                raise unavailable('runtime_transition_pending') from None

    async def execute(self, reference, argv, profile, timeout):
        box = await self._box(reference)
        nonce = secrets.token_hex(32)
        result_reference = profile.get('_result_reference', 'run_' + uuid.uuid4().hex)
        source = Path(__file__).with_name('guest_run.py').read_text()
        try:
            native = await self._request(box.exec('python3', args=['-c', source, nonce, result_reference,
                str(min(profile['max_output_bytes'], 32768)), json.dumps(list(profile.get('secret_environment', {}))), *argv],
                env=list(profile.get('environment', {}).items()), cwd=profile['working_directory'], timeout_secs=timeout))
            return JournalExecution(native, nonce, reference)
        except ServiceError as error:
            if error.retryable:
                raise ServiceError(409, 'ambiguous_execution', 'Execution outcome is unknown. Environment requires recovery.') from None
            raise

    async def collect(self, execution, max_output):
        # A wrapper completion record is mandatory even for a child that emits
        # no bytes. SDK exit0 with lost/empty streams is explicitly ambiguous.
        if not isinstance(execution, JournalExecution):
            raise ServiceError(409, 'ambiguous_execution', 'A complete workload result could not be verified. Environment requires recovery.')
        try:
            async def drain(stream):
                data = bytearray()
                async for part in stream:
                    raw = part.encode() if isinstance(part, str) else bytes(part)
                    if len(data) + len(raw) > 1048576:
                        raise ValueError('wrapper_too_large')
                    data.extend(raw)
                return bytes(data)
            out, err, native_result = await asyncio.gather(drain(execution.native.stdout()), drain(execution.native.stderr()), execution.native.wait())
            if native_result.exit_code != 0 or getattr(native_result, 'error_message', None) or err:
                raise ValueError('incomplete_wrapper')
            envelope = json.loads(out)
            result = envelope['result']
            if (envelope['version'] != 1 or envelope['nonce'] != execution.nonce
                    or set(result) != {'exit_code', 'stdout', 'stderr', 'output_truncated', 'artifacts'}
                    or type(result['exit_code']) is not int or type(result['output_truncated']) is not bool
                    or result['artifacts'] != [] or not isinstance(result['stdout'], str)
                    or not isinstance(result['stderr'], str)):
                raise ValueError('invalid_wrapper')
            encoded = json.dumps(result, sort_keys=True, separators=(',', ':'), ensure_ascii=True)
            if hashlib.sha256(encoded.encode()).hexdigest() != envelope['sha256']:
                raise ValueError('invalid_checksum')
            for name in ('stdout', 'stderr'):
                raw = result[name].encode()
                result['output_truncated'] |= len(raw) > max_output
                result[name] = raw[:max_output].decode(errors='replace')[:32768]
            return result
        except ServiceError:
            raise
        except Exception:
            raise ServiceError(409, 'ambiguous_execution', 'A complete workload result could not be verified. Environment requires recovery.') from None

    async def attach(self, reference, execution_id):
        # SDK0.11 may recover a zero exit status after losing output, without
        # exposing that loss to Python. Do not equate it with a recovered result.
        # ProviderService will stop this same retained box and preserve a safe,
        # nonretryable ambiguous execution rather than dispatching it again.
        raise ServiceError(409, 'ambiguous_execution', 'Execution output cannot be safely recovered from this backend. Environment requires recovery.')

    async def cancel(self, execution):
        # A wrapper kill alone cannot prove its subprocess tree terminated.
        # Confirm same-box stop before reporting cancellation; retain the disk.
        if not isinstance(execution, JournalExecution) or not execution.runtime_reference:
            raise ServiceError(409, 'ambiguous_execution', 'Execution cancellation requires same-environment recovery.')
        try:
            await self._request(execution.native.kill())
        except ServiceError:
            pass  # Stop confirmation below is authoritative for descendants.
        await self.stop(execution.runtime_reference)
