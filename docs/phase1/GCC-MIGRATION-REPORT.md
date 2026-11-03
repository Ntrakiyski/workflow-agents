# GCC migration and current Phase 1 status

> **Current Cloud validation, 2026-11-03:** Cloud-backed GCC execution and stopped-box retention now passed. This preserved migration/local-runtime report records the earlier namespace blocker; it does not describe the active Cloud backend. Read [CLOUD-VALIDATION.md](CLOUD-VALIDATION.md) and [readiness.json](readiness.json).

2026-11-03. **Migration complete; Phase 1 remains blocked for Phase 2 consumption.** The authorized move preserved historical database state and audit records. Real BoxLite creation fails under current namespace security restrictions; no successful microVM or retained guest filesystem is claimed.

## Active deployment

Coolify: <https://hosting.gccssofia.com>. Project [workflow-agents-phase1](https://hosting.gccssofia.com/project/ptombcqslsfcmfufdui4vk1z), staging `tiiebld0vegfeegaapo3cdt3`. One project was created in GCC for Phase 1; its automatic production environment is empty.

| Resource | UUID | Observed state |
| --- | --- | --- |
| job-runner | `yf0aaiivjr9k3qqaiawnlz8d` | running:healthy |
| sandbox-provider | `b4safsmcuzzqdmgn7jqt7m8d` | running:healthy for liveness; real execution blocked |
| job-runner-db | `5alfx46nkf9d1vfzdivdybqh` | running:healthy |
| sandbox-provider-db | `vv6xrcopkfiry4naqltlvlfg` | running:healthy |

Both apps actually deployed commit `60a49dbc52121126e8e214c1a774ae627d8ed5f4`, version `1.0.0-rc.1`. Latest successful replacements: Runner `e2gbbywa27gpqvmkjg2uiqcy`, Provider `tr3zcg6hkhz7if6xbhaoakm3`. Subsequent branch commits contain operator helpers/evidence and do not silently repin apps. Integration branch: `phase1/integration`; draft PR: <https://github.com/Ntrakiyski/workflow-agents/pull/1>. No stable release or main merge is claimed.

Apps have no public domain or host port mapping; databases have no public ports. Runner reaches Provider over configured private HTTP aliases. Separate database users/passwords/volumes are retained. The shared Coolify bridge is not a dedicated tenant isolation boundary. See [final-config.json](gcc-evidence/final-config.json).

Provider's named volume `b4safsmcuzzqdmgn7jqt7m8d-workflow-phase1-boxlite` mounts `/var/lib/sandbox-provider`; SDK state/disks belong beneath it, with one writer. Both apps run non-root, drop all capabilities and use no-new-privileges. Only Provider receives `/dev/kvm`. Build argument `KVM_GID=993` supplies its supplementary group because Coolify filtered `--group-add`. No privileged/unconfined mode, Docker socket, broad host mount, host security change or reboot was used.

Configured ceilings: Runner0.5CPU/384MiB, Provider1.5CPU/2048MiB, each database0.25CPU/256MiB. Execution concurrency starts at1. These are limits, not reservations or a sustained-capacity qualification.

## Preserved data and source deletion

| Service | Actual destination restore | Preserved state |
| --- | --- | --- |
| Runner |11tables,38rows,4sequences; exact row counts/digests |2jobs,1cancelled schedule,9audits,3idempotency records, Graphile/schema metadata; no queued work |
| Provider |6tables,8rows,1sequence; exact row counts/digests |1pending creation intent,4audits,1idempotency record,2migration records; no runs/runtime identity |

Authenticated encrypted archives preserve bigint/timestamp precision. Payloads and decrypted copies remain private, ignored by Git and mode600. Only semantically matching bootstrap migration timestamps were reconciled. Audit triggers stayed enabled. Disposable real-PostgreSQL validation passed idempotent replay, tamper rejection, conflicting-destination rejection and append-only protection. Sequence restoration is not transactional: targets must stay quiescent until successful return.

Source/destination manifests and remote successful restore executions are in [gcc-evidence](gcc-evidence/). QA independently compared every table count and digest. Private HTTP checks found the original job IDs, Provider intent and audits, wrong-owner404 and rejected cross-database credentials. These passed again after independent replacement of both GCC apps. This proves database/application retention, not VM recovery.

Worfklow had no usable KVM, no allocated runtime ID and no runs. The adapter rejects initialization before opening BoxLite when KVM is unavailable. No working VM disk was available to migrate. Its volume had a deployment fixture marker; contents were not directly enumerated/copied before deletion. Logical archives do not contain filesystem data.

