"""Exercise fixed guest code in local processes, not BoxLite guests."""
import asyncio
import json
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
import pytest
from provider.cloud_runtime import JournalExecution
from provider.errors import ServiceError
from provider.runtime import configured_runtime
from .test_cloud_runtime import configured


class Output:
    def __init__(self, value, error=None):
        self.value, self.error = value, error
    async def stdout(self):
        for offset in range(0, len(self.value), 7000):
            yield self.value[offset:offset + 7000]
    async def stderr(self):
        if False:
            yield b''
    async def wait(self):
        return SimpleNamespace(exit_code=0, error_message=self.error)


def wrapper(tmp_path, argv, nonce='nonce-for-unit-test'):
    source = Path(__file__).parents[1].joinpath('provider/guest_run.py').read_text()
    parts = tuple(str(tmp_path).strip('/').split('/'))
    source = source.replace("('opt', 'workflow-transfer', '.executions', reference)", repr(parts) + " + ('.executions', reference)")
    result = subprocess.run([sys.executable, '-c', source, nonce, 'run_' + 'a' * 32, '32768', '[]', *argv], capture_output=True, check=True)
    return result.stdout


@pytest.mark.parametrize('code,stdout', [(0, ''), (0, 'hello'), (7, '')])
async def test_wrapper_proves_silent_results_and_preserves_child_exit_status(tmp_path, code, stdout):
    out = wrapper(tmp_path, [sys.executable, '-c', f'import sys;sys.stdout.write({stdout!r});sys.exit({code})'])
    runtime = configured_runtime(configured(tmp_path))
    result = await runtime.collect(JournalExecution(Output(out), 'nonce-for-unit-test'), 32768)
    assert result['exit_code'] == code and result['stdout'] == stdout and not result['output_truncated']
    journal = tmp_path / '.executions' / ('run_' + 'a' * 32) / 'result.json'
    assert json.loads(journal.read_text()) == json.loads(out)


async def test_wrapper_drains_large_output_with_explicit_truncation(tmp_path):
    out = wrapper(tmp_path, [sys.executable, '-c', 'import sys;sys.stdout.write("x"*100000);sys.stderr.write("y"*100000)'])
    runtime = configured_runtime(configured(tmp_path))
    result = await runtime.collect(JournalExecution(Output(out), 'nonce-for-unit-test'), 32768)
    assert result['output_truncated'] and len(result['stdout']) == len(result['stderr']) == 32768


@pytest.mark.parametrize('raw', [b'', b'{}', b'{"version":1,"nonce":"wrong","result":{},"sha256":"x"}'])
async def test_exit_zero_without_complete_envelope_is_ambiguous(tmp_path, raw):
    runtime = configured_runtime(configured(tmp_path))
    with pytest.raises(ServiceError) as error:
        await runtime.collect(JournalExecution(Output(raw), 'nonce-for-unit-test'), 32768)
    assert error.value.code == 'ambiguous_execution' and not error.value.retryable


async def test_tampered_result_and_native_error_are_not_success(tmp_path):
    out = wrapper(tmp_path, [sys.executable, '-c', 'print("hello")'])
    value = json.loads(out)
    value['result']['stdout'] = 'changed'
    runtime = configured_runtime(configured(tmp_path))
    for raw, error in ((json.dumps(value).encode(), None), (out, 'transport failed')):
        with pytest.raises(ServiceError, match='ambiguous_execution'):
            await runtime.collect(JournalExecution(Output(raw, error), 'nonce-for-unit-test'), 32768)
