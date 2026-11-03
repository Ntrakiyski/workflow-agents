# Provider candidate verification

## Hosted transfer transport, descendants and deletion reconciliation (2026-11-03)

Latest full command with dedicated disposable local PostgreSQL16:
`python -m pytest -q -m 'not real_runtime'` → **75 passed,1 deselected in19.57s**.
The deselected case requires local KVM. The suite includes actual pinned SDK
loopback1 MiB fragmented writes/reads, exact-ID eventual deletion polling,
same-box cancellation, and mutation detection when same-size writes retain
the same timestamp. Runtime calls in this suite remain mocked.

Actual hosted evidence is separately retained in
`docs/release/cloud-transfer-journey.json` and
`docs/release/cloud-cancellation-descendant.json`. It uses new disposable local
databases and a private local Provider against BoxLite Cloud, without GCC
deployment or host reboot claims. File checkpoint/reupload is distinct from
forensic registry restore and from a coordinated whole-environment backup.
Exact test sandbox cleanup is required; any pending cleanup remains a failure.

## rc.2 scoped transfer and explicit Cloud completion (2026-11-03)

From the merged main baseline `3f550ba95ca684aeea29a630675d33040724a961`:

- Provider suite with a dedicated actual PostgreSQL16 database: `python -m pytest -q -m 'not real_runtime'` returned **69 passed,1 deselected in16.50s**. Only the local hardware/guest test was deselected. Runtime behavior remains fake/local-process/SDK-loopback, not hosted Cloud.
- Contract suite: **6 passed**. It validates existing strict wire shapes, additive file endpoint bounds/path negatives and runtime-only secret references. Contract/profile generators were rerun deterministically; all packaged copies match.
- Actual filesystem helper checks cover chunk replay, interrupted partial writes, checksum validation, immutable publication after lost acknowledgements, relative-path restrictions, symlink/hardlink/FIFO rejection and reads. Real-PostgreSQL API tests cover owner/permission isolation, idempotency, busy sandboxes, durable interrupted-transfer fencing and same-box recovery without workload replay.
- The actual pinned SDK0.11.0 against a loopback HTTP/WebSocket stub successfully carried **1 MiB stdin upload and1 MiB download response**. This verifies transport framing and bounded JSON, not BoxLite Cloud guest behavior.
- Local-process Cloud wrapper tests cover silent children, nonzero child exits, large concurrent stdout/stderr with explicit truncation, retained completion journals, missing envelopes, wrong nonces/checksums and native transport errors. After adding exact-secret redaction before guest journal emission, the focused wrapper suite returned **8 passed in0.40s**.
- Runtime-only secret regression proves references alone persist in run snapshots, exact secret strings are redacted before result persistence, and missing secrets prevent dispatch. Python compilation and `git diff --check` passed.

No hosted deployment, Cloud transfer, active-command reattachment, VM export, coordinated restore, host reboot or broader resource/security gate was executed by this implementation worker. Provider rc.2 remains a candidate; independent hosted qualification and readiness evidence belong to integration QA. Active attach still truthfully reports nonretryable `ambiguous_execution` and never replays uncertain work.

Executed 2026-11-03 by Sandbox Infrastructure Engineer. Independent QA is a separate gate.

## Explicit hosted Cloud adapter regression (latest)

Executed from the isolated `phase1/cloud-provider` worktree on2026-11-03:

```sh
TEST_DATABASE_URL=... /tmp/workflow-provider-qa-venv/bin/python -m pytest -q -m 'not real_runtime'
```

Result: **53 passed,1 deselected in13.26s**. The deselected case is the separate
local KVM test, not a Cloud pass. PostgreSQL16 ran in the existing dedicated
local test container, against a newly created disposable database
`workflow_cloud_provider_tests`; credentials were read into the child process
environment and never printed. This is not a staging/production database.

Ten Cloud adapter cases use actual pinned BoxLite0.11.0 against a loopback HTTP
stub. They cover modern retention fields, explicit denied inbound/outbound,
CPU/RAM/disk request serialization, fixed entrypoint, no public port/tunnel,
stop transition polling, SDK close without deletion, identity reuse by a fresh
adapter, explicit deletion, failed-create no replay, durable creation fence in
real PostgreSQL, mismatched backend refusal without Cloud calls, metadata drift,
authorization refusal, missing retained identity, key rotation/account binding,
historical small-profile refusal, active-execution attach refusal and rejection
of error-bearing exit0 results. The remaining suite validates API/DB behavior
with its deterministic fake runtime. No VM or hosted disk exists in these tests.

Cloud dependencies remain pinned at0.11.0; neither lockfile changed. Python
compilation and `git diff --check` passed. The integration owner separately ran
real authenticated Cloud fixture operations and owns deployment evidence; this
developer report does not count those as commands executed by this agent.
Active-command output recovery, fresh-stream disconnect replay, full Cloud disk
backup/restore and Cloud physical-host restart remain unverified/blocked. The
local GCC bubblewrap failure is preserved below as historical evidence.

