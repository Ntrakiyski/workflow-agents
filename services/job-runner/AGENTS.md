# Agent instructions — Job Runner

This service is **Phase 1 reusable infrastructure**. Read `PHASE-1-REUSABLE-SERVICES.md` from the repository root before changes.

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
