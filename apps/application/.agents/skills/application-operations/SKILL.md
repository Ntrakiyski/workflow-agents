---
name: application-operations
description: Deploy and recover the minimal request application while preserving owned PostgreSQL state, immutable files and external execution identities.
---

1. Read root/application AGENTS, README and current release gates. Deploy only Workflow Agents resources on GCC; verify project membership first.
2. Build from `apps/application/` at an exact commit. Inject runtime-only configuration/secrets. Keep Runner, Provider, application database and S3 private; expose only authenticated HTTPS application.
3. Preload the reviewed runtime archive as an immutable object and configure its exact SHA256. An archive is an uploaded bundle, not a VM clone. Configure matching workload/sandbox profiles and file permissions.
4. `/health/live` proves process only; `/health/ready` tests application PostgreSQL and S3. Neither proves execution, LiteLLM or OfficeCLI.
5. Trace application request UUID/correlation → persisted Runner job → retained sandbox → object metadata/checksum and durable audit. Use published APIs, never service databases.
6. After replacement, let the worker reconcile durable rows with the same keys. Never clear job/sandbox references or change a key to force an uncertain execution to rerun.
7. Stop retries are independent after delivery. Inspect safe `sandbox.stop` warnings and `sandbox_stopped`; exported results remain available. Never destroy retained boxes as recovery.
8. Back up application PostgreSQL and every referenced S3 object plus approved runtime/configuration as one recovery set, encrypt and copy off-host. Verify object SHA256, audit/event identities, migration versions and request/job/sandbox references in isolated resources. A DB dump without files is incomplete.
9. Quiesce admissions/workers during coordinated capture/cutover and inspect active external executions before starting a restore. Do not replay old in-flight rows into fresh sandboxes. Preserve originals and previously delivered files.
10. Verify actual browser flow, protected downloads, persistence and audit after deployment. Report exact commit, URL, real/mocked/blocked checks and readiness separately.
