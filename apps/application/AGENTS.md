# Agent instructions — Document Assistant Application

This is **Phase 2**, the first consumer of Phase 1 infrastructure. Read `PHASE-2-DOCUMENT-ASSISTANT.md` and `PHASE-1-REUSABLE-SERVICES.md`.

## Boundary
- Own only `apps/application/**`. React/TypeScript + Fastify, application PostgreSQL DB, application-owned document/object storage.
- Consume **released Phase 1 APIs only**. No imports from `services/job-runner` or `services/sandbox-provider`, no direct queries into their DBs, and no BoxLite SDK in this service.
- Business-specific 5/15-minute policies, SRT versions, HPE projects, approval/finalization, feedback, Pi skill selection and artifact ownership belong in the Application or its versioned workload package—not in the generic infra services.
- No Phase 1 source change to unblock Phase 2. If a generic capability is missing, submit a separate proposal, add compatibility tests, release a new version, and consume it through configuration/API.
- The requester can return days later; preserve output history and submit a new revision against the same persistent sandbox reference through the generic Runner contract.

## Mandatory quality workflow
- For implementation changes, read `.agents/skills/application-development/SKILL.md`.
- For deployment, operations and incident response, read `.agents/skills/application-operations/SKILL.md`.
- Mock the Runner in initial tests, then run full real-contract integration and end-to-end browser tests.
- Test backend authorization/transactions, storage isolation, SSE, file handling, timeout/feedback and version history—not UI only.
- Preserve originals and never present timeout-finalized as human-approved.
- Maintain verified README/test/deploy instructions; record executed tests and known gaps.