After destination verification, source apps were stopped. Immediate membership checks confirmed exactly our four resources plus an empty production environment. Only these resources were deleted with `delete_volumes=true`, `docker_cleanup=false`, `delete_connected_networks=false`. Their two backup schedules were removed, followed by empty project `6nshux1lmrsmsfeqar9wess9`. All four resources and project subsequently returned404; independent QA confirmed this. See [source-deletion.json](gcc-evidence/source-deletion.json). Physical volume removal was requested through Coolify but was not independently enumerated through host SSH. No shared network/image pruning was run.

Temporary export/restore/diagnostic schedules and archive envelope variables were removed; both apps were replaced after envelope removal. Historical source manifests remain under `deploy/archive/worfklow-2026-11-03/` and are not active targets.

## Confirmed runtime blocker

The actual restricted GCC Provider has KVM read/write access, SDK0.11.0, UID10001, groups993/10001, zero effective capabilities and enabled seccomp/no-new-privileges. GCC resolves Worfklow's missing-device prerequisite.

Two real BoxLite creation attempts failed before a VM started. Diagnostic session `9b5b67c04a724235bf558a797f632483` pulled the approved image, prepared rootfs/COW storage, then failed at `vmm_spawn`:

```text
bwrap cannot create user namespaces
clone(CLONE_NEWUSER) errno: 1 (Operation not permitted)
```

SDK diagnostics detect AppArmor's unprivileged-user-namespace restriction and a missing profile for bundled bubblewrap. Docker default seccomp can also deny namespace calls; each policy's exact contribution has not been isolated. The failed box was explicitly removed; no live qualification boxes remain. See [native-runtime-log.json](gcc-evidence/native-runtime-log.json) and [independent review](../qa/GCC-NATIVE-LOG-REVIEW.json).

Installing bubblewrap in the image alone does not qualify this environment. A reviewed Provider-specific AppArmor/seccomp policy and approved deployment test are the next runtime steps; see the Provider README. No SDK security-disable or host-wide sysctl workaround was applied.

**Known health defect:** Provider readiness currently checks KVM API access, SDK version and DB connectivity. It can return200 while bubblewrap initialization fails. Treat it as prerequisite evidence until a bounded namespace preflight is implemented. Running/healthy and readiness200 do not satisfy runtime acceptance.

## Validation and incomplete gates

[CI at 01e0729](https://github.com/Ntrakiyski/workflow-agents/actions/runs/41641429108) passed5contract tests,21Runner TAP tests with real PostgreSQL/mocked Provider, and41Provider tests with real PostgreSQL/fake runtime. Two hardware-conditional negative tests skipped; one real-runtime test was deselected. Runner typecheck/build passed. Native attempts above are separately recorded failures, not CI successes.

The independent GCC read-only HTTP/security probe passed9groups: frozen response schemas, authenticated metrics, schema/profile denials, owner isolation, preserved historical jobs/audits and explicit cross-database login rejection. Both readiness routes returned200; the Provider result is explicitly marked `microvm_qualified=false`. See [independent-migration-http.json](gcc-evidence/independent-migration-http.json). No SDK call, accepted resource mutation or SQL statement was requested.

QA also independently reviewed17Runner and12Provider correlated structured JSON log records. Required fields were present and sensitive payload/output/header keys absent in the bounded sample; original audit IDs remain durable in the restored databases.

Independent review/deployed API evidence: [GCC-MIGRATION-REVIEW.md](../qa/GCC-MIGRATION-REVIEW.md). Earlier Worfklow test/log evidence remains historical in [FINAL-REPORT.md](FINAL-REPORT.md) and [QA report](../qa/REPORT.md). Current machine-readable gates: [readiness.json](readiness.json).

Still incomplete: real workload through both APIs; same-box stop/start filesystem retention; two-box isolation/resource enforcement; VM/execution recovery after service replacement; readiness defect; scoped artifact transfer/export; coordinated registry-plus-disk restore; off-host backups. Daily local PostgreSQL backup schedules with seven-day/count retention exist, but schedule creation is not executed backup/recovery proof. Shared-host reboot remains unverified and unauthorized.

Frozen candidate APIs: `contracts/v1/runner-v1.openapi.json`, `contracts/v1/provider-v1.openapi.json`. Independently owned source, Dockerfiles, locks, migrations, tests, AGENTS.md and development/operations skills remain under `services/job-runner/` and `services/sandbox-provider/`. Active deploy definitions: `deploy/coolify.phase1.json`, `deploy/staging-resources.json`, `deploy/apply-coolify.mjs`. Archive/recovery procedures: `deploy/README.md` and service READMEs. The historical final report retains the original contributor branches/commits and detailed inventory.

**Phase 2 must wait.** Migration completion does not close these infrastructure gates. No Phase 2 code was implemented.
