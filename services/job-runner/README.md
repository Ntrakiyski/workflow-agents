# Job Runner v1 — release candidate

Reusable TypeScript/Node.js + Graphile Worker service with its own PostgreSQL database. The Runner consumes only the Provider's HTTP API. This service does not import a sandbox SDK or application code. `release.json` records the release candidate version; actual Phase 1 readiness depends on the repository's deployment and independent QA reports.

## Build and independent test

Requires Node.js 22+ and PostgreSQL 16+. From this directory:

```sh
npm ci
npm run typecheck
npm run test:unit
TEST_DATABASE_URL="$DISPOSABLE_RUNNER_TEST_DATABASE_URL" npm run test:integration
npm run build
```

**The integration suite drops `runner` and `graphile_worker` schemas in `TEST_DATABASE_URL`. Never point it at staging, production, another service's registry, or a database containing retained jobs.** Without `TEST_DATABASE_URL`, `npm test` explicitly skips its database parent test; this is not a database pass. Integration tests use real PostgreSQL, actual Graphile tasks and an HTTP mock Provider; mock filesystem retention is not BoxLite persistence evidence.

Start after setting the runtime environment:

```sh
npm run migrate
npm start
```

`npm start` starts the compiled API and worker in one independently deployable process; it also applies idempotent migrations. `npm run migrate` is available for a separate migration gate. `npm run dev` uses `tsx` for development. The migration user must own this database and create schemas/functions; never share credentials with Provider. Persist the PostgreSQL data directory independently. The application container needs no data volume.

```sh
docker build -t workflow-job-runner:rc .
# Supply an external env file; expose only on loopback for local testing.
docker run --rm --env-file /secure/path/runner.env -p 127.0.0.1:8080:8080 workflow-job-runner:rc
```

The digest-pinned multi-architecture Node base, lockfile, service-local contract copies and Docker context `.` allow an independent build. The final image runs as `node`; it needs no devices, privileged capabilities, host mounts or Docker socket.

## External configuration

Use `.env.example` as a key reference, not a credential source. The program does not load dotenv files itself; inject variables through the shell or deployment manager. `RUNNER_AUTH_JSON` and `RUNNER_PROFILES_JSON` are required, validated JSON strings. Source profiles from the versioned schema and render an immutable verified OCI image digest into `config/profiles.template.json`; an unresolved placeholder fails startup. Runner uses argument schemas, allowed sandbox/profile bindings, and duration caps; only Provider interprets commands/images.

| Variable | Meaning / default |
| --- | --- |
| `DATABASE_URL` | Required private, service-owned PostgreSQL connection. Use `sslmode=verify-full` where TLS is required. |
| `RUNNER_AUTH_JSON` | Required array of credentials with `token`, `actor_id`, `owner_id`, `permissions`, `workload_profiles`, `sandbox_profiles`; optional `allow_resume`, `max_concurrency`, `max_pending_jobs`, `max_pending_schedules`. Use random scoped secrets. |
| `RUNNER_PROFILES_JSON` | Required complete profile JSON `{version:1,sandboxes,workloads}` matching `config/profiles.schema.json`. |
| `SANDBOX_PROVIDER_URL` | Required private HTTP(S) base URL, without embedded credentials/query/fragment. |
| `SANDBOX_PROVIDER_TOKEN` | Required private Provider credential configured for explicit delegation to the authorized Runner owners. |
| `HOST`, `PORT` | Bind address / port: `0.0.0.0`, `8080`. |
| `QUEUE_CONCURRENCY` | Local Graphile task concurrency: `2`, maximum `64`. |
| `MAX_GLOBAL_CONCURRENCY` | Database-enforced active dispatch/run limit across Runner processes: `2`. |
| `MAX_OWNER_CONCURRENCY` | Default active jobs per owner: `1`; credential override allowed. |
| `MAX_PENDING_JOBS`, `MAX_PENDING_SCHEDULES` | Default nonterminal job and pending schedule admission quotas per owner: `100` each; credential overrides allowed. |
| `MAX_DURATION_SECONDS`, `MAX_ATTEMPTS` | Hard policy ceilings: `3600`, `3`; workload profile cap also applies. |
| `PROVIDER_TIMEOUT_MS` | Per HTTP operation timeout including bounded response reading: `5000`. |
| `POLL_INTERVAL_MS` | Graphile polling / durable run inspection delay: `250`. |
| `RETRY_BACKOFF_SECONDS` | Default proven-transient workload retry base: `2`; exponential backoff capped at 3600 seconds. |
| `DB_POOL_SIZE` | Default queue concurrency + 8. Must be at least queue concurrency + 4 and fit PostgreSQL `max_connections`. |
| `DB_QUERY_TIMEOUT_MS` | Connection/query timeout: `5000`. |
| `LOG_LEVEL` | `info` by default; records include only operational fields; payloads are never logged. |
| `AUDIT_RETENTION_DAYS` | Minimum retention policy: `90`. No automatic deletion is implemented; all audit events are retained until an operator-approved archival migration. |

Permissions are `job:submit`, `job:read`, `job:cancel`, and `schedule:write`. `allow_resume` additionally gates the resume endpoint. A caller cannot select its owner using a body field or `X-Owner-ID`; Runner obtains owner identity from credentials and constructs the Provider delegation header. Private HTTP transport assumes a trusted network; use TLS whenever crossing that boundary. Rotate secrets by replacing secret-manager configuration and redeploying both sides; do not expose the delegation credential to consumer applications.

## API and generic usage

