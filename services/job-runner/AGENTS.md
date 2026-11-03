# Agent instructions — Job Runner

This service is **Phase 1 reusable infrastructure**. Read `PHASE-1-REUSABLE-SERVICES.md` from the repository root before changes.

Read the root [AGENTS.md](../../AGENTS.md) first. This file adds Runner-specific instructions. Current version is `1.0.0-rc.1`; [readiness](../../docs/phase1/readiness.json) remains false for Phase 2.

## Stack and source map

- Node.js 22+, TypeScript, Fastify 5, Graphile Worker 0.18, `pg` and Ajv. Exact versions are pinned in `package.json` and `package-lock.json`.
- `src/` owns HTTP handlers, validated configuration, queue tasks, Provider client and reconciliation. `migrations/` owns Runner state and audit SQL; Graphile owns its queue schema in the same service database.
- `openapi.json`, `provider.openapi.json` and `config/profiles.schema.json` are copies of reviewed root contracts. `Dockerfile` builds from this directory alone. `release.json` records the candidate, not stable acceptance.
- `README.md` documents runtime variables, permissions, lifecycle, backup and startup. `VERIFICATION.md` is service-local evidence; the current root Cloud report records actual hosted integration.

## Scope and ownership
- Own only `services/job-runner/**`. TypeScript + Node.js + Graphile Worker; own PostgreSQL DB/migrations.
- Expose generic, versioned authenticated job/schedule/event APIs. Never import BoxLite, Pi, OfficeCLI or Document Assistant domain logic.
- Communicate with the Sandbox Provider only through its published API; do not read its DB.
- Do not alter the published v1 contract for a consuming application. If a missing generic capability appears, propose a versioned extension with compatibility tests and a standalone release.
- Keep all job/retry/stop actions idempotent; safely reconcile ambiguous external effects.

## Mandatory quality workflow
- For implementation/API changes, read `.agents/skills/job-runner-development/SKILL.md`.
- For releases, failures, upgrades, and production incidents, read `.agents/skills/job-runner-operations/SKILL.md`.
- Add/adjust unit, real-PostgreSQL integration, API contract, negative, concurrency and recovery tests alongside code.
- Never declare success from mocks alone. Prove real queued, delayed, retried and recovered jobs.
- Emit structured correlation IDs, safe errors and durable actor/timestamp audit events; redact credentials.
- Keep a service-owned `README.md` with verified setup, test and recovery commands. Discover actual commands from the implementation; do not invent them.
- Work in a separate branch/worktree; do not edit other services' sources.

## Build, test and run

Run from this directory:

```sh
npm ci
npm run typecheck
npm run format:check
npm run test:unit
TEST_DATABASE_URL="$DISPOSABLE_RUNNER_TEST_DATABASE_URL" npm run test:integration
npm run build
```

**Integration tests drop the `runner` and `graphile_worker` schemas.** Require a dedicated disposable database. Without `TEST_DATABASE_URL`, the database suite skips; never report that as a pass. These tests run real PostgreSQL and Graphile with a mocked Provider, not real BoxLite.

Inject the environment before `npm run migrate` and `npm start`. Startup repeats migrations idempotently and starts API plus worker. `npm start` requires the compiled build. The service does not automatically load `.env` files.

## Invariants for implementation and recovery

- Commit job admission, owner-scoped idempotency, audits and queue insertion atomically. Authenticate and authorize before replay; changed payloads return conflict.
- Persist the attempt's exact execute request, timeout, execution reference and key before HTTP. Transport retries preserve that identity. Only proven terminal transient failures permit a new workload attempt.
- Preserve database locks and unique indexes enforcing global/owner capacity and one active job per sandbox. Graphile delivery is at least once; do not claim unconditional exactly-once execution.
- Cancellation is durable intent. Reconcile the Provider's run or cancellation-by-reference fence before reporting physical termination. An unreachable Provider can leave a job `cancelling`.
- Delayed and idle-stop actions recheck state and newer activity. Stop must never become destroy. Resume creates a new job and preserves the previous result.
- Keep JSON logs safe and event audits append-only. A retention setting is not permission to erase deduplication mappings or audit history.

## Current deployment and acceptance limits

Runner runs privately on GCC Coolify, alias `workflow-phase1-job-runner`, port 8080, with its own PostgreSQL resource. Runtime endpoints, credentials, profiles, concurrency, retries and timeouts are external configuration. The application requires no data volume. Read [deployment instructions](../../deploy/README.md) before operations; do not repin or redeploy for a documentation update.

`/health/live` proves process liveness. `/health/ready` checks Runner DB, migrations and worker, not successful remote guest execution. `/metrics` requires `job:read` and is owner-scoped.

The historical GCC Cloud journey passed generic execution, duplicate admission and stopped-box retention across service replacements. Seven later controlled proxy/SIGKILL scenarios passed against actual Cloud using isolated local real services/PostgreSQL; GCC container failure injection remains separate. Provider rc.2 scoped file transfer passed a private local Provider/actual Cloud journey; the application owns staging/export. Active-command reattachment remains ambiguous and must never receive a fresh execution reference automatically. A fresh hosted v2 application request completed automatically on Runner attempt1, with independently verified output/session export, protected browser download, same-box stop and final application replacement persistence. Completed application data and the approved runtime passed isolated off-host restore; retained infrastructure bindings passed offline forensic comparison without starting workers/runtime clients or authorizing operational cutover. Stable readiness remains false. Use the root readiness record and `docs/release/DELIVERY.md` for exact sources and evidence; keep document semantics outside Runner.
