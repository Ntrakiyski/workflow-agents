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
| Runner complete suite at `c8dd38d` | **21 TAP passes**, 0 failures/skips, 13.320 s | 5 unit tests, 15 integration scenarios and their parent. Real PostgreSQL and Graphile Worker; Provider is an HTTP mock. |
| Runner process death | Actual child Runner SIGKILL/restart scenario passed in that suite | Same persisted external mock run/one attempt and recovery audit; no host or BoxLite restart inferred. |
| Provider fresh environment | `pip install -r requirements-dev.lock` succeeded | Independent QA venv, not the author's environment. |
| Provider suite, configurable concurrency `d002875` | **30 passed, 1 real-runtime skip**, 7.32 s, no warnings | Independent fresh QA environment; real PostgreSQL with injected fake runtime. |
| QA-owned Provider boundaries | **6 passed**, patched-framework rerun 1.57 s | Independent mock implementation and real QA PostgreSQL; includes malformed-Host regression. |
| Installed SDK boundary | 3 passed, final fresh-environment run 0.003 s | Native 0.11.0 interface/option compatibility and expected refusal without KVM; no VM created. |
| Packaged contracts | All three service-local API copies equal authoritative root JSON | Runner API, Runner's Provider client contract, Provider API. |
| External generic HTTP consumer | **10 grouped checks passed**, error null | Real Runner/Provider HTTP processes and independent PostgreSQL databases, explicitly mocked Provider runtime. Trace `qa_fd3d472f08fd4e8f862779e89db429bd`. |
| Runner dependency audit | `npm audit --omit=dev --json`: **0 known vulnerabilities** | Production dependency advisory scan at execution time. |
| Provider dependency audit | Initial 14 records / **7 distinct advisory IDs** in Starlette 0.46.2; patched locks re-audited with **0 known vulnerabilities** | `pip-audit 2.10.1`, full pinned production dependency list. Records included duplicate aliases; not 14 separate defects. |
| Python compilation | `python -m compileall -q provider scripts` passed | Does not prove runtime behavior. |
| Independent logical backup/restore | Runner 11 tables and Provider 6 tables restored to temporary isolated local databases; both drills exit 0 | All table counts and deterministic row-content digests matched, including Runner 91 and Provider 31 audit rows. No VM disks included. |
| Deployed private HTTP consumer | **8 grouped checks passed, 1 real-runtime block, error null** at `df7cc68` | Exact QA-owned Node probe executed in Runner container; HTTP calls cross private network. Provider uses real unavailable BoxLite adapter; no fake VM. |
| Independent deployed correlated log review | **60 Runner + 15 Provider** JSON records match the deployed probe correlation | Bounded 250-line sample/service; structured fields and actor/owner/error classifications verified, no credential/payload/output keys. See `DEPLOYED-LOG-REVIEW.json`. |

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
- **Unavailable setup timeout:** an independent real-HTTP probe against the real unavailable BoxLite adapter found a `timed_out` job with no safe terminal error (`attempt_count: 0`, since setup failed before any workload attempt). Runner `c8dd38d` adds centralized `deadline_exceeded` classification; its new dedicated real-DB regression and the full independent suite pass. This does not pretend a workload attempt was dispatched.

No existing application/production resource was changed by QA.

## Acceptance matrix

| Gate | Decision | Evidence still needed |
| --- | --- | --- |
| Versioned schemas and packaged compatibility | Passed for reviewed RC contracts and captured deployed HTTP responses | Versions remain release candidates. |
| Independent Runner queue/database behavior | Passed for real-DB/mock-Provider suite and deployed unavailable-runtime checks | A successful actual BoxLite workload remains required. |
| Provider API/database/auth/idempotency | Passed for real-DB/mock-runtime tests and deployed negatives/private HTTP setup failure | Actual VM lifecycle behavior remains required. |
| HTTP service integration and correlated durable events | Passed with explicit fake runtime locally; actual unavailable BoxLite failure verified deployed | Real BoxLite successful end-to-end execution remains required. |
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

Provider followup `d002875` independently passes **30 tests and one explicit real-runtime skip**, including externalized bounded execution concurrency. The six QA-owned boundary tests and clean dependency audit also passed after the framework upgrade. Runner `c8dd38d` independently passes **21 TAP tests**, typecheck, build and formatting checks, including early deadlines, schedule quotas, cancellation identity, redacted startup/configuration failures and safe setup timeout errors.

Independent read-only review of the **remote** Coolify Provider deployment `gpldydq3pasenqyhkbdlhwfu` (commit `99203a5005450be1ef6b84653ee3fca13407d41c`) confirmed Docker failed at `2026-11-03T11:45:59.501746Z`: `error gathering device information while adding custom device "/dev/kvm": no such file or directory`. This is host-specific evidence; no local-host inference is used. It blocks real BoxLite deployment on that host under the authorized device-only container configuration. No alternate runtime or privileged-container workaround is accepted.

Independent read-only Coolify inspection confirmed new project `workflow-agents-phase1` (`6nshux1lmrsmsfeqar9wess9`), staging environment `vulhjgp8rvlruf3rlwchwc6v`, two independent applications and two healthy private PostgreSQL databases with separate database/user identities. No app FQDN or public DB port was configured. Coolify also automatically created an empty production environment. Initial application deployment failed; the first Runner failure was a generated health command needing absent curl/wget. Service image followups add curl while retaining non-root execution.