The service-local `openapi.json` and `provider.openapi.json` are copies of the frozen repository contracts. `/openapi.json` serves Runner's contract. JSON `/v1` APIs require bearer authentication. Create/job/resume/schedule calls require `Idempotency-Key`; errors are `{code,message,retryable,correlation_id}`. `X-Correlation-ID` is generated if absent, validated if supplied, and echoed on responses.

- `POST /v1/jobs`, `GET /v1/jobs/{id}`, `GET /v1/jobs/{id}/events`
- `POST /v1/jobs/{id}/cancel`, `POST /v1/jobs/{id}/resume`
- `POST /v1/schedules`, `GET /v1/schedules/{id}`, `DELETE /v1/schedules/{id}`
- `/health/live` process liveness; `/health/ready` database/migration and local worker readiness
- `/metrics` authenticated owner-scoped Prometheus job counts (`job:read`)

Example submission body:

```json
{
  "workload": {"profile":"fixture-write-file:v1","arguments":{"file":"hello-world.txt","text":"hello"}},
  "sandbox": {"mode":"ensure","owner_ref":"opaque-workspace-001","profile":"minimal-linux:v1","persistent":true},
  "limits": {"max_duration_seconds":120,"max_attempts":2},
  "idle_stop_after_seconds":30
}
```

Poll the returned Job until terminal. Reuse an existing retained box via `sandbox:{mode:"reuse",sandbox_id:"..."}` or resume a terminal job with a new workload/limits. Resume creates a new job; the previous result remains immutable. Configure new approved workloads/profiles without editing the Runner source. Arbitrary client shell, image overrides and unbounded file bodies are rejected.

`run_at` delays a job. `limits.deadline_at` is an absolute cutoff. A delayed job wakes at its earlier deadline even when `run_at` is much later, including after process recovery. Schedules support `submit_job`, `stop_sandbox`, and `cancel_job`. A stop skips busy boxes and never destroys them. Automatic idle stops capture the completion that created them and skip when newer activity exists. Schedule cancellation and external firing serialize under the same advisory lock; once a side effect begins, DELETE waits and returns conflict after the schedule fires, rather than reporting cancelled after an effect.

## Durability, limits and recovery

Job admission, idempotency records, audit events and Graphile enqueue commit together in PostgreSQL. Owner-scoped keys compare recursively canonical JSON; changed reuse returns 409 and mappings persist for resource lifetime. Database advisory locks serialize each job and schedule. A database capacity lock plus partial unique indexes enforces global/per-owner active concurrency and one active job per sandbox/ensure reference across processes. Provider independently prevents concurrent physical runs.

Attempts persist the execution reference, idempotency key and **exact timeout** before HTTP dispatch. Unknown HTTP outcomes reuse this identity; transport retry does not consume a new workload attempt. Only a proven terminal transient failure may create another attempt, respecting retry/deadline limits. HTTP errors never cause a new arbitrary run key. Run output is bounded and owner protected.

Cancellation persists intent first. Known active runs are cancelled and polled before final status. For an ambiguous execute, Runner calls Provider's durable `runs/cancel-by-reference` fence; an absent run becomes fenced without launching a workload, while a known run is reconciled. A completed run remains completed if cancellation arrives late. When Provider is unreachable, the job remains visibly `cancelling` until physical termination/fencing can be confirmed; the Runner cannot truthfully claim the remote process stopped. Explicit destruction is not part of this service.

On process startup, nonterminal jobs and pending schedules are re-enqueued with recovery audit events. A dead PostgreSQL session releases its advisory locks. Duplicate Graphile delivery is harmless under those locks and persisted execution identities. The underlying queue is at least once. Startup reconciliation avoids waiting for Graphile's stale-lock reset after a crashed process, while persisted Provider keys prevent duplicate effects. After restoring database state, preserve Provider registry/disks and inspect active runs before restarting normal traffic.

## Logs, audit, backup and upgrades

JSON logs include timestamps, service, correlation, actor/owner, job/sandbox/run IDs, action, duration, outcome and safe error class. HTTP logs contain route templates, not raw URLs or bodies. Graphile's raw message bodies are suppressed because they may contain SQL/connection material; operational levels and task labels remain logged. Event storage is append-only via a PostgreSQL update/delete trigger. Cursor pagination is bounded, exclusive and stable. Deduplicate events by event ID. Minimum audit retention is configurable but automated destructive pruning is intentionally absent.

Before migration/deploy, take a service-owned `pg_dump -Fc` to an access-controlled backup location. Restore to a new isolated PostgreSQL database using `pg_restore --no-owner --no-acl`; verify schemas, jobs, idempotency mappings, attempts, Graphile queue and audit event counts. Never run the destructive test suite against a restored operational database. The repository integration owner owns the executable backup/restore drill and evidence. Test restores regularly and encrypt/retain off-host copies according to operator policy; a database volume is not a backup.

Migration 001 is additive/idempotent. An application rollback can use the previous compatible image with the same database only if its schema compatibility was tested. Do not drop schemas to roll back retained jobs. For an incompatible migration, stop new admission and workers, preserve a backup, restore to a separate database and use the explicitly tested version/restore plan. This RC has no prior production schema version or claimed zero-downtime downgrade test.

`node scripts/smoke.mjs` performs read-only local Runner and private Provider health/connectivity checks using runtime endpoints. It exits nonzero for failed liveness; failed Provider readiness remains visible in its output and must block BoxLite acceptance.

See `VERIFICATION.md` for executed service-local evidence and the repository QA/deployment reports for actual cross-service and real-runtime gates.
