# Independent Phase 1 QA verification

**Decision: Phase 1 is not approved for Phase 2 consumption.** The API/database candidates pass the executed checks below. Real BoxLite execution, retained VM filesystem recovery, host restart and full registry-plus-disk restoration remain incomplete. No fake runtime result is counted as a microVM result.

Reviewer: independent QA agent, 2026-11-03. Service authors did not write this report or the QA-owned tests. Source was reviewed in isolated worktrees, with a separate disposable QA logical database/credential per service. No operational/staging database was truncated by QA. Original architecture and Phase 1 requirements remain unchanged.

## Executed evidence

| Check | Independently observed outcome | Scope and limitation |
| --- | --- | --- |
| Fresh contract environment | Dependency install succeeded; 5 tests passed, final contract sync 0.718 s | OpenAPI 3.1, schemas, strict negatives and fixture configuration; no running service inferred. |
| Runner clean dependency install | `npm ci` succeeded, 121 packages | Fresh isolated directory containing only package manifest and lock, no existing node_modules. |
| Runner typecheck/build | `npm run typecheck`, `npm run build` passed | Node 22, TypeScript build from service directory. |
| Runner style procedure | `npm run format:check` passed | Actual command listed by development skill exists and passes. |
| Runner complete suite at `11a4af3` | **19 TAP passes**, 0 failures/skips, 11.326 s | 4 unit tests, 14 integration scenarios and their parent. Real PostgreSQL and Graphile Worker; Provider is an HTTP mock. |
| Runner process death | Actual child Runner SIGKILL/restart scenario passed in that suite | Same persisted external mock run/one attempt and recovery audit; no host or BoxLite restart inferred. |
| Provider fresh environment | `pip install -r requirements-dev.lock` succeeded | Independent QA venv, not the author's environment. |
| Provider suite, patched framework `5893a06` | **28 passed, 1 real-runtime skip**, 8.42 s, no warnings | Independent fresh QA environment; real PostgreSQL with injected fake runtime. |
| QA-owned Provider boundaries | **6 passed**, patched-framework rerun 1.57 s | Independent mock implementation and real QA PostgreSQL; includes malformed-Host regression. |
| Installed SDK boundary | 3 passed, final fresh-environment run 0.003 s | Native 0.11.0 interface/option compatibility and expected refusal without KVM; no VM created. |
| Packaged contracts | All three service-local API copies equal authoritative root JSON | Runner API, Runner's Provider client contract, Provider API. |
| External generic HTTP consumer | **10 grouped checks passed**, error null | Real Runner/Provider HTTP processes and independent PostgreSQL databases, explicitly mocked Provider runtime. Trace `qa_fd3d472f08fd4e8f862779e89db429bd`. |
| Runner dependency audit | `npm audit --omit=dev --json`: **0 known vulnerabilities** | Production dependency advisory scan at execution time. |
| Provider dependency audit | Initial 14 records / **7 distinct advisory IDs** in Starlette 0.46.2; patched locks re-audited with **0 known vulnerabilities** | `pip-audit 2.10.1`, full pinned production dependency list. Records included duplicate aliases; not 14 separate defects. |
| Python compilation | `python -m compileall -q provider scripts` passed | Does not prove runtime behavior. |

Service source commits at initial completed review: Runner `8372b37`, then process-death test `11a4af3`; Provider `e91476f`, with security/review followups recorded below. All versions remain `1.0.0-rc.1`.

### Reproducible commands

Run destructive service suites only against a newly created, dedicated QA database. Inject the URL using protected environment configuration; no password is reproduced here.

