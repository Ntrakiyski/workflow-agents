# Runner service verification — 2026-11-03

Scope: implementation branch `phase1/job-runner`, release candidate `1.0.0-rc.1`. This record distinguishes actual executed tests from mock runtime behavior. The final integration commit and independent reviewer reports supersede this developer record.

## Executed

- `npm ci`: pinned lockfile installation (initially `npm install --save-exact` to create the lock); npm audit reported zero known dependency vulnerabilities.
- `npm run typecheck`: passed strict TypeScript compilation.
- `npm run build`: compiled Node production entrypoint and service code.
- `docker build -t workflow-job-runner:phase1-rc .`: passed using the digest-pinned Node base. Ran the resulting image with non-root UID 1000, read-only root filesystem, all Linux capabilities dropped, no-new-privileges, and a private local test env file. `/health/live` and `/health/ready` both returned 200; `node scripts/smoke.mjs` confirmed Runner DB/queue readiness and explicitly reported the intentionally unavailable Provider endpoint. The disposable smoke container was removed afterward.
- `npm run test:unit`: five tests passed: canonical idempotency, frozen request schemas and forbidden overrides, credentials and bounded IDs, fail-closed configuration, and a real process startup failure proving malformed secret JSON never appears in logs.
- `TEST_DATABASE_URL=<isolated local PostgreSQL 16> npm test`: 21 TAP tests passed across the unit and integration commands, zero skipped: five units, 15 database/queue scenarios, plus the parent integration test. The integration suite applied migrations twice and used actual Graphile task execution.

The database/queue scenarios exercised authentication, wrong-owner reads, profile/path rejection, quota, log redaction; concurrent duplicate admission and changed-payload conflict; delayed job restart; proven transient execution failure followed by a fresh second attempt; ambiguous HTTP create and execute response followed by worker restart with one physical mock execution; same-sandbox serialization with unrelated-owner concurrency; active cancellation; cancellation fencing before an ambiguous execute ever launched; expired admission deadlines and active execution duration cancellation; fixture write→scheduled non-destructive stop→resume/read; cancelled schedules and delayed submit recovery; schedule DELETE versus paused external stop race; append-only durable audit records, cursor pagination/bounds, correlation and health/readiness. A real Runner child process was submitted to over HTTP, killed with SIGKILL while its mock Provider run was active, then restarted; it completed the same run with one attempt/one mock execution and a durable recovery event.

Runner API calls in this suite use Fastify's injection interface. Provider calls cross real TCP HTTP to an authenticated schema-checking mock server. PostgreSQL, migrations, advisory locks, unique constraints, audit triggers, and Graphile scheduling are real. The Provider runtime and its filesystem are mocked. Same-key execute payloads are compared in the mock, including persisted timeout_seconds, so changing timeout during ambiguous replay is a regression failure.

## Required independent or deployment evidence

- Independent reviewer rerun with a separate disposable database and source review.
- Both real service processes integrated over HTTP with their separate databases.
- Actual deployed logs, durable audit queries, private connectivity and persistent database volumes.
- Real BoxLite execution, stop/start filesystem retention, two-VM isolation, Provider restart and safe host restart. Runner tests do not prove these runtime gates.
- Coordinated backup/restore drill and off-host backup schedule evidence from integration operations.

The development host has no `/dev/kvm`. No real microVM or shared host reboot was performed by this service engineer. These gates must never be reported as passed from the mock tests. Runner does not need BoxLite to build, test or deploy.

Follow-up regressions also passed in the same 21-test suite: a job scheduled 60 seconds ahead expires at its 350 ms absolute deadline after worker restart without any Provider execution; pending schedule quota rejects new admission while same-key replay still succeeds; a second authorized actor cancelling an owned schedule is recorded as the actual actor/correlation in immutable audit storage. Manual scheduled stops recheck the caller's current sandbox profile policy before acting.

Coolify healthcheck compatibility follow-up: the final image now installs `curl` and `ca-certificates` with apt recommendations disabled and removes package indexes. The platform replaces image healthchecks with its own curl probe. Rebuilt the image successfully, reran strict typecheck and all five unit tests, then ran a disposable read-only/all-capabilities-dropped container: UID 1000, curl request to an internal HTTP fixture returned `ok`, CA bundle present. No database or application logic changed in this follow-up, so the existing 20-test database/queue evidence was not needlessly rerun.

Staging-discovered setup-timeout regression: a Provider HTTP fixture repeatedly returns 503 for sandbox creation until the one-second setup deadline. The Runner terminates as `timed_out` with safe `deadline_exceeded` error/correlation and immutable audit error classification, zero attempts, no box creation and no execute call. Central terminal-state handling also supplies this safe error when a cancelled Provider run maps to a timed-out job. Reran the full 21-test suite, typecheck, formatting check and build; all passed.
