---
name: job-runner-operations
description: Deploy, monitor, troubleshoot, audit, recover, and upgrade the standalone Graphile Worker job scheduling service.
---

# Job Runner operation procedure

1. Read `services/job-runner/AGENTS.md`, its `README.md`, and the current versioned API contract.
2. Check service health, Runner DB reachability, queue worker state and registered task versions. Never assume a green HTTP response proves tasks execute.
3. Trace incidents using `correlation_id`, `job_id`, attempt history, timestamps and durable audit events; never expose secrets.
4. Inspect in-flight external Provider runs **before** retrying a job whose result is uncertain. Preserve idempotency and prevent duplicate active runs.
5. For stopped/delayed tasks, reconcile active work before firing scheduled stop or timeout; a stop must not delete a persistent sandbox.
6. Before upgrades, verify migrations, backup/rollback plan, API compatibility and pinned dependencies. Test against a mock Provider and real queue DB.
7. After deployment, verify submit→dispatch→result, delayed scheduling, retry, cancellation, event replay and logging/audit on the actual environment.
8. Produce a concise operations report: version, environment, evidence, outcome, outstanding risks, rollback path. Never report unexecuted tests as passed.

## Verified implementation procedures (1.0.0-rc.1)

- Inject configuration from the secret manager using `.env.example` key names; there is no automatic dotenv loader. Render/validate the approved profile JSON before startup.
- `npm run migrate` applies service and Graphile migrations. `npm run build` then `npm start` starts API+worker and repeats migrations idempotently.
- Probe `/health/live` and `/health/ready`; the latter returns 503 when DB/worker is unavailable. `node scripts/smoke.mjs` probes local Runner and private configured Provider without printing credentials. Failed Provider readiness remains a runtime blocker.
- GET the owned job and its paginated `/events`; use actor/owner/correlation fields and attempts for reconciliation. An unreachable Provider can leave `cancelling` until a durable execution-reference fence or actual terminal state is confirmed.
- Before upgrades, `pg_dump -Fc` the Runner database and restore to a new isolated DB using `pg_restore --no-owner --no-acl`; verify state/idempotency/queue/audit counts. The repository backup drill records actual restore evidence. Do not run destructive integration tests against the operational restore.
- Audit events retain all history; `AUDIT_RETENTION_DAYS` is a minimum policy and no automatic purge exists. Do not disable append-only protection as routine maintenance. Incompatible rollback requires an explicitly verified backup/restore plan; RC migration 001 has no prior production downgrade claim.
- Historical GCC Cloud qualification at `04b7dc4` passed approved write/read jobs, duplicate protection, delayed/cancelled work, retained jobs/audit IDs through independent service replacement and exact-fixture destruction. Later actual Cloud fault qualification uses isolated real local Runner/Provider/PostgreSQL plus controlled HTTP proxy failures and SIGKILL. All seven scenarios retained one admitted run/observed effect; Provider crash truthfully failed instead of replaying. This is not GCC container-failure or active-output reattachment proof. See `docs/release/cloud-failure-journey-final.json`.
- Provider rc.2 exposes separately authorized scoped file endpoints; file staging/export belongs to the application, not Runner. Runner retains its existing `/v1` request/result shapes and contains no document or BoxLite SDK behavior. Active `ambiguous_execution` remains nonretryable; do not assign a fresh reference to hide uncertainty.
- Encrypted off-host Runner/Provider logical archives at deployed `4bab06c` passed isolated restore, exact rows/audits/sequences and idempotent replay. Generic file reconstruction and application row/object checkpoints are separate recovery layers. The historical application restore covered one original object. Completed result/session capture and restore, runtime reconstruction and coordinated live recovery remain pending; a verified independent public runtime cache is available. `deploy/verify-offhost-restore.py --infrastructure-only --forensic-registry-only` compares retained binding records only in new disposable databases and permits no Provider/worker startup or operational cutover. Never start a restored worker against original external bindings during forensic verification.
- Runner and Provider remain at lead-confirmed healthy `8387b5d`; the application independently advanced to `1d21e27` and was replaced at the same source in deployment `y0mgz7i3yndf7o1cmvutoopf`. Hosted request `598c30fa-e0d0-4d36-96d7-16d75bd675e7` completed actual Pi/OfficeCLI on Runner attempt 1, but a strict application session-schema mismatch initially prevented export. The canonical fix and explicit same-job export-only recovery preserved IDs and failure audits without workload replay. Independent browser output validation, durable original/output/session checkpoints, correlated completion/stop audits and exact result persistence through application replacement passed. See `docs/release/hosted-completed-export-recovery.json`, `hosted-recovered-checkpoints.json` and `hosted-application-replacement.json`.
- A fresh automatic request, `6f3085e0-7d6f-4b9e-8ad5-7ba76f587189`, is still uploading; no operator recovery is planned. Do not count admission, process health or the earlier operator-assisted recovery as uninterrupted automatic completion. Stable readiness remains false. Consult current `docs/phase1/readiness.json` for exact sources and evidence; publishing documentation does not authorize repinning or deployment.
