# Contract validation evidence

Executed in the contract worktree on 2026-11-03:

```sh
python3 contracts/build_contracts.py
python3 contracts/build_profiles.py
python3 -m venv /tmp/workflow-contract-venv
/tmp/workflow-contract-venv/bin/pip install -r contracts/requirements-test.txt
/tmp/workflow-contract-venv/bin/python contracts/tests/test_contracts.py
```

Observed result: **5 tests passed** in 0.601 seconds. These cover both OpenAPI 3.1 documents, every component schema, strict request shapes, valid/invalid schedule alternatives, provider execute/destroy constraints, example responses, actor/effective-owner event fields, pinned-image configuration shape and fixture path/argument bounds. The unresolved image template is intentionally rejected; the valid schema-only image is a synthetic `example.invalid` reference and has never been pulled or executed.

Test dependencies are pinned (`jsonschema==4.24.0`, `openapi-spec-validator==0.8.4`). The first attempted jsonschema 4.26.0 pin conflicted with the OpenAPI validator requirement; corrected to its supported 4.24.0 and reran successfully. Full installed dependency versions are in `contracts/requirements-test.lock`.

No service endpoints, PostgreSQL, Graphile Worker, BoxLite or deployment were tested by these schema tests. These results establish contract consistency only. Independent implementation and integration suites must capture actual HTTP responses and validate against the documents. `contracts/assert_response.py` provides a reusable strict captured-response validator with no service imports or network/credential handling.
