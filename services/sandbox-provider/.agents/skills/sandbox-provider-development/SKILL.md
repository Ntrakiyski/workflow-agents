---
name: sandbox-provider-development
description: Develop and validate the generic FastAPI BoxLite Sandbox Provider, its persistent VM lifecycle, workload profiles and API compatibility.
---

# Sandbox Provider development procedure

1. Read `services/sandbox-provider/AGENTS.md` and `PHASE-1-REUSABLE-SERVICES.md`. Check the frozen generic API before writing code.
2. Confirm the pinned BoxLite SDK version and actual persistent create/get/start/stop/exec/remove semantics; do not rely on auto-removing convenience wrappers.
3. Implement generic `SandboxRuntime` boundaries, Provider-owned registry and idempotent authenticated HTTP handlers. Do not embed Pi/document business logic.
4. Enforce one active execution per sandbox, allowed workload profiles, validated args/paths, CPU/RAM/network limits and distinct stop/destroy permissions.
5. Unit-test state machine, API schemas, authentication, owner isolation and invalid requests.
6. With a real BoxLite image, create Box A, write a marker, stop without removal, reattach/start, verify marker, and create Box B to prove separation.
7. Restart Provider and repeat; test host restart when available, otherwise report persistence as unverified.
8. Capture exit results, checksum artifacts, durable audit events, correlation IDs and redacted structured logs. Verify no secret appears in reusable images or logs.
9. Run project-local format/lint/tests/migrations and describe commands/results in README and verification report.
10. Treat any new use-case need as a workload configuration unless it is a genuinely generic, versioned API capability with new regression tests.

## Verified candidate commands (2026-11-03)

Run from `services/sandbox-provider/`, Python 3.12:

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.lock
TEST_DATABASE_URL=... .venv/bin/python -m pytest -q -m 'not real_runtime'
TEST_DATABASE_URL=... .venv/bin/python -m pytest -q -rs
```

`TEST_DATABASE_URL` must be a dedicated disposable Provider database: fixtures TRUNCATE registry tables. Tests inject `tests.fake_runtime.FakeRuntime`, never enable a production mock mode. The `real_runtime` test explicitly skips when `/dev/kvm` is absent; such a skip blocks real-runtime acceptance.

Match packaged `provider/openapi.json` to root contract JSON after reviewed contract updates. Test cancellation fences together with execute, including response-timeout ambiguity. Whole-GiB disk policy is enforced at config load; do not silently round. Template fixture files belong on rootfs `/opt/workflow-fixture`, not an unverified `/tmp` mount.
