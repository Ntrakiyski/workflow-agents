"""Deterministic runtime double. Does not create microVMs or prove VM isolation."""
import asyncio
import uuid
from provider.runtime import RuntimeIdentity
from provider.errors import ServiceError


class Execution:
    def __init__(self, runtime, name, argv):
        self.key = 'exec_' + uuid.uuid4().hex
        self.runtime, self.name, self.argv = runtime, name, argv
        self.task = asyncio.create_task(self.run())
    def id(self):
        return self.key
    async def run(self):
        runtime, name, argv = self.runtime, self.name, self.argv
        runtime.active[name] = runtime.active.get(name, 0) + 1
        runtime.max_active[name] = max(runtime.active[name], runtime.max_active.get(name, 0))
        runtime.max_global_active = max(sum(runtime.active.values()), runtime.max_global_active)
        try:
            if argv[0] == '/usr/local/bin/python3' and len(argv) >= 4 and 'write_text' in argv[2]:
                runtime.boxes[name]['files'][argv[3]] = argv[4]
                return {'exit_code': 0, 'stdout': 'written', 'stderr': '', 'output_truncated': False, 'artifacts': []}
            if argv[0] == '/usr/local/bin/python3' and len(argv) >= 4 and 'read_text' in argv[2]:
                data = runtime.boxes[name]['files'].get(argv[3])
                return {'exit_code': 0 if data is not None else 2, 'stdout': data or '', 'stderr': '', 'output_truncated': False, 'artifacts': []}
            if argv[0] == '/fixture/delay':
                await asyncio.sleep(float(argv[1]))
                return {'exit_code': 0, 'stdout': 'done', 'stderr': '', 'output_truncated': False, 'artifacts': []}
            if argv[0] == '/fixture/write':
                runtime.boxes[name]['files'][argv[1]] = argv[2]
                out, code = argv[2], 0
            elif argv[0] == '/fixture/read':
                out = runtime.boxes[name]['files'].get(argv[1], '')
                code = 0 if argv[1] in runtime.boxes[name]['files'] else 2
            elif argv[0] == '/fixture/exit':
                out, code = '', int(argv[1])
            else:
                out, code = 'new configured profile', 0
            await asyncio.sleep(.01)
            return {'exit_code': code, 'stdout': out, 'stderr': '', 'output_truncated': False, 'artifacts': []}
        finally:
            runtime.active[name] -= 1


class FakeRuntime:
    kind = 'fake-test-only'
    shared_execution_supported = True
    def __init__(self):
        self.boxes, self.executions, self.active, self.max_active = {}, {}, {}, {}
        self.creates, self.executes, self.removes = 0, 0, 0
        self.available = True
        self.max_global_active = 0
        self.execute_error = False
    async def ready(self):
        return self.available
    async def inspect(self, name):
        b = self.boxes.get(name)
        return RuntimeIdentity(name, name, b['running']) if b else None
    async def ensure(self, name, profile):
        if not self.available:
            raise ServiceError(503, 'runtime_unavailable', 'Runtime unavailable.', True)
        if name not in self.boxes:
            self.creates += 1
            self.boxes[name] = {'running': True, 'files': {}}
        return await self.start(name)
    async def start(self, name):
        if name not in self.boxes:
            raise ServiceError(409, 'missing_runtime', 'Missing runtime.')
        self.boxes[name]['running'] = True
        return await self.inspect(name)
    async def stop(self, name):
        if not self.available:
            raise ServiceError(503, 'runtime_unavailable', 'Runtime unavailable.', True)
        if name in self.boxes:
            for execution in self.executions.values():
                if execution.name == name and not execution.task.done():
                    execution.task.cancel()
                    await asyncio.gather(execution.task, return_exceptions=True)
            self.boxes[name]['running'] = False
    async def destroy(self, name):
        self.removes += 1
        self.boxes.pop(name, None)
    async def execute(self, name, argv, profile, timeout):
        self.executes += 1
        if self.execute_error:
            raise RuntimeError('sensitive runtime failure must not leak')
        execution = Execution(self, name, argv)
        self.executions[execution.key] = execution
        execution.result_reference = profile.get('_result_reference')
        return execution
    def shared_execution(self, reference, result_reference, nonce):
        return next(e for e in self.executions.values() if e.name == reference and e.result_reference == result_reference)
    async def cancel_reference(self, reference, result_reference, nonce):
        for execution in self.executions.values():
            if execution.name == reference and execution.result_reference == result_reference:
                await self.cancel(execution)
    async def attach(self, name, execution_id):
        return self.executions[execution_id]
    async def collect(self, execution, max_output):
        result = dict(await asyncio.shield(execution.task))
        for stream in ('stdout', 'stderr'):
            raw = result[stream].encode()
            result['output_truncated'] |= len(raw) > max_output
            result[stream] = raw[:max_output].decode(errors='replace')
        return result
    async def cancel(self, execution):
        execution.task.cancel()
        await asyncio.gather(execution.task, return_exceptions=True)
    async def close(self):
        pass
