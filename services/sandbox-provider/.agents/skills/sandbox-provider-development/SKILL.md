---
name: sandbox-provider-development
description: Develop and validate the generic FastAPI BoxLite Sandbox Provider, its persistent VM lifecycle, workload profiles and API compatibility.
---

# Sandbox Provider development procedure

For rc.2 file transfer/result completion work, read `docs/contracts/scoped-files-v1.md`. Test the actual guest helper filesystem boundary, chunk replay after partial writes/publication lost acknowledgement, durable pending-operation fencing and stale generation protection. Cloud public1 MiB chunks use64 KiB writes/32 KiB reads with fixed bounded argv. Test mutations even when file size/timestamps remain unchanged: rehash each public read before returning it. SDK loopback remains mocked evidence; consume its client's stdin EOF before closing WebSockets to avoid TCP resets. Keep strict result schemas unchanged. Workload secret references resolve only at dispatch. Use Python3 in approved guest images.

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

## Explicit BoxLite Cloud adapter (2026-11-03)

- `SANDBOX_RUNTIME_MODE=cloud` selects `BoxLiteCloudRuntime`; default `local` preserves KVM behavior. No fallback or public API change. Keep SDK0.11.0 unless compatibility evidence justifies a reviewed version update.
- Required Cloud configuration is HTTPS `BOXLITE_REST_URL`, secret `BOXLITE_API_KEY`, stable nonsecret `BOXLITE_ACCOUNT_SCOPE`; optional routing `BOXLITE_REST_PATH_PREFIX` and bounded `RUNTIME_REQUEST_TIMEOUT_SECONDS`. Readiness must execute an authenticated read, never assume that the SDK import proves Cloud access.
- Cloud profile validation occurs on new creation, not globally: historical immutable profiles must stay available for reads. Cloud memory is whole GiB >=1024MiB, CPU<=16, disk whole GiB. Optional profile `entrypoint`/`cmd` are trusted operator argv only. Keep the packaged profile schema equal to the root contract.
- Preserve migration003 backend binding and creation dispatch fence. Retained operations use persisted returned IDs; missing/ambiguous state must never create a fresh disk. A backend/account change must not reinterpret local or different-account records. Key rotation within the same explicitly bound account is supported.
- Verify returned CPU/RAM, image string, lifecycle and both network directions before execution. SDK BoxInfo cannot attest disk size or resolved OCI digest. Tests of actual guest quotas/network remain separate from wire assertions.
- `tests/test_cloud_runtime.py` executes the real SDK against a loopback HTTP stub; its PostgreSQL cases use the disposable `TEST_DATABASE_URL`. Such passes are mocked runtime evidence, not hosted execution. Full local regression command remains `python -m pytest -q -m 'not real_runtime'` with the dedicated DB.
- Cloud active-execution attachment fails closed with nonretryable `ambiguous_execution` because output replay is not verified. Do not weaken this to an empty successful result. Provider stops the retained box and never resubmits that command. Native result `error_message` also prevents success.
