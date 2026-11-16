---
name: job-runner-development
description: Develop or modify the reusable Graphile Worker Job Runner service and its APIs with database, idempotency, retry, and compatibility tests.
---

# Job Runner development procedure

1. Read `services/job-runner/AGENTS.md` and `PHASE-1-REUSABLE-SERVICES.md`; identify the affected generic contract. Reject client-domain fields such as SRT, DOCX, project approval, or Pi session paths.
2. Inspect current handlers, migrations, OpenAPI descriptions, and tests. Write the intended API/state transition and failure modes before coding.
3. Change only this service's TypeScript code and own PostgreSQL schema; never query another service's DB.
4. Add/request validation, authorization, per-client ownership, idempotency, approved per-sandbox capacity/lease handling, retry classification, cancellation and deadline checks.
5. Mock Provider for unit/contract tests; run a real PostgreSQL + Graphile integration scenario for queue, delayed jobs and recovery.
6. Exercise duplicate delivery, worker restart, Provider timeout after side effects and idle-stop-versus-new-run races.
7. Confirm correlation IDs, structured logs and persistent audit events; redact tokens and sensitive payloads.
8. Run actual project lint/typecheck/test/migration commands from README/package scripts. Record what ran, what passed, what failed/skipped.
9. Report any API change as backward-compatible v1 addition or separately proposed major version; do not patch infrastructure just to satisfy one consuming application.

## Verified implementation commands (1.0.0-rc.1)

From `services/job-runner`: `npm ci`, `npm run typecheck`, `npm run format:check`, `npm run test:unit`, `TEST_DATABASE_URL=<disposable PostgreSQL> npm run test:integration`, `npm run build`. The integration command **drops the runner and graphile_worker schemas**; never target retained staging/production state. It uses actual PostgreSQL and Graphile with a Provider HTTP mock. See `VERIFICATION.md` for limits.

Service-local `openapi.json`, `provider.openapi.json`, and `config/profiles.schema.json` must match the reviewed root contracts. The Provider cancellation-by-reference fence prevents a cancellation reconciliation from launching a previously absent run. Persist an attempt's exact execute request timeout/key/reference before HTTP; never recompute the payload on replay. A proven terminal retry creates a new attempt; transport retries preserve the existing one.

Shared candidate rc.3 uses optional immutable sandbox-profile `max_concurrent_runs` (default one). Claim under the global capacity advisory lock; persist the approved capacity before active transition so the DB trigger independently rejects overflow. Test shared overlap, third-job queuing, independent cancellation and migration replay while two jobs remain active. Keep global/owner caps and stop-schedule activity checks; a representative Provider `active_run_id` is a busy signal, not the complete run list.
