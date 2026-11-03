# GCC real HTTP acceptance procedure

`tests/qa/gcc_probe.mjs` is an independent HTTP-only consumer. It imports no service code, database driver or BoxLite SDK. It requires both services to be ready and has no unavailable/fake-runtime success branch. The production deployment must independently be verified to instantiate the real adapter: HTTP self-reported health and fixture behavior alone cannot identify a malicious or test-double server.

The probe runs inside the Runner image using its existing protected runtime credentials, `PORT`, `SANDBOX_PROVIDER_URL` and service-local frozen contracts. The principal must allow write/read fixture profiles, job submit/read/cancel, schedule writes and resume. A second owner needs job read access, and the Provider delegate must permit both owners so cross-owner 404 checks actually exercise ownership. Provider credentials need sandbox read/create/start/stop/execute/cancel; cleanup additionally needs destroy. No credential appears in output.

## Phases

1. **prepare:** health/schema/auth/metrics/strict-negative checks; delayed job and schedule cancellation; concurrent duplicate submission and changed-body conflict; actual Runner-mediated marker write; stop/start and resumed checksum read in the same public sandbox; actual nonzero read in a distinct sandbox proving the first marker is absent; durable cancellation-by-reference fence; owner boundaries and durable lifecycle/audit IDs. Both boxes are left stopped for a safe replacement test.
2. The operator saves output's `retained_record` as immutable JSON, ordinarily `docs/phase1/GCC-RETAINED-RECORD.json`, then independently replaces Provider and Runner containers. Capture actual deployment IDs and old/new container evidence separately. The record includes identifiers and a marker SHA-256, never credentials or marker content.
3. **verify:** load the record through `QA_RECORD_JSON`, `QA_RECORD_URL`, or the Git base argument plus that default JSON path. Validate owner, both live fixture owner references and original job anchors before lifecycle side effects. Verify old completed/cancelled state and original audit event IDs, require Provider recovery audits, start the original sandbox and submit another Runner read proving its marker checksum survived the actual replacements. Stop it again.
4. **cleanup:** optional separate operator action, with `QA_ALLOW_DESTROY=1`. Validate all live fixture references/job anchors before any deletion; stop and explicitly destroy only the two recorded fixture boxes and confirm durable destruction audits. Tombstones/jobs/audits remain. Without that explicit switch, cleanup fails closed. No unrelated box is enumerated or selected.

The initial setup has a bounded 300-second deadline and 330-second polling window so first OCI image download is not mistaken for a workload timeout. Workload execution itself remains limited to 30 seconds. HTTP requests have a 15-second bound. Verification reads allow 120-second deadline/150-second polling. A first image pull or restrictive runtime failure beyond those bounds fails the probe; it does not become an acceptance pass. Configure the scheduled-task timeout/poll budget up to 900 seconds for the cold prepare journey; shorter limits may terminate a legitimate long setup and must not be reported as a successful test.

A Coolify one-off cron can execute twice before removal. An atomic local Runner-directory claim serializes a phase/operator invocation and caches its sanitized result; repeated cron launches wait for/replay that same result rather than creating more VMs. The claim is scoped to phase, effective owner, source base, input record and `QA_INVOCATION_ID` (or optional final CLI argument). Default invocation ID is `gcc-phase1-migration-v1`. Explicitly choose a new ID to rerun after a failure; stale claims fail closed after a bounded 900-second wait and never automatically steal ownership. A record change cannot reuse a cached cleanup success. Cache files are private to the Runner UID under `/tmp/workflow-gcc-qa-results`, contain no credentials and disappear on container replacement. Capture the returned record externally before replacement.

## Invocation

For a checked-out source file inside Runner:

```sh
node gcc_probe.mjs https://raw.githubusercontent.com/Ntrakiyski/workflow-agents/IMMUTABLE_SHA prepare migration01
node gcc_probe.mjs https://raw.githubusercontent.com/Ntrakiyski/workflow-agents/RECORD_SHA verify
QA_ALLOW_DESTROY=1 node gcc_probe.mjs https://raw.githubusercontent.com/Ntrakiyski/workflow-agents/RECORD_SHA cleanup
```