At approximately 11:50 UTC, QA independently observed both application containers `running:healthy`, configured at Git commit `8dd4e8fabfda702a426124b423fd4d6e9aae5ec3`. Final deployment records subsequently show Runner `4hwwoa6l2kpuqs6ynb4lra07` and Provider `sip04dauorpft9dqizdp486k` finished at commit `df7cc68e6a1d58fc35586b67a3e9cb75cdefe5a8`. Provider health monitoring uses **liveness**; a green container does not imply runtime readiness. Both applications have `cap-drop=ALL`, `no-new-privileges`, PID limits, no FQDN and no host port mappings. Both private databases are `running:healthy`, with different names/users (`job_runner` and `sandbox_provider`) and no public port. Provider named volume `v3kixl4u4st8khfpmx2xne7e-workflow-phase1-boxlite`, storage UUID `vblblih6u4dcojluminzocld`, mounts `/var/lib/sandbox-provider`; no host bind mount/file storage was present. This configuration is not proof of retained microVM data.

Actual container logs independently retrieved from both applications contain JSON timestamp, service, correlation ID, action, duration and outcome fields. The sampled Runner health requests show 200; Provider liveness requests show 200. No access tokens or workload arguments appeared in those sampled health logs; this bounded sample is not a claim about every possible log path.

`tests/qa/staging_probe.mjs` is an independent private-network consumer designed to execute inside the Runner image using existing runtime environment credentials. It validates captured JSON against the packaged frozen OpenAPI documents via Ajv2020/formats and imports no service source. It never prints credentials, payloads, outputs or third-party exception contents. Its positive unavailable-runtime path requires truthful Provider 503 and a bounded failed/timed-out Runner job, with a durable safe error and audit events. A separate conditional branch requires actual same-sandbox marker preservation before labelling any result real. Source presence or local syntax checks do not count as deployed execution.

After the timeout-classification fix, QA executed the entire Node probe locally against its own real HTTP processes, real separate QA PostgreSQL databases, the real BoxLite adapter and unavailable native KVM. Result: **eight grouped checks passed, one real-runtime gate explicitly blocked, error null, exit 0**. Trace: `qa_staging_233e58570c014076b89fca236052726d`. Runner returned readiness 200 with database/queue `ok`; Provider readiness 503 with database `ok` and runtime `unavailable`. The runtime job terminated `timed_out`, workload attempts 0, safe error `deadline_exceeded`; durable events were submitted, dispatched, cancellation_requested and timed_out. This is actual unavailable-runtime integration behavior, with no fake VM, and is still **local** evidence rather than the pending deployed run.

Independent GitHub inspection confirmed [CI run 41630899023](https://github.com/Ntrakiyski/workflow-agents/actions/runs/41630899023) succeeded at `df7cc68e6a1d58fc35586b67a3e9cb75cdefe5a8`, including contracts, Runner installation/typecheck/test/build and Provider locked installation/tests. Provider CI explicitly uses `-m 'not real_runtime'`; green CI does not qualify BoxLite.

### Deployed private HTTP and independent log confirmation

The lead executed the exact QA-owned `staging_probe.mjs` (SHA-256 `c344f35f63f175e81c7be91a81e93a6f0fab07a8bd75911c6fd41a62217142d1`) via Coolify task `xhmf4uebnfbixqfk4eprhadg` inside `workflow-phase1-job-runner`. QA independently observed that task's command/container configuration in the read-only task listing. The one-off task was automatically deleted before a subsequent execution-history read; QA therefore attributes execution-output capture to the lead and independently confirms the matching service behavior through remote logs. Output is retained in `docs/phase1/DEPLOYED-QA-EVIDENCE.json` by the lead.

Result: **8 grouped passes, one explicit real-runtime block, stage complete, error null**. Correlation `qa_staging_3e90547fbb284ee8b93779fb069e18e1`. Runner readiness: 200, database/queue `ok`. Provider readiness: 503, database `ok`, runtime `unavailable`. Checks include frozen response schemas, authentication and metrics protection, strict input/denied profiles, caller owner-spoof rejection, second-owner 404 isolation, same-key replay and changed-body conflict, future job not dispatching early, cancellation with authorized audit identity, future schedule cancellation and bounded setup timeout. Runtime job `job_ac20bb3c-ef6d-4b59-90ec-1831cd64a8a4` finished `timed_out` with `deadline_exceeded` and zero workload attempts. A failed setup is not a successful execution.

Independent remote log reads returned 60 Runner and 15 Provider records matching that correlation. All have timestamp/service/correlation/action/duration/outcome. Runner logs confirm authorized actor `staging-client`, owner `staging-fixture`, second-owner 404s, schedule creation/cancellation and terminal timeout at `11:53:14.640Z`. Provider logs confirm delegate actor `job-runner`, the same owner, creation intent and repeated `runtime_unavailable` failures against the same registry sandbox `sbx_5cc5addda69042bb8fcb3de81f1f4b62`; setup retries did not allocate another registry identity. The bounded samples have no credential/header/payload/arguments/stdout/stderr fields. Sanitized operational samples and check counts are in `docs/qa/DEPLOYED-LOG-REVIEW.json`.

This verifies deployed private service connectivity, durable Runner events and truthful unavailable-runtime behavior. It does not prove a running VM, retained VM filesystem, Provider attachment after restart, kernel isolation/resource enforcement, physical host recovery or restoration of a VM disk. Phase 1 remains **not approved for Phase 2 consumption** until those runtime gates are completed on qualified authorized hardware.
