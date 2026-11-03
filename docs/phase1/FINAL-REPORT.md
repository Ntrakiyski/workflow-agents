# Phase 1 candidate — implementation and staging acceptance

> **Current Cloud validation, 2026-11-03:** The GCC BoxLite Cloud journey now passed real execution, stop/start file retention, two-box file separation and stopped-box recovery across both service replacements. Full Phase 1 remains incomplete for artifact transfer, active-output recovery and backup/restore. The Worfklow report below is historical. Read [CLOUD-VALIDATION.md](CLOUD-VALIDATION.md) and [readiness.json](readiness.json).

**Decision, 2026-11-03: blocked; neither the combined infrastructure nor Provider v1 is approved for Phase 2 consumption.** Both independently deployable service candidates are implemented, reviewed, pushed and running in the one authorized new Coolify project. Real BoxLite execution is blocked by the actual execution host's missing `/dev/kvm`. Scoped artifact transfer/export is also an incomplete implementation, independent of that hardware blocker. No stable release or Phase 2 implementation is claimed.

Integration acceptance owner: lead Codex agent. Independent review: specialized QA agent plus a separate final read-only acceptance reviewer. The reviewers' executed tests and observations are attributed in [the QA report](../qa/REPORT.md); the final reviewer checked the contract, limitations and GitHub CI without rerunning test suites. [readiness.json](readiness.json) is the machine-readable gate decision.

## GitHub and implementation inventory

Repository: <https://github.com/Ntrakiyski/workflow-agents>. Starting main commit: `3cde455`. Integration branch: `phase1/integration`; the branch contains the merged work and final operational evidence. Application source deployed to both resources is the immutable candidate commit **`df7cc68e6a1d58fc35586b67a3e9cb75cdefe5a8`**. Subsequent commits update evidence and operator probes; they do not silently repin either application. Service/API version is **`1.0.0-rc.1`**, not a released stable v1.

| Isolated branch/worktree | Reviewed final contribution |
| --- | --- |
| `phase1/contracts`, `/home/workflow-agents-worktrees/contracts` | `fea8330` — initial reviewed generic contracts; later reviewed cancellation-fence addition is included in integration |
| `phase1/job-runner`, `/home/workflow-agents-worktrees/job-runner` | `c8dd38d` — Runner implementation and setup-timeout regression |
| `phase1/sandbox-provider`, `/home/workflow-agents-worktrees/sandbox-provider` | `45ed739` — Provider implementation and Coolify health-probe packaging |
| `phase1/qa`, `/home/workflow-agents-worktrees/qa` | `05c1e9d` — independent review, deployed probes and correlated log report |
| `phase1/integration`, `/home/workflow-agents` | `df7cc68` deployed source; `243eaae` initial retention probes; `cc04079` corrected retention probe; final report/evidence in subsequent branch commits |

These are immutable source references for review, not releases. Feature contributions are integrated; no merge to `main` or stable release is claimed.

| Deliverable | Repository location |
| --- | --- |
| Runner source, dependency lock, migrations, tests, production image | `services/job-runner/`, `package-lock.json`, `migrations/001_initial.sql`, `tests/`, `Dockerfile` |
| Provider source, pinned production/development locks, migrations, tests, production image | `services/sandbox-provider/`, `requirements.lock`, `requirements-dev.lock`, `migrations/`, `tests/`, `Dockerfile` |
| Authoritative OpenAPI 3.1 contracts | `contracts/v1/runner-v1.openapi.json`, `contracts/v1/provider-v1.openapi.json` |
| Protocol, lifecycle, delegation, idempotency, events and compatibility | `docs/contracts/v1.md`, `contracts/release.json`; service-local contract copies match |
| Contract generator, fixtures and validation | `contracts/build_contracts.py`, `contracts/tests/test_contracts.py`, `contracts/v1/profiles.schema.json`, `contracts/v1/profiles.template.json` |
| Independent HTTP/security/SDK probes | `tests/qa/http_probe.py`, `staging_probe.mjs`, `test_provider_boundaries.py`, `test_sdk_boundary.py` |
| CI | `.github/workflows/phase1.yml`; real PostgreSQL in isolated service jobs; real-runtime tests explicitly excluded |
| Authoritative deployment configuration and returned resource IDs | `deploy/coolify.phase1.json`, `deploy/profiles.staging.json`, `deploy/staging-resources.json`, `deploy/apply-coolify.mjs` |
| Operator probes and recovery drill | `deploy/provider-inspect.py`, `deploy/verify-staging-retention.mjs`, `deploy/verify-db-restore.py`, `deploy/host-preflight.sh`, `deploy/README.md` |
| Service instructions | `services/{job-runner,sandbox-provider}/AGENTS.md` |
| Runner development/operations skills | `services/job-runner/.agents/skills/job-runner-{development,operations}/SKILL.md` |
| Provider development/operations skills | `services/sandbox-provider/.agents/skills/sandbox-provider-{development,operations}/SKILL.md` |
| Human setup/configuration/recovery and developer evidence | Each service's `README.md`, `.env.example`, `VERIFICATION.md` |
| Assumptions and actual host qualification | `docs/phase1/DECISIONS.md`, `docs/phase1/PREFLIGHT.md` |