An additional forced-interleaving real-PostgreSQL regression ran separately:
`tests/test_cloud_runtime.py::test_concurrent_fenced_observer_cannot_poison_first_create_authority`
→ **1 passed in0.69s**. It pauses the first request after its durable creation
fence, lets another request observe absence and return `ambiguous_creation`,
then resumes the original dispatch authority. The registry remains `creating`
until exactly one external create succeeds, after which it becomes `running`;
the observer cannot poison the original request or trigger another create.

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

## Dependency advisory remediation

Independent QA identified 14 advisory records (seven distinct PYSEC IDs) against initially pinned Starlette0.46.2. Updated to actual PyPI compatible FastAPI0.162.0 and Starlette1.10.0, regenerated both complete locks, and switched auth boundary to raw `request.scope['path']`. `pip check` passed. Full regression now **28 passed,1 skipped** (the real KVM gate).

Rebuilt production image and repeated the same restrictive container probe with patched dependencies. Observed latest local image `sha256:2a79d8898833a1196da2f5d061da85494ff5cc09c033ed4d81b755c316987312`, live200, DBok, runtimeunavailable503, malformed-Host unauthenticated request401, authenticated metrics200, UID10001, test modules excluded, and all eight log lines valid JSON. The named-volume marker written by the previous disposable container was retained after container recreation; this proves the application volume setup, **not microVM filesystem preservation**. Independent QA owns the fresh advisory audit result.

Operator concurrency qualification: added external `MAX_CONCURRENT_RUNS` (default4, range1..4) after QA identified the fixed dispatch capacity. A two-sandbox real-DB/fake-runtime regression proves a configured limit1 serializes executions, and invalid capacities are rejected before startup. Latest full suite: **30 passed,1 skipped** (real KVM remains blocked).

## Coolify health-probe compatibility

Lead observed the actual Coolify daemon reject `/dev/kvm` mapping with `no such file or directory`; real host microVM execution is blocked. Added `curl` plus CA certificates for Coolify's generated health probe while retaining nonroot UID10001, pinned base and restricted container options. Docker rebuild succeeded. An actual production-container `curl -fsS http://127.0.0.1:8000/health/live` returned200, while `/health/ready` returned503 for unavailable KVM, as required. Curl reports Debian7.88.1 (security-maintained package). Latest local candidate image `sha256:96a7d416d66d92df44908be8042b28d3d29cfb2043c971c224d880a9c5e21541`. No DB suite repeat was needed for this Dockerfile-only packaging change; previous30-pass/1-skip suite remains the code evidence.

## GCC runtime qualification tooling

Added `scripts/qualify_runtime.py`, a production-dependency-only operator CLI,
and eight focused tests. Actual local command:
`/tmp/workflow-provider-qa-venv/bin/python -m pytest -q tests/test_qualification.py`
returned **8 passed in0.29s**. These verify cleanup/refusal/replay boundaries with
the test runtime, separate stopped-marker phases, profile/session identity,
secret-safe error output, and a real-adapter missing-KVM negative. No microVM
was created locally and no new real-runtime acceptance is claimed.

The probe uses a separate SDK home inside persistent storage so it cannot
concurrently open the API writer's home. Explicit session UUIDs make scheduled
replay safe, and cleanup can touch only this session's previously absent box
names with matching retained identities. Lifecycle includes cleanup;
prepare/verify retain stopped boxes for an independently recorded replacement.
Actual GCC results and service-level recovery remain the integration owner's
responsibility. No privileges or host security settings were relaxed.

## Non-root KVM group compatibility

Lead observed Coolify reject its `--group-add` custom option. Added optional
Docker build argument `KVM_GID`, validated as a positive numeric group ID, with
supplementary membership on the existing provider account and `USER provider`.
The host-specific group is not hardcoded in source. Actual local production
build with `--build-arg KVM_GID=993` succeeded; an ephemeral container under
`--cap-drop=ALL --security-opt=no-new-privileges:true --read-only` printed
`uid=10001(provider) gid=10001(provider) groups=10001(provider),993(provider-kvm)`.
The default build also succeeded and printed only group10001. A build with
`KVM_GID=0` was rejected. These are actual image permission probes, not KVM or
VM execution tests. Final focused config/operator safeguard command returned
**12 passed in0.29s**; Python compilation and CLI help also passed.

Real GCC create failed after KVM device/group access succeeded. Added explicit
operator `--diagnostics` to capture a bounded redacted exception chain and a
private mode600 redacted traceback without weakening service errors or runtime
security. A new focused test proves configured credential, marker payload and
profile-environment secret redaction while retaining an errno/exception cause;
the existing default-mode test verifies no diagnostic file is written. Focused
operator/config tests: **13 passed in0.34s**; Python compilation passed. Actual
GCC exception diagnosis remains with the lead's fresh-session invocation.