The lead can use a short Coolify command (under its 255-character command-column limit):

```sh
g=https://raw.githubusercontent.com/Ntrakiyski/workflow-agents/IMMUTABLE_SHA; curl -fsSL "$g/tests/qa/gcc_probe.mjs" | node --input-type=module - "$g" prepare
```

For verify, use a commit containing both the source and retained record; select `verify` as final argument. Alternatively supply `QA_RECORD_JSON`/`QA_RECORD_URL` through protected operator environment configuration. A public immutable record contains only generic QA IDs/checksum; the operator should review it before publishing. The command itself contains no credentials.

## Executed locally for this change

- `node --check tests/qa/gcc_probe.mjs`: passed.
- `node --check tests/qa/staging_probe.mjs`: passed after extending only the real-runtime setup bound.
- New real-only probe was run against the existing local real-HTTP/real-PostgreSQL fixture with an explicitly fake Provider. It exited 1 at `real_runtime_readiness`, `error:"Service is not ready"`, no retained record, before allocating any workload. Runner readiness/auth/metrics group passed. This is a fail-closed client check, not a successful microVM or full positive-protocol test.
- An ad-hoc local client-protocol smoke (`python3 /tmp/gcc-qa-protocol-smoke.py`) provisioned fresh temporary local logical databases and actual Runner/Provider HTTP processes with an **explicit test double labelled healthy solely to exercise the client**. Nine prepare groups passed. After adding invocation serialization, two concurrent prepare processes returned identical retained records with exactly one cached replay. Verify intentionally rejected the absence of an actual Provider recovery event. Explicit exact-fixture cleanup passed and a tampered owner-reference record was rejected. All owned temporary processes/databases were removed. The first harness attempts failed on disposable database creation/ownership; correcting only that fixture provisioning enabled the run. None of these positive client checks is BoxLite, physical filesystem, kernel isolation or deployed-restart evidence.

No GCC/Worfklow infrastructure or workload was mutated by this QA agent, and no new real-runtime acceptance claim is made from these local checks. The lead must capture actual deployed outputs before reporting these phases passed.

## Migration inspection without workloads

`tests/qa/migration_readonly.mjs` is a separate production-dependency-only inspection for a runtime-blocked migration. It reads original historical IDs/correlation/audit anchors from the immutable Git base's existing `DEPLOYED-QA-EVIDENCE.json` and `DEPLOYED-RETENTION-EVIDENCE.json`. It checks health response contracts, authentication/metrics protection, owner isolation, strict schema/profile negatives and restored historical jobs/sandbox/audits. No successful mutation, SDK operation or SQL statement is requested. Reviewed negative POST routes validate schema/profile policy before opening storage/runtime operations. The DB check attempts Runner credentials against an explicitly supplied other host/database and accepts only SQLSTATE28P01 or28000; network failure and a successful login both fail the check. It outputs the safe boolean `cross_db_denied`, never a connection string or credential.

Run inside Runner, supplying the Provider database host/name independently from deployment configuration:

```sh
g=https://raw.githubusercontent.com/Ntrakiyski/workflow-agents/IMMUTABLE_SHA
curl -fsSL "$g/tests/qa/migration_readonly.mjs" | node --input-type=module - "$g" PROVIDER_DB_HOST/sandbox_provider
```

`QA_OTHER_DATABASE_TARGET` can replace the final argument; `QA_APP_ROOT` supports a local fixture. No GCC hostname or database password is hardcoded in the probe. Provider readiness200 is recorded as prerequisite observation with `microvm_qualified:false`, never a runtime pass. Node syntax verification passed; deployed execution is a separate operator action and must be captured before claiming these checks passed remotely.

## Remaining coverage boundaries

Same-sandbox marker retention and absence in a second sandbox do not prove every kernel/host/network escape boundary or resource limit. This probe does not inject transport loss, force a proven transient workload retry, restart an active execution, reboot a shared host, or restore a VM backup. Those need independent dedicated evidence. Completed job/audit retention after replacement is not active-run recovery. Scope-limited artifact export and off-host recovery remain separate infrastructure gates.
