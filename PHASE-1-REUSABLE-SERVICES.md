# Phase 1 — Build and Validate Reusable Infrastructure Services

**Project:** Workflow Agents  
**Stage:** 1 of 2 — reusable infrastructure, **before** application development  
**Status:** Implementation handoff; nothing here is claimed to be built or tested  
**Date:** 2026-11-03  
**Next stage:** [Phase 2 — Document Assistant Application and Use Case](./PHASE-2-DOCUMENT-ASSISTANT.md)  
**Background:** [Lightweight Microservices Architecture](./PROJECT-DOCUMENTATION-ASSISTANT-LIGHTWEIGHT.md)

## 1. Goal and release gate

Build **two independent, reusable services** and prove they work separately and together **without any Document Assistant code**.

1. **Job Runner Service** — a generic durable scheduler/API built with **TypeScript + Node.js + Graphile Worker + its own PostgreSQL database**.
2. **Sandbox Provider Service** — a generic runtime management/API built with **Python + FastAPI + BoxLite SDK + its own PostgreSQL registry**.

**Goal:** Other applications can submit jobs, execute an approved workload in a private sandbox, observe status, stop and restart the same persistent environment, and retrieve results using stable APIs.

**Do not start Phase 2** merely because endpoints compile. Phase 1 ends only when each service has passing automated tests, security/negative tests, structured logs, audit events, and a successful real cross-service demonstration. Any missing environment prerequisites or failed tests must be explicitly reported; do not present mocks as verified integration.

### What Phase 1 deliberately does NOT build

- No React app, Document Assistant UI, HPE project membership, SRT template, OfficeCLI workflow, or document history.
- No application-specific `request_id` fields, `revision_id` tables, document approval, or SRT clarification logic in either infrastructure service.
- No generic YAML workflow interpreter, Hatchet, Procrastinate, or new LiteLLM deployment.
- No hardcoded 5-minute idle stop or 15-minute user-response timeout. These are **client-supplied policies** exercised in Phase 2; Phase 1 provides generic delayed scheduling and idle-stop operations.
- No Pi-specific restrictions in the **generic** Sandbox Provider API. Pi will later be a **registered workload profile**, just as a Python data-processing task could be.

---

## 2. Ownership diagram

```text
Any authorized client (integration test harness in Phase 1)
               |
               | Authenticated, versioned REST + event polling
               v
┌──────────────────────────────────────────────┐
│ JOB RUNNER SERVICE — TS + Graphile Worker     │
│ Jobs · retries · delays · dedupe · concurrency│
│ Execution states · own Postgres · audit/logs │
└───────────────────┬──────────────────────────┘
                    | Authenticated /v1 API
                    v
┌──────────────────────────────────────────────┐
│ SANDBOX PROVIDER SERVICE — FastAPI + BoxLite  │
│ Create · start · execute · inspect · stop     │
│ Persistent box registry · own Postgres       │
│ Activity, events, isolation · audit/logs     │
├──────────────────────────────────────────────┤
│ BoxLite runtime (approved OCI profiles)      │
│   └─ Box A: private writable disk            │
│   └─ Box B: private writable disk            │
└──────────────────────────────────────────────┘
```

**Database independence:** The services have two distinct logical PostgreSQL databases, separate credentials and migrations. They can share a PostgreSQL server initially. Neither service queries the other's tables.

**Client/provider separation:** Runner never imports the BoxLite SDK. Provider never imports Graphile Worker. The Provider's BoxLite implementation stays behind a runtime adapter so future providers can serve **new** sandboxes; migration of existing persistent disks is **not automatic**.

**Ownership:** Job Runner owns `job_id`, scheduling state and execution attempt records. Sandbox Provider owns `sandbox_id`, internal BoxLite identifier, persistent disk reference and run records. Client identity and workspace reference are **opaque metadata**; these services must not interpret business-domain words.

---

## 3. Proposed generic API contracts

