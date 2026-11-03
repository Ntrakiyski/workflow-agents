"""Read bounded, redacted logs from one existing isolated qualification session.

This operator helper never opens the runtime, database or production SDK home.
It does not create a session or change its files. Output is operator-only.
"""
import argparse
import json
import os
import re
import stat

from provider.config import Settings
from scripts.qualify_runtime import Qualification, require, safe_error


TAIL_BYTES = 8192


def tail(path):
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), 'rb') as handle:
        require(stat.S_ISREG(os.fstat(handle.fileno()).st_mode), 'diagnostic_file_not_regular')
        handle.seek(0, os.SEEK_END)
        size = handle.tell()
        handle.seek(max(0, size - TAIL_BYTES))
        return handle.read(TAIL_BYTES).decode('utf-8', errors='replace'), size > TAIL_BYTES


def inspect_existing(settings, session):
    require(bool(re.fullmatch('[a-f0-9]{32}', session)), 'invalid_session')
    anchor = settings.box_root.resolve().parent / '.runtime-qualification'
    require((anchor / session / 'state.json').is_file(), 'session_state_missing')
    # Existing paths are checked again by Qualification; no save/open/run call.
    qualification = Qualification(settings, session)
    logs = qualification.home / 'logs'
    require(not logs.is_symlink(), 'unsafe_diagnostic_directory')
    candidates = sorted((p for p in logs.glob('boxlite.log*')
                         if re.fullmatch(r'boxlite\.log(?:\.\d{4}-\d{2}-\d{2})?', p.name)
                         and not p.is_symlink()), key=lambda p: p.name)[-2:]
    records = []
    for path in candidates:
        text, truncated = tail(path)
        records.append({'file': path.name, 'tail': qualification.redact_diagnostic(text),
                        'prefix_truncated': truncated})
    return {'probe': 'workflow-agents-runtime-diagnostic-v1', 'session': session,
            'scope': 'Read-only operator SDK logs; no runtime/API/database operation.',
            'outcome': 'passed' if records else 'unavailable', 'sdk_logs': records}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--session', required=True)
    args = parser.parse_args()
    try:
        report = inspect_existing(Settings.from_env(), args.session)
    except Exception as exc:
        report = {'probe': 'workflow-agents-runtime-diagnostic-v1', 'outcome': 'failed',
                  'error_classification': safe_error(exc)}
    print(json.dumps(report, separators=(',', ':')))
    return 0 if report['outcome'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