```sh
python3 -m venv /tmp/workflow-phase1-qa-venv
/tmp/workflow-phase1-qa-venv/bin/pip install -r contracts/requirements-test.txt
/tmp/workflow-phase1-qa-venv/bin/python contracts/tests/test_contracts.py

# From services/job-runner:
npm run typecheck
npm run build
npm run format:check
TEST_DATABASE_URL=<disposable-runner-QA-database> npm test
npm audit --omit=dev --json

# From services/sandbox-provider:
python3 -m venv /tmp/workflow-provider-qa-venv
/tmp/workflow-provider-qa-venv/bin/pip install -r requirements-dev.lock
TEST_DATABASE_URL=<disposable-provider-QA-database> /tmp/workflow-provider-qa-venv/bin/python -m pytest -q -rs
/tmp/workflow-provider-qa-venv/bin/python -m compileall -q provider scripts

# QA-owned tests, service package on PYTHONPATH; same disposable Provider QA DB:
PYTHONPATH=<provider-service-directory> TEST_DATABASE_URL=<disposable-provider-QA-database> \
  /tmp/workflow-provider-qa-venv/bin/python -m pytest -q -c <provider-service-directory>/pyproject.toml tests/qa/test_provider_boundaries.py
/tmp/workflow-provider-qa-venv/bin/python tests/qa/test_sdk_boundary.py

# From Provider directory, using a separate audit tool environment:
pip-audit -r requirements.lock --no-deps --disable-pip --format json
```

`tests/qa/http_probe.py --exercise` reads `QA_RUNNER_URL`, `QA_PROVIDER_URL`, their tokens and an explicit `QA_RUNTIME_KIND`. It imports no service source, validates actual captured responses against the frozen contract, and only destroys the disposable box it created. For delegation, supply `QA_PROVIDER_OWNER`; a direct owner credential omits that header. Never expose a delegation credential in output.

## Independent boundary and lifecycle checks

The QA-owned real-DB suite injects its own `QARuntime` boundary double. New profile IDs `qa-environment:v2` and `qa-new-program:v9` exist only in operator configuration. The service accepts the new profile and literal argv arguments without source edits. This proves configuration/API generality; a mocked executable is not proof that a real OCI image executes it.

Executed checks include invalid Unicode credentials, malformed JSON, 413 body bounds and 415 content types, owner isolation including nested runs/events, overflow event cursors, same-key concurrent submissions and one execution across two Provider service instances using distinct database sessions, durable cancellation fences rejecting 12 delayed execute calls with zero workload dispatches, explicit deletion after a lost runtime-removal response, and read-only identity denial for create/start/stop/execute/cancel/destroy despite profile access. Two service instances in one OS process are not a physical host or actual multi-container runtime test.

The external HTTP consumer independently submitted a queued write, replayed submission and rejected changed reuse, verified durable events, stopped and started the same sandbox, resumed via a new Runner job to read the marker, and explicitly destroyed its own box. Both live/auth negative probes passed. Runner readiness returned 200 with database/queue `ok`; the fake Provider truthfully returned 503 with database `ok`, runtime `disabled`. Every positive lifecycle result in this HTTP run is explicitly **mocked runtime behavior**.

## Review findings and corrections

- **Fixture/runtime mismatch:** the initial 512 MiB template was not supported by whole-GiB BoxLite disks. The reviewed fixture now requests 1024 MiB explicitly and uses retained rootfs `/opt/workflow-fixture`, avoiding an unverified `/tmp` tmpfs. No silent rounding.
- **Ambiguous cancellation side effect:** replaying execute to discover an unknown run could launch a never-received workload after cancellation. Lead approved a generic cancellation-by-reference fence contract. Independent late-execute rejection and Runner cancellation regressions passed.
- **Schedule cancellation race:** DELETE could return cancelled while a worker still performed an external stop. Shared schedule advisory serialization and barrier-based regression now pass.
- **Credential/cursor errors:** Unicode bearer strings raised `TypeError`; unbounded numeric cursors could overflow PostgreSQL bigint. Byte-safe comparison and explicit numeric bounds passed QA-owned negatives.
- **Operation permissions:** initial policy only gated destroy. Explicit read/create/start/stop/execute/cancel/destroy scopes now prevent a read-only token from mutating even when it may access the profile. QA independently verified denial.
- **Destruction ambiguity:** runtime removal could succeed before DB confirmation and make retry fail on missing runtime. A durable destruction intent plus inspected retry/startup recovery now preserves explicit authority and reaches the tombstone; independent removal-success/lost-response retry passed.
- **Framework security:** the old Starlette pin had seven distinct advisory IDs. QA also reproduced unauthenticated malformed Host yielding 503 instead of auth rejection through reconstructed-path confusion. Provider updated FastAPI to 0.162.0 and Starlette to 1.10.0, regenerating locks and using raw ASGI routing path for auth. Retests and clean re-audit are recorded below.
- **Cleanup:** Provider lifespan now uses `try/finally` so exceptions do not leave dispatch/database tasks behind.

