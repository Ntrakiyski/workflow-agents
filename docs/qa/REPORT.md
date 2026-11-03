# Independent Phase 1 QA verification

Status: review and execution in progress. This document will record independently executed commands, observed counts/outcomes, source defects and retests. No release approval has been granted.

## Executed contract validation

2026-11-03, clean QA worktree at `02ac25f`:

```sh
python3 -m venv /tmp/workflow-phase1-qa-venv
/tmp/workflow-phase1-qa-venv/bin/pip install -q -r contracts/requirements-test.txt
/tmp/workflow-phase1-qa-venv/bin/python contracts/tests/test_contracts.py
```

Fresh dependency installation succeeded. **5 tests passed in 0.609 s**: both OpenAPI documents, profile config, Provider payloads, response/error fixtures, Runner payloads. These are schema tests; no HTTP/database/BoxLite operation is claimed.

`tests/qa/http_probe.py` is an independent generic consumer using only published HTTP contracts and configuration. It validates captured JSON against frozen response schemas. Its syntax compilation passed; service execution is pending implementation.

## Defects under investigation

- Provider config rejects `disk_mib` that is not a whole GiB, while frozen template uses 512 MiB. Sent to Provider engineer and lead before baseline completion. Must be corrected by explicit SDK-supported policy/template alignment, not silently rounded or ignored.