These endpoints are **contracts we intend to implement**, not existing SDK endpoints. Agent B and Agent C must agree on the request/response schema before integrating. Until then, each builds against a stub implementing this section.

### Common protocol

- Internal versioned JSON REST: `/v1/*`; `/health/live`, `/health/ready`.
- Authenticate calls between client→Runner and Runner→Provider. Enforce per-client ownership and allowed workload profiles.
- Use server-generated opaque IDs, UTC timestamps, a correlation ID and `Idempotency-Key` on creates/executes.
- No raw arbitrary shell from external consumers; workloads are **allowlisted execution profiles** with validated arguments and pinned OCI image digests.
- File inputs/outputs use bounded artifact references and scoped transfer permissions rather than storing large file blobs in PostgreSQL.
- Standard errors include `code`, safe `message`, `retryable`, `correlation_id`.
- Requests must not assume that a successful HTTP response means the workload finished. Execute may return `202`; status and real result follow later.

### 3.1 Job Runner API (Agent B)

| API | Responsibility |
|---|---|
| `POST /v1/jobs` | Validate authorized client, idempotently queue a generic job; return `job_id` |
| `GET /v1/jobs/{job_id}` | Durable state, timestamps, attempt count, safe progress/result references |
| `GET /v1/jobs/{job_id}/events` | Paginated events with cursor (SSE optional later) |
| `POST /v1/jobs/{job_id}/cancel` | Idempotent cancellation intent |
| `POST /v1/jobs/{job_id}/resume` | Submit next permitted execution against an existing sandbox, if client policy allows |
| `POST /v1/schedules` | Generic delayed job/action with idempotent key |
| `DELETE /v1/schedules/{schedule_id}` | Cancel a not-yet-fired schedule |
| `GET /health/live`, `GET /health/ready` | Liveness/DB/queue readiness |

**Illustrative generic job, not document-specific:**

```json
{
  "client_reference": "opaque-client-record",
  "workload": {
    "profile": "fixture-write-file:v1",
    "arguments": { "file": "result.txt", "text": "hello" }
  },
  "sandbox": {
    "mode": "ensure",
    "owner_ref": "client-workspace-001",
    "profile": "minimal-linux:v1",
    "persistent": true
  },
  "limits": { "max_duration_seconds": 120, "max_attempts": 2 }
}
```

The authenticated caller's identity is determined from its credentials, not from a spoofable `client_reference`. The Runner determines the actual allowed sandbox/workload profiles and applies hard quotas.

**Runner responsibilities:** Enqueue, dispatch, enforce retry budgets, schedule generic delayed operations, reconcile ambiguous outcomes, serialize executions per persistent sandbox and publish durable status/events. It does **not** infer task semantics or mark an arbitrary artifact as a valid SRT.

### 3.2 Sandbox Provider API (Agent C)

| API | Responsibility |
|---|---|
| `POST /v1/sandboxes` | Idempotent ensure/create from approved image/profile and opaque `owner_ref` |
| `GET /v1/sandboxes/{sandbox_id}` | Lifecycle, resource and safe metadata |
| `POST /v1/sandboxes/{sandbox_id}/start` | Idempotent start/re-attach to retained disk |
| `POST /v1/sandboxes/{sandbox_id}/stop` | Stop WITHOUT deleting persistent data; refuse if a run is active unless explicitly cancelled |
| `POST /v1/sandboxes/{sandbox_id}/execute` | Start approved profile command with validated args; return `run_id` |
| `GET /v1/sandboxes/{sandbox_id}/runs/{run_id}` | Run state, bounded output, exit status, artifact references |
| `POST /v1/sandboxes/{sandbox_id}/runs/{run_id}/cancel` | Stop a run, preserving the sandbox according to policy |
| `POST /v1/sandboxes/{sandbox_id}/destroy` | Explicit authorized deletion ONLY |
| `GET /health/live`, `GET /health/ready` | Process + registry + runtime health |