No existing application/production resource was changed by QA.

## Acceptance matrix

| Gate | Decision | Evidence still needed |
| --- | --- | --- |
| Versioned schemas and packaged compatibility | Passed for reviewed RC contracts | Final deployed version must match reviewed commit. |
| Independent Runner queue/database behavior | Passed for executed real-DB/mock-Provider suite | Deployed checks separately required. |
| Provider API/database/auth/idempotency | Passed for executed real-DB/mock-runtime checks | Deployed checks separately required. |
| HTTP service integration and correlated durable events | Passed with explicit fake runtime | Real BoxLite end-to-end execution remains required. |
| Runner OS-process restart | Passed with actual child SIGKILL and HTTP mock Provider | Actual deployed process restart is a separate observation. |
| Provider service recovery | Passed at mocked runtime/DB level | Actual BoxLite execution attachment and retained disk recovery. |
| Real BoxLite create/exec/stop/start/same disk | **Blocked** | Qualified execution host and exact container security/device configuration, then marker proof. |
| Two-microVM isolation and applied CPU/RAM/disk/network limits | **Blocked** | Actual BoxLite/kernel enforcement and negative probes. |
| Physical host restart | **Unverified** | Safely authorized restart on an appropriate host; shared production reboot is not authorized. |
| Full registry plus retained VM data backup/restore | **Incomplete** | Restore a coordinated stopped registry/volume pair and prove marker and identities. A DB-only restore is insufficient. |
| Scoped artifact transfer | **Unsupported in this RC** | External `artifact_output_ref` fails explicitly; no adapter or exported artifact is claimed. Consumers receive bounded owner-protected output. |
| Phase 2 readiness | **Not approved** | Complete real-runtime, persistence/isolation/recovery/deployment gates and document artifact-transfer capability needed by the consumer. |

## Exact runtime blocker

On the local Linux x86_64 execution host, `/dev/kvm` is absent. An independent native SDK probe constructing `Boxlite(Options(home_dir=<isolated temporary directory>))` raised:

```text
boxlite.errors.UnsupportedError: unsupported: KVM is not available on this host.
```

The real-runtime test explicitly skipped with `BLOCKED: /dev/kvm is absent on this execution host; real BoxLite cannot start.` Native `BoxInfo.state`, `BoxStateInfo.running`, `Box.exec(...timeout_secs,cwd...)`, `Box.attach(execution_id,stdin)`, and retention option getters exist in the installed SDK. Tagged upstream source describes `detach=True` and `auto_delete=0`; these interface/source observations do not prove actual stop/start or process/host persistence. The Coolify host is different hardware and must be qualified directly; local missing KVM is not evidence that the remote host lacks KVM.

## Final followup and deployed evidence

Framework followup `5893a06` independently passes 28 tests with one explicit real-runtime skip, the six QA-owned boundary tests, and a clean dependency audit. The original framework deprecation warnings disappeared after the pinned upgrade. Runner followup `7dc164c` adds earlier deadline wakeups, schedule quota and cancellation audit identity; affected suite retest is recorded in the next update. Deployed infrastructure checks are pending resource IDs/access. No deployed or host gate is inferred from local results.