Runner uses TypeScript/Node, REST and Graphile Worker with its own PostgreSQL. Provider uses Python/FastAPI, its own PostgreSQL registry and BoxLite 0.11.0 behind `SandboxRuntime`. Approved profiles are external configuration with schema-validated arguments and direct argv execution. Neither service contains application/Document Assistant/Pi/OfficeCLI logic or imports the other service's internals. No substitute workflow platform or runtime was introduced.

Bearer credentials map to actor, owner, scopes and approved profiles. Only explicitly configured service delegates can supply an allowlisted owner header. Durable idempotency rejects changed payloads; cancellation fencing prevents unseen cancelled work from launching; exact persisted execute payloads are reused after ambiguous HTTP results. Stop and explicitly authorized destroy remain separate operations.

## Coolify staging

Project: [workflow-agents-phase1](https://worfklow.org/project/6nshux1lmrsmsfeqar9wess9), UUID `6nshux1lmrsmsfeqar9wess9`. Staging environment: `vulhjgp8rvlruf3rlwchwc6v`. Exactly one new project was created. Coolify automatically added an empty production environment; all four project resources are in staging. Existing projects/resources were not modified.

Server: `qk48swgog4kok0og8848wwg8`; private Docker destination: `a48owkoog444c84oo844wgow` (`coolify`).

| Resource | UUID | Final observed health and deployment |
| --- | --- | --- |
| Application `job-runner` | `hpuishi3ewj80863sqj7wucd` | `running:healthy`; readiness 200, database/queue `ok`; latest replacement deployment `zvzmx90vgdxvcz6nvc9at0hk` finished |
| Application `sandbox-provider` | `v3kixl4u4st8khfpmx2xne7e` | `running:healthy` for **liveness**; actual readiness 503, database `ok`, runtime `unavailable`; latest replacement deployment `vvvwvav3pd3bs6amd7quwsl0` finished |
| PostgreSQL `job-runner-db` | `cbru9p9dh6sucbea2adudwco` | `running:healthy`; database/user `job_runner`, distinct password/storage |
| PostgreSQL `sandbox-provider-db` | `b2d87fuzrb1cpw6noy0kpo48` | `running:healthy`; database/user `sandbox_provider`, distinct password/storage |

Both latest application deployments use `df7cc68e6a1d58fc35586b67a3e9cb75cdefe5a8`. Prior successful deployment IDs were Runner `4hwwoa6l2kpuqs6ynb4lra07` and Provider `sip04dauorpft9dqizdp486k`. Deployment logs of the latest replacements explicitly report removal of the old container and start of the new one. Applications were replaced independently, without a shared compose lifecycle or overlapping Provider writers.

All four resources are private: applications have no FQDN/host port mapping; databases have no public port. Runner calls `workflow-phase1-sandbox-provider:8000` over actual private HTTP. Runner alias is `workflow-phase1-job-runner:8080`. Private bridge connectivity is not network tenant isolation; bearer ownership/profile authorization remains enforced. Runner credentials were actually rejected by Provider PostgreSQL. Each application has only its own database credentials.

The provider volume `v3kixl4u4st8khfpmx2xne7e-workflow-phase1-boxlite`, storage UUID `vblblih6u4dcojluminzocld`, mounts `/var/lib/sandbox-provider`; `BOX_ROOT` is its `boxlite` child. BoxLite SDK registry and disks are retained together in the intended storage layout; the Provider's PostgreSQL registry is a separate database. Real VM disks have not been created on this host. Containers are non-root, drop all Linux capabilities, use `no-new-privileges`, and have configured CPU/memory/PID limits. No privileged mode, host socket, broad bind mount, production reboot or virtualization setting change was used.

Endpoints, profiles/images, database URLs, tokens, limits, retries, timeouts, concurrency, storage, logging and audit retention are externally configured using the service environment/configuration documented in the READMEs and deployment manifest. Sensitive values are held in runtime-only Coolify variables and local ignored mode-600 operator files; no secret values are included in this report or Git deployment definitions.

## Actual host qualification and blocker

The remote Provider diagnostic observed Linux `aarch64`, eight logical CPUs, BoxLite SDK `0.11.0` and UID `10001`. The mounted volume had approximately 73.4 GB available; the host memory sample reported 16,333,647,872 total bytes and approximately 9.78 GB available. These are point-in-time observations, not reserved capacity. Application volume writes and private database/HTTP connectivity passed.

Crucially, the actual Coolify Docker daemon refused the original narrow device mapping during deployment `gpldydq3pasenqyhkbdlhwfu`:

```text
error gathering device information while adding custom device "/dev/kvm": no such file or directory
```

This establishes a host device prerequisite failure, rather than inferring host state from an unconfigured container. Device mapping was removed for API diagnostics. The production entrypoint still uses the real BoxLite adapter; it has no fake fallback and reports runtime unavailable. Installing/importing the compatible ARM64 wheel does not prove a microVM works. Hardware virtualization usability, SDK security/device behavior and guest resource/network/filesystem restrictions remain unqualified until an authorized host exposes usable KVM.

The first Runner deployment also failed a generated Coolify healthcheck because curl/wget was absent. Both Dockerfiles were corrected, rebuilt and probed; subsequent staging deployments and health checks passed. This packaging failure is resolved. No alternative runtime or elevated container workaround was used for the KVM failure.

## Executed validation and limits

| Evidence | Actual outcome | What it proves |
| --- | --- | --- |
| Independent contract suite | 5 passed | OpenAPI/schema/fixture and strict-negative validation; local copies match frozen contracts |
| Runner suite | 21 TAP passes, no failures/skips | 5 units + 15 real PostgreSQL/Graphile scenarios and their parent; Provider HTTP behavior mocked |
| Runner actual OS-process death | SIGKILL/restart passed within suite | Same persisted mock run, one attempt, recovery audit; no BoxLite inference |
| Provider suite | 30 passed, 1 explicit real-runtime skip | Real PostgreSQL with injected fake runtime; API/auth/locking/lifecycle/recovery logic |
| Independent extra boundary/SDK tests | 6 boundary + 3 SDK checks passed | Security regressions and installed SDK interfaces; no VM created |
| Production builds/restricted probes | Both passed | Pinned Docker builds, non-root restricted containers and honest health behavior |
| Dependency advisory scans | npm production and patched Provider pip-audit: zero known vulnerabilities at scan time | Provider framework advisories were fixed; not a guarantee of no security defects |
| Lead external local HTTP consumer | 7 grouped checks, 24 Runner + 12 Provider calls passed | Actual HTTP/independent DBs; fake runtime, recorded in `LOCAL-HTTP-EVIDENCE.txt` |
| Independent external local HTTP consumer | 10 grouped checks passed | New configured fixture profiles without service source edits; lifecycle/marker behavior remains mocked |
| Independent deployed private HTTP probe | 8 groups passed; real-runtime group blocked, error null | Frozen response schemas, auth/metrics, negatives, dedupe, cancellation, delayed work and bounded unavailable-runtime failure |
| Independent remote log review | 60 Runner + 15 Provider correlated JSON records | Structured fields, actor/owner and safe failures; bounded samples exclude credentials/payload/output keys |
| Remote container replacement probes | Passed after correcting a probe assertion | Prior Runner jobs/audits, Provider pending creation/audits and application volume marker survive independent replacement; wrong-owner 404 and cross-DB credential rejection |
| Local logical restore drills | All 11 Runner and 6 Provider tables match counts and deterministic row-content digests | Disposable DB restore including audit data; not a Coolify snapshot or VM-disk restore |
| Actual microVM and host reboot | Not executed successfully | KVM gate blocked; shared-host reboot was not authorized |

The deployed runtime job `job_ac20bb3c-ef6d-4b59-90ec-1831cd64a8a4` truthfully reached `timed_out` with safe `deadline_exceeded` and zero workload attempts because sandbox setup was unavailable. The same sandbox identity `sbx_5cc5addda69042bb8fcb3de81f1f4b62` was retained across retries and replacement as **pending `creating` with `runtime_unavailable`**, not a running VM or terminal failed sandbox. A `sandbox.failed` audit describes the failed operation, not a lifecycle transition to terminal failure.

The first retention probe incorrectly asserted a terminal failed sandbox and stopped before the remaining checks. Independent source/contract review confirmed the correct pending-state behavior. The corrected probe at `cc04079e78e24efd79460b30f3cb2125a394d3ba` passed via task `zr5fsxdasute5iasg2rkirsm`. Both original failure and corrected result are preserved in [DEPLOYED-RETENTION-EVIDENCE.json](DEPLOYED-RETENTION-EVIDENCE.json). No service code changed to satisfy that probe.

After Provider replacement, the application-volume marker survived, the registry still contained one sandbox and four audit rows, and first audit ID `evt_8323624f06f74af98912574c4f8029e1` matched before/after. After independent Runner replacement, the cancelled and timed-out jobs retained their states and durable events. **This is application/DB retention proof, not BoxLite disk persistence or execution reattachment.**

Audit/log trace: `qa_staging_3e90547fbb284ee8b93779fb069e18e1`. The independent deployed probe verifies authorized audit identities and event types; [DEPLOYED-QA-EVIDENCE.json](DEPLOYED-QA-EVIDENCE.json) and [independent log review](../qa/DEPLOYED-LOG-REVIEW.json) contain sanitized results. Audit tables are append-only and durable; IDs/tombstones are retained for resource lifetime. Service test reports detail retries, cancellation fencing, duplicate admission, concurrent execution, schedule races and conservative ambiguity handling.

GitHub [CI run 41630899023](https://github.com/Ntrakiyski/workflow-agents/actions/runs/41630899023) passed at the exact deployed commit. [Run 41631515482](https://github.com/Ntrakiyski/workflow-agents/actions/runs/41631515482) passed at evidence/probe commit `243eaae`. These are contracts, real-DB Runner and real-DB/mock-runtime Provider CI, not hardware qualification. The final branch/PR checks are separately visible in GitHub.

## Backup, recovery and release work still required

Daily host-local PostgreSQL backup schedules are configured with seven-backup retention: Runner `wbvt7ycjaxj49xoeowmicmah` at 02:10 UTC; Provider `krsnu4wl5mlvawjgoxexftqj` at 02:20 UTC. A successful scheduled remote backup execution is not claimed from configuration alone. No off-host destination is configured. Local disposable `pg_dump`/`pg_restore` drills succeeded and preserved both table counts and content, including audit data; see the two `*-db-restore-evidence.txt` files.

Recoverable persistent deployment still requires an encrypted off-host copy and a coordinated stopped Provider registry plus entire BoxLite volume recovery set. [Deployment recovery instructions](../../deploy/README.md) require draining work, non-destructively stopping boxes and the Provider writer, capturing the database and volume with SDK/image/version metadata, and testing restore on an isolated authorized KVM host. A volume or registry-only dump is not a VM backup. Missing retained disks must fail for operator recovery rather than recreate an empty sandbox.

The following gates remain open before a stable release and Phase 2 consumption:

1. Provide an authorized KVM-capable execution environment or explicitly authorize prerequisite work elsewhere. No new host was provisioned and no shared-host virtualization settings were changed. Requalify the exact non-privileged deployment with narrow device access and standard SDK restrictions.
2. Execute the real generic write → stop without destroy → start same box → read/second command flow through both HTTP services. Prove dedupe/retries, two-box filesystem isolation and actual CPU/RAM/disk/network enforcement, with correlated logs/audits.
3. Restart Provider against actual retained disks and verify reattachment; repeat Runner recovery with real execution. Safely authorize and execute host-restart recovery before relying on long-lived persistent environments. Current application replacements do not satisfy these VM gates.
4. Implement and independently test a generic bounded **scoped artifact transfer/export adapter** and its configuration. This RC rejects nonempty `artifact_output_ref` with 422 before execution and returns bounded owner-protected inline output; it does not transfer/export files. This is a separate implementation gap, not caused by missing KVM. Preserve reviewed contract/security boundaries when completing it.
5. Configure off-host backups and prove coordinated registry/VM-volume restoration with marker and runtime identity retained. Host-local schedules and local logical DB restore tests cover only part of recovery.
6. Rerun affected regressions, independent real/deployed acceptance and security checks, then release pinned stable service artifacts and update the machine-readable gate record. Until then `/v1` is an implementation-frozen RC contract and neither candidate is an accepted stable dependency.

No React UI, application backend, business-specific workflow, Pi integration, OfficeCLI integration, LiteLLM service or Phase 2 change was implemented.