**Illustrative execution:**

```json
{
  "execution_ref": "opaque-job-attempt-0001",
  "profile": "fixture-write-file:v1",
  "arguments": { "file": "result.txt", "text": "hello" },
  "artifact_output_ref": "scoped-transfer-reference"
}
```

**Provider responsibilities:** Mapping from public `sandbox_id` to actual BoxLite identity/storage, lifecycle state, authorized resource profiles, one active run per box, safe file transfer, persistence and recovery. The Provider does not know HPE, SRT, an application UI, or a requester's approval state.

### 3.3 Generic event envelope

```json
{
  "event_id": "evt_0001",
  "client_reference": "opaque-client-record",
  "job_id": "job_0001",
  "sandbox_id": "sbx_0001",
  "type": "job.completed",
  "status": "completed",
  "occurred_at": "2026-11-03T09:00:00Z",
  "correlation_id": "corr_0001",
  "detail": { "run_id": "run_0001", "exit_code": 0 }
}
```

Provide durable event retrieval. Events can be delivered more than once; consumer must deduplicate by `event_id`. No unbounded raw logs or secret values in event bodies.

---

## 4. Work required from Agent B — Job Runner

**Owned folder:** `services/job-runner/**`  
**Runtime:** TypeScript/Node.js + Graphile Worker + own PostgreSQL  
**Prohibited:** imports of BoxLite SDK, application DB or document-specific skills.

**Build**
- Small authenticated HTTP API (Fastify is a reasonable implementation).
- Service-owned schema/migrations, queue tables, job/attempt/idempotency records and audit events.
- Graphile worker tasks for generic enqueue/dispatch, run inspection, bounded retry, deadline firing, idle-stop request and reconcile.
- Typed Provider API client with configurable endpoint and authenticated requests.
- A scheduler for delayed work; scheduled operations check current state before acting (avoid stopping a busy box).
- Concurrency and per-owner limits, leases/locking, single-active-run guarantee and cancellation.
- Failure recovery: after a timeout or crash, inspect Provider state before repeating external side effects.
- Structured logs with correlation, job/attempt and sandbox IDs; counters and health metrics.
- OpenAPI schema, README, development/test commands and an .env example without secrets.

**Automated tests**
- Unit: API validation, scheduling policy, retry classification, authorization, state transitions.
- Integration: real separate Runner PostgreSQL, Graphile job dispatch/retry/delayed schedule, migration idempotency.
- Contract: mock Provider supports all expected requests, statuses, errors, dedupe.
- Failure injection: worker restart, duplicate delivery, stale lease, Provider timeout after create, cancellation race.
- Audit/log tests: create, dispatch, retry, cancellation, scheduled stop each persist timestamp, actor, IDs and outcome; logs include correlation ID and redact tokens.
- Negative: unauthorized caller, denied workload profile, quota, invalid payload, wrong-owner job access.
- Verify schedules survive worker restart and do not execute early or twice in a harmful way.

**Acceptance gate B:** Job API and queue work against a mock Provider and real PostgreSQL; test report is reproducible; audit and logs show each state transition. No real BoxLite dependency.

---

## 5. Work required from Agent C — Sandbox Provider

**Owned folder:** `services/sandbox-provider/**`  
**Runtime:** Python + FastAPI + BoxLite Python SDK + own PostgreSQL  
**Prohibited:** Graphile Worker, document business logic, application schema.

**Build**
- Generic authenticated API and versioned OpenAPI schema.
- Separate registry DB/migrations for sandboxes, runs, OCI profile/image digest, box identity, disk references, audit events.
- `SandboxRuntime` interface; BoxLite implementation first. Support future provider adapters **without promising migration of running boxes**.
- Pinned/tested BoxLite SDK and prepared generic OCI fixture images.
- Proper persistent API for create/get/start/stop/exec; **avoid any convenience API whose cleanup automatically removes boxes**.
- Allowed workload profile registry, bounded argument schemas, resource/network/file constraints, and safe artifact export.
- One active run per sandbox; idempotent create/execute; explicit `stop` versus destructive `destroy`.
- Recovery after Provider process restart and host restart by reattaching to the retained BoxLite disk.
- Logs with correlation, `sandbox_id`, run IDs, lifecycle changes, resource measurements; append-only audit records.
- Health/readiness, README, migrations and dependency lockfile.

