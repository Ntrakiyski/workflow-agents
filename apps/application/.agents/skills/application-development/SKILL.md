---
name: application-development
description: Build and test the Project Documentation Assistant UI and backend as a consumer of stable generic Job Runner and Sandbox Provider APIs.
---

# Application development procedure

1. Read `apps/application/AGENTS.md`, `PHASE-2-DOCUMENT-ASSISTANT.md`, and the current released Runner API contract.
2. Treat Phase 1 services as black boxes. Implement typed clients and mocks; never read their internal DBs or modify their source.
3. Implement React hybrid request UI, Fastify authorized API, local HPE users/project membership, skill catalog, S3 originals/output versions, status/SSE, clarification and feedback.
4. Submit generic jobs and configurable workload profile references; keep document semantics in Application and the Pi document workload.
5. Enforce request, revision and version idempotency; distinguish user-accepted, timeout-finalized, incomplete and blocked states.
6. Verify relevant original SRT skill behavior on permitted fixtures; do not invent required template details.
7. Run UI unit/component tests, API validation/RBAC tests, real Application DB + storage integration, mocked Runner contract tests and browser end-to-end tests.
8. Once Phase 1 is independently signed off, run the complete real-service v1→idle-stop→five-day-resume→v2 scenario.
9. Check structured logs, user/project audit events, correlation IDs, redaction, output file integrity and recovery.
10. Report what was tested, failed/skipped and which external dependencies were used. Never claim validation from rendered screenshots alone.
