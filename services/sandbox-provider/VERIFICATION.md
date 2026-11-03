# Provider candidate verification

Executed 2026-11-03 by Sandbox Infrastructure Engineer. Independent QA is a separate gate.

| Check | Actual result |
|---|---|
| Python compilation | `python -m compileall -q provider scripts` passed |
| Real PostgreSQL + fake-runtime API/security/concurrency/recovery suite | 27 passed (PostgreSQL16; dedicated local Provider credential/database) |
| Pinned SDK installation/import | BoxLite0.11.0 CPython3.12 x86_64 manylinux wheel installed/imported; API signatures and tagged upstream source inspected |
| Real BoxLite persistence/isolation | 1 explicitly skipped: `/dev/kvm` is absent on development host |
| Physical host restart | Not run; shared-host reboot not authorized |
| Full registry+VM-volume restore | Not run; no real VM filesystem created |
| Docker build | `docker build -t workflow-sandbox-provider:phase1-candidate .` passed; pinned base, nonroot UID10001, final reviewed source rebuilt successfully |

Test invocation used a process environment `TEST_DATABASE_URL` loaded securely from the lead-created dedicated test DB credential file; no credential is recorded here. Reproduction command from this directory: `TEST_DATABASE_URL=... .venv/bin/python -m pytest -q -rs`.

The 27 passing tests exercise actual PostgreSQL migrations, partial unique active-run index, durable idempotency/fences/audits, API schemas, delegated ownership, denied payloads/profiles, cancellation and timeout, output truncation, log redaction, wrong-owner reads, concurrent duplicate requests, lifecycle and conservative recovery. Runtime behavior is a deterministic fake. Provider restart tests instantiate a new service against the same DB/fake state; they do not prove SDK or host recovery.

Observed local host: Linux x86_64, no `/dev/kvm`. SDK supports ARM64 CPython3.12 wheels, but this does not prove Coolify's execution host or Docker security supports microVMs. No caps/seccomp/privileged relaxation was introduced. Runtime acceptance and Phase2 consumption remain blocked until real stop/start data retention, qualified process/host recovery, disk/resource/network enforcement and isolated restore are demonstrated.

## Restricted container probe

Executed after final security review fixes: `docker build -t workflow-sandbox-provider:phase1-candidate .` succeeded; local image ID `sha256:4d93ebfb38e365483426dc9149dc11813cbb05c98484b9375ea07a121bbdaf4d` (not a registry release digest).

Started the production image on a dedicated local test network with `--cap-drop=ALL --security-opt=no-new-privileges --read-only --tmpfs /tmp:rw,noexec,nosuid,size=32m --pids-limit=128 --memory=256m`, a dedicated named volume at `/var/lib/sandbox-provider`, and loopback-only `127.0.0.1:58003:8000`. Real dedicated PostgreSQL connected successfully. Observed `/health/live`200/processok and `/health/ready`503 with databaseok/runtimeunavailable, as expected without KVM. Container ran UID10001, wrote a marker into its initialized named volume, and confirmed `/app/tests` is absent. All six collected startup/request log lines parsed as JSON; no test bearer token appeared. The disposable container was stopped/removed after this probe. This proves production API packaging and narrow-container filesystem/network behavior, **not BoxLite microVM execution**.

Final suite: `TEST_DATABASE_URL=... .venv/bin/python -m pytest -q -rs` → **27 passed,1 skipped** (no deprecation warnings). Permission scopes, authenticated owner-scoped metrics, destruction after lost runtime response, cancellation fences, and conservative ambiguous-dispatch recovery are included.