**Automated and real-runtime tests**
- Unit: lifecycle policy, profile allowlist, argument/path validation, auth, idempotency, locking.
- API contract: all endpoints return specified shapes/errors; malformed requests never become arbitrary shell execution.
- Real runtime: create sandbox from pinned generic image → write marker file → stop → reattach/start → read marker → execute another command → explicitly destroy a disposable test box.
- Provider restart: restart its process while box is stopped, recover box ID and retained disk.
- Host restart: test if the environment permits; otherwise report this as **not verified and a release blocker for persistent deployment**, not a pass.
- Two-box isolation: files in Box A not readable from Box B; no unauthorized shared mounts.
- Failure: interrupted execution, missing disk, runtime failure, duplicate stop/execute, unsupported image, disk quota.
- Audit/log tests: creation, start, run, stop, restart, failure and destroy all recorded with service identity, timestamp, correlation ID and outcome.
- Secrets: no raw LiteLLM/API credential values in logs or reusable VM image.

**Acceptance gate C:** Real BoxLite stop/restart retains filesystem, registry survives Provider restart, and audit/logs are accessible. Host-restart persistence remains an explicit validation gate before production.

---

## 6. Integration test before Phase 2

**Use a generic fixture workload, not the Document Assistant.** Example: approved `fixture-write-file:v1` creates a small text file; another profile reads it after stop/start.

Run the following in a **real integration environment** (not mocks):

1. Client submits a job through **Runner API** with unique idempotency key.
2. Runner queues and dispatches to **Provider API**, which creates a persistent BoxLite sandbox.
3. Workload writes a marker file; Provider returns run result; Runner reports completion.
4. After a **configurable** idle interval, Runner requests a non-destructive stop.
5. Simulate a later client request with `sandbox_id`; Runner reuses the same box and reads the marker file.
6. Restart Runner and Provider independently; verify DB state, event replay and retry correctness.
7. Restart host if feasible; verify persistent VM state and registry recovery.
8. Run two unrelated clients/boxes; verify isolation, auth and lack of cross-access.
9. Trigger worker failure/timeout and verify recovery without a duplicate run.
10. Query both services' logs/audit endpoints or persisted audit tables; verify end-to-end correlation and redaction.

### Required deliverables

- Both services runnable with reproducible local setup and pinned dependencies.
- Two independent DB migration sets and separate access credentials.
- Versioned OpenAPI contracts, fixture client and integration test runner.
- Unit, database integration, contract, failure and real BoxLite test reports (pass/fail/skip clearly identified).
- Structured logs and persisted audit trails, queryable for an individual job and sandbox.
- Health/readiness, operator documentation, backup/restore instructions and known limitations.
- Release tags or immutable commits for **Runner v1** and **Sandbox Provider v1**, with container image digests if applicable.
- A signed-off **Phase 1 verification record** describing commands actually run and observed outputs.

### What counts as "validated"

Do not use a subjective "100% tested" label. Use a **reproducible, evidence-backed pass/fail gate**:

| Gate | Required evidence |
|---|---|
| API contract | Contract tests pass for Runner↔Provider |
| Durable execution | Real queue/database integration tests pass |
| Sandbox persistence | Real stop/start file retention passes |
| Process restart | Runner + Provider restart recovery passes |
| Host restart | Explicitly run and pass before relying on 5-day retained VMs |
| Isolation | Auth, workload allowlist and two-sandbox negative tests pass |
| Observability | Correlated logs, health/metrics and audit records demonstrably present |
| Operational safety | No secret leakage; stop ≠ destroy; no duplicate active runs |
| Documentation | README, environment variables, limitations and recovery procedures verified |

