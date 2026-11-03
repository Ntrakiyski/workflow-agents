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
- GCC Cloud qualification on2026-11-03 used the published APIs only: real approved write/read jobs, one-attempt duplicate protection, delayed/cancelled work, retained jobs/audit IDs after independent Runner/Provider replacement, and exact-fixture destruction. See `docs/phase1/CLOUD-VALIDATION.md` and the retained record. Only configured profiles changed; Runner imports no BoxLite SDK. Stopped-box recovery passed; active-command/output recovery, scoped artifact transfer and complete backup/restore remain separate incomplete release gates. Do not repin deployment commits merely to publish evidence updates.
