"""Two concurrent actual-binary OfficeCLI sessions sharing one read-only runtime; no model calls."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--runtime', type=Path, required=True)
runtime = parser.parse_args().runtime.resolve()


def inventory():
    values = {}
    for path in runtime.rglob('*'):
        if path.is_file():
            with path.open('rb') as stream:
                values[path.relative_to(runtime).as_posix()] = hashlib.file_digest(stream, 'sha256').hexdigest()
    return values


before = inventory()
processes = [subprocess.Popen([sys.executable, '-B', str(Path(__file__).with_name('runtime-smoke.py')),
                              '--runtime', str(runtime)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
             for _ in range(2)]
results = []
for process in processes:
    out, err = process.communicate(timeout=180)
    if process.returncode:
        raise RuntimeError('Concurrent actual-binary smoke failed: ' + err.decode()[-2000:])
    results.append(json.loads(out))
assert before == inventory(), 'Shared runtime changed during concurrent execution'
assert all(item['outcome'] == 'passed' for item in results)
print(json.dumps({'outcome': 'passed', 'concurrent_actual_binary_sessions': 2,
                  'shared_runtime_unchanged': True, 'session_results': results,
                  'model_calls': 'not_performed', 'cloud_execution': 'not_performed'}))
