# Provider candidate verification

Executed 2026-11-03 by Sandbox Infrastructure Engineer. Independent QA is a separate gate.

| Check | Actual result |
|---|---|
| Python compilation | `python -m compileall -q provider scripts` passed |
| Real PostgreSQL + fake-runtime API/security/concurrency/recovery suite | 26 passed (PostgreSQL16; dedicated local Provider credential/database) |
| Pinned SDK installation/import | BoxLite0.11.0 CPython3.12 x86_64 manylinux wheel installed/imported; API signatures and tagged upstream source inspected |
| Real BoxLite persistence/isolation | 1 explicitly skipped: `/dev/kvm` is absent on development host |
| Physical host restart | Not run; shared-host reboot not authorized |
| Full registry+VM-volume restore | Not run; no real VM filesystem created |
| Docker build | `docker build -t workflow-sandbox-provider:phase1-candidate .` passed; pinned base, nonroot UID10001; final security fixes require follow-up image rebuild |

Test invocation used a process environment `TEST_DATABASE_URL` loaded securely from the lead-created dedicated test DB credential file; no credential is recorded here. Reproduction command from this directory: `TEST_DATABASE_URL=... .venv/bin/python -m pytest -q -rs`.

The 26 passing tests exercise actual PostgreSQL migrations, partial unique active-run index, durable idempotency/fences/audits, API schemas, delegated ownership, denied payloads/profiles, cancellation and timeout, output truncation, log redaction, wrong-owner reads, concurrent duplicate requests, lifecycle and conservative recovery. Runtime behavior is a deterministic fake. Provider restart tests instantiate a new service against the same DB/fake state; they do not prove SDK or host recovery.

Observed local host: Linux x86_64, no `/dev/kvm`. SDK supports ARM64 CPython3.12 wheels, but this does not prove Coolify's execution host or Docker security supports microVMs. No caps/seccomp/privileged relaxation was introduced. Runtime acceptance and Phase2 consumption remain blocked until real stop/start data retention, qualified process/host recovery, disk/resource/network enforcement and isolated restore are demonstrated.
