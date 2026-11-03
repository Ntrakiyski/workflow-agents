---
name: job-runner-development
description: Develop or modify the reusable Graphile Worker Job Runner service and its APIs with database, idempotency, retry, and compatibility tests.
---

# Job Runner development procedure

1. Read `services/job-runner/AGENTS.md` and `PHASE-1-REUSABLE-SERVICES.md`; identify the affected generic contract. Reject client-domain fields such as SRT, DOCX, project approval, or Pi session paths.
2. Inspect current handlers, migrations, OpenAPI descriptions, and tests. Write the intended API/state transition and failure modes before coding.
3. Change only this service's TypeScript code and own PostgreSQL schema; never query another service's DB.
4. Add/request validation, authorization, per-client ownership, idempotency, one-active-run/lease handling, retry classification, cancellation and deadline checks.
5. Mock Provider for unit/contract tests; run a real PostgreSQL + Graphile integration scenario for queue, delayed jobs and recovery.
6. Exercise duplicate delivery, worker restart, Provider timeout after side effects and idle-stop-versus-new-run races.
7. Confirm correlation IDs, structured logs and persistent audit events; redact tokens and sensitive payloads.
8. Run actual project lint/typecheck/test/migration commands from README/package scripts. Record what ran, what passed, what failed/skipped.
9. Report any API change as backward-compatible v1 addition or separately proposed major version; do not patch infrastructure just to satisfy one consuming application.