**Gate decision:** Only after the integration owner verifies this evidence do we treat the reusable services as stable dependencies for Phase 2. Defects must be fixed in their respective services, not patched around by the Application.

---

## 7. Parallel development and repository boundaries

```text
workflow-agents/
├── PHASE-1-REUSABLE-SERVICES.md       # this file
├── PHASE-2-DOCUMENT-ASSISTANT.md      # later stage
├── services/
│   ├── job-runner/                    # Agent B ONLY
│   └── sandbox-provider/              # Agent C ONLY
└── ...
```

- Agent B and C work concurrently in **separate branches/worktrees**; they do not edit the same files.
- Agree on the generic API contract first, but each may implement against mocks until integration.
- No shared database writes, no cross-service ORM model imports.
- A separate integration reviewer/QA agent checks results and runs the combined tests; a developer agent's own "tests passed" claim is not sufficient.
- Do not merge incomplete contracts or incompatible endpoint changes silently. Breaks require a reviewed versioned contract update.
- Do not begin Phase 2 UI work in the infrastructure branches.

---

## 8. Copy-ready agent assignments

### Agent B — Reusable Job Runner

> Implement only `services/job-runner/**` using `PHASE-1-REUSABLE-SERVICES.md`. Build a **generic** standalone TypeScript/Graphile Worker service with own PostgreSQL DB, authenticated REST API, delayed jobs, retry/idempotency, scheduling, state inspection, audit logs and a typed **mockable** Sandbox Provider HTTP client. No document, Pi, SRT or application-specific fields. Include unit/integration/contract/security and failure-injection tests, README and a reproducible verification report. Do not mark work complete without running tests.

### Agent C — Reusable Sandbox Provider

> Implement only `services/sandbox-provider/**` using `PHASE-1-REUSABLE-SERVICES.md`. Build a **generic** FastAPI/Python service around BoxLite with its own PostgreSQL registry and authenticated create/start/stop/execute/inspect/destroy API. Use pinned approved images/workload profiles, persistent VM disks, recovery across provider/host restarts, bounded resources, audit logs and independent tests. Do **not** hardcode Pi/OfficeCLI, SRT or requester lifecycle. Demonstrate a generic marker-file workload across stop/start. Record exactly what is verified versus blocked by missing host virtualization.

### Integration/QA agent — Phase 1 Gate

> Independently validate both implementations against `PHASE-1-REUSABLE-SERVICES.md`. Run unit, real-DB, contract, service-restart, BoxLite persistence, authorization/negative, retry/idempotency and logging/audit tests. Confirm the services interoperate through HTTP with no cross-database access. Provide command/output evidence and a pass/fail matrix. Do not approve Phase 2 until the required release gates pass.

---

## 9. Open points and careful boundaries

**Agreed:** Graphile Worker for Runner, Python FastAPI + BoxLite SDK for Provider, independent DBs, reusable external APIs, persistent-box support, two-stage delivery.

**Implementation decisions still open:** Auth scheme, telemetry exporter, exact API/client package generation, per-client quotas, fixture workload representation, BoxLite version/host compatibility, object transfer mechanism and provider deployment. Record these decisions as tested implementation choices.

**Pi and LiteLLM:** Not required to validate generic infrastructure in Phase 1. A minimal agent-capable OCI profile may be smoke-tested, but the **Document Assistant's Pi/OfficeCLI/SRT profile is Phase 2 work**. LiteLLM already exists and must not be rebuilt.

**Security qualification:** Fresh microVMs isolate process/disk state only to the degree enforced by the runtime and host configuration. Agent outputs, networking, shared mounts, secrets and uploaded content still require controls.

**Deliverable:** Two reusable, separately tested infrastructure services with stable APIs and verifiable logs/audit trails, ready for multiple consuming applications.
