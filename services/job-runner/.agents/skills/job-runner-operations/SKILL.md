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
