# GCC BoxLite Cloud validation — 2026-11-03

**BoxLite Cloud is deployed and the real generic workload journey passed. Full Phase 1 release acceptance remains incomplete.** Runner and Provider remain independent private services in GCC's `workflow-agents-phase1` / `staging` project. No Phase 2 application was implemented. The previous Worfklow project was removed after verified migration; its reports remain historical.

Both applications actually run commit **`04b7dc46dc8e1bc6c126f8304823c4739d5ec5c9`** on branch `phase1/integration`. Later documentation commits do not repin the applications. The reviewed `/v1` APIs remain `1.0.0-rc.1`, not a stable release. [readiness.json](readiness.json) records the current gates; [independent QA](../qa/CLOUD-REVIEW.md) distinguishes executed, observed, mocked and incomplete checks.

## Runtime and configuration

The user explicitly authorized hosted BoxLite. Provider now selects a REST-backed `SandboxRuntime` using external `SANDBOX_RUNTIME_MODE=cloud`, endpoint, account scope, request timeout and a runtime-only Coolify secret. The key is neither committed nor passed to Runner, image builds or test guests. Local mode remains available explicitly; no automatic fallback exists. No KVM mapping, privileged container, Docker socket or host security change is needed for Cloud mode.

SDK **0.11.0** remains pinned: the current canonical [BoxLite guide](https://boxlite.ai/agent.md) targets it, installed interfaces were compared with the supplied 0.10.8 example, and real Cloud calls succeeded. [Capability research](../contracts/boxlite-cloud-capabilities.md) records the actual APIs and limitations. The existing PostgreSQL registry now persists runtime backend identity and a durable creation fence. Ambiguous create/execute results cannot authorize blind duplicate allocation or execution. Historical local records retain their backend and cannot be mutated as Cloud records. Public HTTP schemas are unchanged.

The authoritative catalog is [profiles.cloud.staging.json](../../deploy/profiles.cloud.staging.json). New profile `cloud-minimal-linux:v1` requests CPU 1, RAM 1024 MiB and disk 1024 MiB; these are configurable staging values. The previous 256 MiB local profile remains immutable for historical reads. Cloud rounds RAM to whole GiB, so new Cloud profiles reject fractional-GiB requests instead of claiming an unenforced lower limit. Approved Python image:

```text
docker.io/library/python@sha256:e697c81897302a4c4333bade000d98038fbb21eb064f8ee1fd42d02ebcd9d337
```

Only trusted profile configuration supplies entrypoint/argv. HTTP clients cannot submit arbitrary commands. Both network directions are disabled; no public guest tunnel/port was created. Retention explicitly sets `auto_delete=0`, `auto_stop=0`, `auto_resume=false`, detached creation and separate authorized destruction. The image string returned by Cloud is metadata, not independent signed pull attestation.

Source/build inventory: `services/job-runner/` and `services/sandbox-provider/` each retain their own Dockerfile, dependency lock, migrations, tests, README, `AGENTS.md` and `.agents/skills/`. Frozen wire contracts are `contracts/v1/{runner-v1,provider-v1}.openapi.json`; profile schemas and service copies remain synchronized. CI lives in `.github/workflows/phase1.yml`; independent Cloud wire/HTTP probes are in `tests/qa/`. Reviewed Cloud contributions from `phase1/cloud-provider` (`b5f8cd3`, `27a88df`, `4ddb780`), `phase1/contracts` (`b7b4296`, `baa3324`) and `phase1/cloud-qa` (through `74507d2`) were integrated on `phase1/integration` using separate worktrees. Earlier core-service contributions are recorded in the historical implementation report.

## Deployed resources

Coolify: <https://hosting.gccssofia.com>. Project `ptombcqslsfcmfufdui4vk1z`, staging `tiiebld0vegfeegaapo3cdt3`. [Resource IDs](../../deploy/staging-resources.json), [Git configuration](../../deploy/coolify.phase1.json) and [observed deployment state](cloud-evidence/deployment-state.json) are authoritative.

| Resource | UUID | Observed state |
| --- | --- | --- |
| job-runner | `yf0aaiivjr9k3qqaiawnlz8d` | running:healthy; readiness checks own DB and Graphile worker |
| sandbox-provider | `b4safsmcuzzqdmgn7jqt7m8d` | running:healthy; readiness checks own DB and authenticated Cloud access |
| job-runner-db | `5alfx46nkf9d1vfzdivdybqh` | running:healthy; separate credentials and storage |
| sandbox-provider-db | `vv6xrcopkfiry4naqltlvlfg` | running:healthy; separate credentials and storage |

Applications have no public FQDN or host port mapping; databases are private. Actual Runner → Provider traffic uses private HTTP on `workflow-phase1-sandbox-provider:8000`. The shared Docker bridge is not tenant isolation; bearer scope, allowed profiles and owner boundaries remain enforced. Prior independently executed cross-database credential denial is preserved in the migration evidence.

Both applications run non-root, drop all capabilities, prohibit new privileges and have PID/resource limits. Provider is capped at 1.5 CPU / 2048 MiB, Runner at 0.5 CPU / 384 MiB; the two databases each have 0.25 CPU / 256 MiB. Hosted guest capacity is external to these container limits. The GCC capacity sample was a point-in-time observation, not a reservation.

Provider's retained volume `b4safsmcuzzqdmgn7jqt7m8d-workflow-phase1-boxlite`, mounted at `/var/lib/sandbox-provider`, preserves legacy/local SDK data. **It contains no Cloud guest disks.** Separate daily host-local database backup schedules remain configured. No off-host or coordinated Cloud disk restore is claimed.

## Actual validation

| Check and executor | Result and scope | Evidence |
| --- | --- | --- |
| Lead direct SDK preflight | Real create/write/stop/fresh-client same-ID restart/read; explicit cleanup | [direct-sdk-preflight.json](cloud-evidence/direct-sdk-preflight.json) |
| Lead deployed HTTP preparation, independently observed by QA | 9 groups passed; real Runner → Provider → Cloud write, concurrent deduplication (one attempt), changed-body conflict, delayed/cancelled work, same-sandbox stop/start/read, second sandbox's nonzero missing-file read, owner/profile/schema negatives, durable audits | [http-prepare.json](cloud-evidence/http-prepare.json), [independent HTTP review](../qa/GCC-CLOUD-HTTP-REVIEW.json) |
| Lead trusted policy workload, independently observed by QA | Guest CPU 1; MemTotal 1,070,071,808 bytes; rootfs capacity 1,039,155,200 bytes; interfaces dummy0/lo; both fixed external TCP probes failed ENETUNREACH 101 | [policy-before.json](cloud-evidence/policy-before.json) |
| Separate Provider then Runner replacement, independently observed by QA | Both finished at deployed commit above; logs record old-container removal/new start | [deployment-state.json](cloud-evidence/deployment-state.json) |
| Registry/Cloud identity before/after, independently observed by QA | Same external IDs, names, backend binding, disk reference and policy metadata | [identity comparison](cloud-evidence/identity-comparison.json), [independent review](../qa/GCC-CLOUD-POLICY-RECOVERY-REVIEW.json) |
| Lead HTTP verification after both replacements, independently observed by QA | 5 groups passed; original jobs, cancelled schedule and audit IDs retained; new recovery audits; original marker reread from same box, then stopped | [http-recovery.json](cloud-evidence/http-recovery.json) |
| Lead explicit exact-fixture cleanup, independently observed by QA | 3 groups passed; both fixtures destroyed through authorized API, tombstones/audits retained; exactly two corresponding destruction log pairs | [http-cleanup.json](cloud-evidence/http-cleanup.json) |
| Lead read-only account enumeration | Zero own test boxes remain; no account-wide mutation | [cloud-cleanup-enumeration.json](cloud-evidence/cloud-cleanup-enumeration.json) |
| Lead temporary resource inspection | No scheduled test tasks, temporary QA/archive envs or KVM build variables remain; Cloud key only on Provider | [temporary-resource-cleanup.json](cloud-evidence/temporary-resource-cleanup.json) |
| Exact deployed-source GitHub CI, independently inspected by QA | Runner 21 passes plus typecheck/build; contracts 5 passes/generated copies reproducible; Provider 52 passes, 2 hardware-conditional negative skips, 1 real-runtime deselection | [CI run 41647734872](https://github.com/Ntrakiyski/workflow-agents/actions/runs/41647734872) |
| Independent local regression | Provider 53 passed/1 local-KVM skip; separate forced creation-fence test 1 passed; native SDK/loopback wire 5 passed. Real PostgreSQL, fake runtime/HTTP server; no Cloud claim from these tests | [QA report](../qa/CLOUD-REVIEW.md) |

Retained fixture record: [GCC-RETAINED-RECORD.json](GCC-RETAINED-RECORD.json). Before destruction, public sandboxes `sbx_fde66cf57d634a6882b58b1c166beda3` / `sbx_fbb119b5a8204556bfcd638cdaecad57` mapped to Cloud IDs `TjTZPjQ8eEEM` / `12GuwYonABzz`. The marker SHA256 remained `99bb5ef5349d4478bb34fdecdc500eb6e3640c8305c8ed9e8b13452ccd8b33bb` after stop/start and independent application replacements. No reupload occurred. The record is now historical cleanup evidence, not permission to create or destroy other boxes.

QA independently fetched correlated structured logs: preparation 59 Provider / 66 Runner records; replacement verification 27 / 22 records, plus two Provider recovery records. Required timestamp/service/correlation/action/duration/outcome fields were present. Reviewed top-level fields contained no credentials, payloads, argv or command output. Durable API audits include actor, owner, target, time and outcome; original event IDs survived replacement. This is bounded sample evidence, not an exhaustive secret-detection guarantee.

The initial account inventory contained one unrelated box. Its original ID/name were no longer visible in the final read-only list, which contained one different unrelated box. No mutation against either unrelated box was performed; the cause of the difference is unverified. Exact fixture logs demonstrate cleanup of our two recorded boxes, but do not establish unchanged account-wide inventory or vendor audit history.

## Remaining release gates and recovery limits

1. **Scoped artifact transfer/export:** nonempty `artifact_output_ref` still fails 422 before execution; results expose bounded inline output only. A generic authorized transfer adapter remains required.
2. **Active-command/output recovery:** recovering a stopped box and completed records passed. Cloud attachment to an active command deliberately returns nonretryable `ambiguous_execution`, stops the same retained box and never reruns it. SDK 0.11 can lose fresh-stream output while reporting exit 0 without an error; general complete-output certainty and stream failure injection remain unresolved. Qualification workloads explicitly checked their required output.
3. **Recoverable backup/restore:** registry/audit logical restore and migration passed earlier. Host-local database schedules are not off-host backups. Observed Cloud capabilities disable snapshot/export/import/clone; full remote guest backup and coordinated registry-plus-guest restoration need an approved export/data-backup procedure and an actual isolated restore test. The GCC local volume cannot supply Cloud disks.
4. **Host failure recovery:** no shared GCC reboot was authorized or performed; vendor physical-host restart is outside this test's control. Container replacement does not prove either host-level recovery scenario.
5. **Broader resource/security qualification:** actual two-box file separation, denied routes and provisioned capacity passed. Stress quota enforcement, comprehensive escape testing and all possible network boundaries were not qualified. Metadata alone does not close these gates.
6. **Hosted failure/retry qualification:** the real deployed write used one attempt. Retry, timeout, cancellation and worker recovery have PostgreSQL/mock-Provider regression coverage, but injected hosted transient failures, provider timeouts and active-worker crash/restart without duplicate effects were not demonstrated against Cloud. Completed-record/stopped-box replacement recovery does not qualify those journeys.

Local BoxLite on GCC remains blocked at bubblewrap user-namespace creation under current AppArmor/seccomp restrictions. Cloud avoids that local dependency; it does not fix or qualify local mode. No host policy was relaxed.

For maintenance: stop submissions, drain or truthfully cancel work, stop retained boxes non-destructively, preserve each service's own registry/configuration/audits, replace Provider and Runner independently, then validate backend identity and perform an approved same-box read before reopening work. Never reinterpret an ambiguous operation as permission to recreate a box. Keep the same account scope for same-account key rotation. Do not roll back to pre-Cloud code against Cloud records; forward migrations/backend bindings must remain compatible. Detailed operations and mode-specific backup requirements are in the [Provider README](../../services/sandbox-provider/README.md) and [deployment guide](../../deploy/README.md).

**Readiness decision:** Cloud-backed staging infrastructure can execute the approved generic fixtures through its frozen `/v1` APIs. Both service candidates remain unreleased for unrestricted Phase 2 consumption until the remaining gates are completed or explicitly revised by the owner. Draft integration PR: <https://github.com/Ntrakiyski/workflow-agents/pull/1>.
