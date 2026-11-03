---
name: application-operations
description: Deploy, audit, monitor and troubleshoot the Project Documentation Assistant while treating the Runner and Sandbox Provider as external services.
---

# Application operation procedure

1. Read `apps/application/AGENTS.md`, `README.md` and active released Runner/Provider API versions.
2. Verify Application DB, object storage, auth, SSE and connectivity to Runner. Do not inspect or mutate Runner/Provider DBs directly.
3. Trace a request using request/revision IDs, Runner job ID, correlation ID, output version/checksum and recorded events.
4. Preserve upload originals, user feedback and previous versions during failures, restarts or revisions.
5. Check clarification 15-minute timer and eligible auto-finalization separately. A time-expired version is not explicitly human-approved.
6. For a five-day-later revision, submit a new generic execution using the retained sandbox owner reference; do not silently create a new request/VM.
7. Back up and restore application DB and object storage; test access denial across projects, file integrity, SSE replay and error visibility.
8. Before deployment, run backend, frontend, API contract and real or mocked integration checks appropriate to the environment; record the precise versions and results.
9. Escalate missing generic infrastructure capabilities as versioned Phase 1 requests; do not patch those services for a specific document request.
