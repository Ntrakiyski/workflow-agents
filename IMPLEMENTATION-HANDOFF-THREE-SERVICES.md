# Project Documentation Assistant — Three-Service Implementation Handoff

> **Superseded implementation sequence (2026-11-03).** This original handoff describes parallel development of all three services. The agreed plan now has **two gated phases**: first build and independently validate the generic Runner and Sandbox Provider, then build the Document Assistant application and its Pi/OfficeCLI workload. Use [Phase 1 — Reusable Services](./PHASE-1-REUSABLE-SERVICES.md) and [Phase 2 — Document Assistant](./PHASE-2-DOCUMENT-ASSISTANT.md) as the active implementation instructions. This file is retained for historical context only.


**Status:** Proposed technical implementation contract — ready for three parallel development sessions, not implemented or tested  
**Date:** 2026-11-03  
**Repository:** [Ntrakiyski/workflow-agents](https://github.com/Ntrakiyski/workflow-agents)  
**Architecture reference:** [Lightweight Microservices Approach](./PROJECT-DOCUMENTATION-ASSISTANT-LIGHTWEIGHT.md)  
**Separate future-product reference:** [Full Version 3 Architecture](./PROJECT-DOCUMENTATION-ASSISTANT.md)

## 0. Instructions for all three coding agents

**Objective:** Implement three independently deployable services that communicate through versioned HTTP contracts. Each agent owns exactly one service folder, its database, migrations, tests, and README. They should be able to implement their service against mocks even before the other two exist.

**The three agents are:**

| Agent | Service | Language | Owns |
|---|---|---|---|
| **A** | Application | React + TypeScript + Fastify | UI, user/project access, document requests, original files, versions, feedback, application DB |
| **B** | Job Runner | TypeScript + Graphile Worker | Execution API, durable queue, task states, timers, retries, job Runner DB |
| **C** | Sandbox Provider | Python + FastAPI + BoxLite | Runtime provider API, box lifecycle, Pi launching, session/disk identity, Sandbox Registry DB |

**External service already available:** LiteLLM. **Do not build, deploy, or replace LiteLLM** as part of this project. Agent C configures Pi to call the existing model endpoint using approved credentials and model aliases; do not invent actual URLs, model names, or secrets.

### Non-negotiable rules

- Keep the product a **thin UI around existing document skills**; do not implement a generic visual workflow builder, YAML interpreter, Hatchet, or E2B Embed.
- One **persistent BoxLite VM per document request**; one Pi session saved on that VM for continuity across revisions. A new revision gets a new execution attempt, **not a new request/box**.
- Stop an idle VM after **five minutes**, **without deleting its writable disk**. Restart that same VM and reopen the saved Pi session when the requester returns days later.
- Keep document originals and exported versions **outside the VM**, controlled by the Application; retain important session checkpoints outside the VM for disaster recovery.
- Each service has a **separate logical PostgreSQL database and credentials**. They can run on one PostgreSQL server. **Never access another service's database directly.**
- Design for **one organization, HPE**, with project membership; include a future organization boundary in the application schema. Do not invent an enterprise SSO requirement.
- **HITL is clarification only**. No separate human reviewer or formal approval role. The requester may accept or request text/image-based changes; an eligible version may automatically finalize after its own 15-minute requester window.
- If a clarification goes unanswered for **15 minutes**, continue with the **least assertive allowed fallback** (explicit gap, authorized default, or blocked result); never fabricate evidence, passing tests, or approvals.
- Avoid claiming that a model or generated document has passed independent validation unless the checks actually ran and are recorded.
- All endpoint paths and message shapes below are **proposed contracts we own**, **not documented endpoints from BoxLite or Graphile Worker**.
- Any decisions not settled by this document go in each agent's **Assumptions / Open Questions** section; do not silently replace the chosen stack.

---

## 1. Architecture at a glance

```text
Browser / HPE Requester
         |
         v
+-----------------------------------------------------+
| A — APPLICATION SERVICE (React + Fastify, TypeScript)|
| - local user login, HPE projects, skill catalog      |
| - requests, uploads, outputs, feedback, SSE          |
| - own PostgreSQL + application-owned object storage |
+----------------------+------------------------------+
                       | POST /v1/executions
                       v
+-----------------------------------------------------+
| B — JOB RUNNER SERVICE (Graphile Worker, TypeScript) |
| - own PostgreSQL queue and execution records         |
| - retries, deadlines, deduplication, state changes  |
| - five-minute stop and 15-minute response timers    |
+----------------------+------------------------------+
                       | REST; no direct BoxLite SDK
                       v
+-----------------------------------------------------+
| C — SANDBOX PROVIDER SERVICE (FastAPI, Python)       |
| - own PostgreSQL sandbox/agent-run registry          |
| - BoxLite SDK, reusable image and persistent disks  |
| - create/start/stop/inspect/execute, artifact export |
|   +------------------------------------------------+ |
|   | BoxLite microVM, one per request               | |
|   | Pi + SKILL.md + OfficeCLI + rendering/validators| |
|   | saved Pi JSONL session + private workspace     | |
|   +---------------------+--------------------------+ |
+-------------------------|---------------------------+
                          | restricted HTTPS
                          v
                    Existing LiteLLM
```

**Source of truth:** A owns business requests and document artifacts; B owns scheduling/execution; C owns box lifecycle and local persistent VM state. The services exchange stable IDs and authenticated APIs only.

**Identifiers and ownership**

| Identifier | Owner | Scope |
|---|---|---|
| `project_id` | Application | HPE project |
| `request_id` | Application | Long-lived document request/history |
| `revision_id` | Application | One requested document revision (starts with v1) |
| `execution_id` | Job Runner | One queued attempt to produce a revision |
| `sandbox_id` | Sandbox Provider | Persistent VM allocated to `request_id` |
| `agent_run_id` | Sandbox Provider | A single Pi invocation inside the persistent VM |
| `event_id` | Sender | Deduplicated progress notification |

**Key invariant:** One `request_id` has no more than one active `sandbox_id`, and a `sandbox_id` must not have two concurrent Pi runs. An execution can fail/retry without creating a second persistent VM.

---

## 2. Repository boundaries for parallel agents

Suggested folders to create:

```text
workflow-agents/
├── PROJECT-DOCUMENTATION-ASSISTANT.md
├── PROJECT-DOCUMENTATION-ASSISTANT-LIGHTWEIGHT.md
├── IMPLEMENTATION-HANDOFF-THREE-SERVICES.md  <-- this contract
├── apps/
│   └── application/                          <-- Agent A ONLY
├── services/
│   ├── job-runner/                           <-- Agent B ONLY
│   └── sandbox-provider/                     <-- Agent C ONLY
└── ...                                      <-- add shared tooling only after agreement
```

**Conflict prevention**
- Agent A edits **only** `apps/application/**`; B edits **only** `services/job-runner/**`; C edits **only** `services/sandbox-provider/**`.
- All three read this handoff; **none** alters it or the two architecture documents without explicit coordination.
- Do not create a shared `contracts/` package from different sessions simultaneously. Implement the proposed contract locally and independently in each service first.
- Use **separate branches or Git worktrees** (for example `feature/application`, `feature/job-runner`, `feature/sandbox-provider`) if developing concurrently against one repository. Never have three agents editing the same checkout or pushing competing commits to `main`.
- After separate PRs pass local tests, an integration owner reconciles schemas/API compatibility. Shared OpenAPI/type generation can be introduced **after** the first contracts are frozen.
- At every commit, keep service-local migrations, tests and README together with the code that uses them.

### Agreed vs proposed stack

**Agreed directions:** Pi, existing LiteLLM, OfficeCLI, BoxLite, Graphile Worker in a TypeScript Runner, Python FastAPI Sandbox Provider, React/Fastify Application, three separate logical service DBs, persistent request-specific VM and Pi session.

**Suggested not yet finalized:** exact frontend build tool, UI component selection, TypeScript DB client/ORM, Python DB ORM, S3 implementation, authentication library, default concurrency, exact BoxLite SDK pin, actual LiteLLM model alias, HTTP auth scheme and hosting. Use configurable interfaces and record chosen versions rather than hardcoding invented requirements.

---

## 3. Shared HTTP/API contract (v1 proposal)

All service-to-service calls use **JSON over HTTPS** on private/service networks with an authenticated service identity. In local development, a scoped token may suffice; production mechanism (mTLS or short-lived tokens) is open. Document data travels via **scoped object URLs**, not inline multi-megabyte JSON.

**HTTP conventions**
- `/v1` for internal Runner and Provider routes; `/api` for browser-facing Application routes.
- `Idempotency-Key` for state-changing creation and execution submissions.
- UTC ISO-8601 timestamps with `Z`, server-calculated deadlines; no browser-clock authority.
- IDs treated as opaque UUID/ULID strings; no database IDs or VM storage paths exposed to browser.
- Errors: `{ "code": "...", "message": "...", "retryable": false, "correlation_id": "..." }`.
- All callbacks/events carry `event_id`; receivers deduplicate.
- All state transitions must be authorized and validated by the **owning service**, not by agent output.

### 3.1 Application Service: browser API (Agent A)

These are **our proposed endpoints**, not existing routes:

| Endpoint | Input | Output/behavior |
|---|---|---|
| `POST /api/requests` | project, skill ID/version, instructions, uploaded file refs | creates `request_id` and `revision_id`, then submits a Runner execution |
| `GET /api/requests/:requestId` | authenticated user | history, current status, latest revision |
| `GET /api/requests/:requestId/events` | authenticated user | SSE progress/status stream |
| `POST /api/requests/:requestId/feedback` | general text and optional image/file references | new revision under same `request_id` |
| `POST /api/requests/:requestId/clarifications/:questionId/answer` | requester answer | persists response, informs Runner |
| `GET /api/requests/:requestId/versions` | authenticated user | all accessible output versions |
| `GET /api/versions/:versionId/download` | authenticated user | scoped artifact download |
| `POST /api/requests/:requestId/accept` | requester action | marks eligible version requester-accepted |

**Application must not:** call BoxLite, read Runner/Sandbox DBs, store VM credentials, or expose a sandbox execution API to the browser.

### 3.2 Job Runner Service: application-facing API (Agent B)

| Endpoint | Input | Output/behavior |
|---|---|---|
| `POST /v1/executions` | immutable request/revision refs, skill version, file manifest, limits | `202` with `execution_id`, status `queued` |
| `GET /v1/executions/:executionId` | authorized service | status, timestamps, progress, issues |
| `POST /v1/executions/:executionId/cancel` | authorized caller | idempotent cancel intent |
| `POST /v1/executions/:executionId/clarification-answer` | question ID, answer, idempotency | resumes or records late answer |
| `GET /health/live`, `GET /health/ready` | probe | process and DB/queue readiness |

**Submission example (illustrative and non-secret):**

```json
{
  "request_id": "req_1042",
  "revision_id": "rev_0001",
  "project_id": "proj_hpe_01",
  "skill": {
    "id": "srt-create-docx",
    "version": "git:PINNED_COMMIT"
  },
  "input_manifest": [
    {
      "file_id": "file_001",
      "name": "notes.txt",
      "content_type": "text/plain",
      "size_bytes": 1234,
      "sha256": "SHA256_HEX_PLACEHOLDER",
      "read_url": "https://storage.example/short-lived-read-url"
    }
  ],
  "output_manifest": {
    "write_url_bundle_ref": "opaque-scoped-artifact-upload-reference",
    "format": "docx"
  },
  "model": { "alias": "document-agent" },
  "timeouts": { "idle_stop_seconds": 300, "clarification_seconds": 900 }
}
```

This is **contract data**, not executable YAML. Do not store short-lived signed URLs as durable source of truth; persist object keys/references and request fresh URLs when dispatching or resuming.

### 3.3 Sandbox Provider Service: runner-facing API (Agent C)

Provider is **generic** and should not understand SRT, HPE projects, business approval or application DB schema. `owner_ref` is an opaque mapping key supplied by the authorized Runner.

| Endpoint | Behavior |
|---|---|
| `POST /v1/sandboxes` | idempotently allocate a persistent box using approved image/profile and `owner_ref` |
| `GET /v1/sandboxes/:sandboxId` | report lifecycle status and non-sensitive metadata |
| `POST /v1/sandboxes/:sandboxId/start` | idempotently start/re-attach |
| `POST /v1/sandboxes/:sandboxId/stop` | stop without removal; reject if active run unless forced authorized cancel |
| `POST /v1/sandboxes/:sandboxId/execute` | start one approved command/profile; return `agent_run_id` immediately |
| `GET /v1/sandboxes/:sandboxId/runs/:agentRunId` | state, result, artifact manifest, safe progress |
| `POST /v1/sandboxes/:sandboxId/runs/:agentRunId/cancel` | cancel/terminate specific execution |
| `POST /v1/sandboxes/:sandboxId/destroy` | explicit authorized removal, **never a side effect of idle stop** |
| `GET /health/live`, `GET /health/ready` | runtime/registry readiness |

**Create example:**

```json
{
  "owner_ref": "request:req_1042",
  "profile": "document-agent-v1",
  "image": "approved-document-agent:PINNED_DIGEST",
  "resources": { "cpus": 2, "memory_mib": 2048 },
  "persistent": true
}
```

**Execute example:**

```json
{
  "execution_id": "exe_5001",
  "profile": "pi-document-runner",
  "arguments": {
    "skill_id": "srt-create-docx",
    "skill_version": "git:PINNED_COMMIT",
    "model_alias": "document-agent",
    "input_bundle_ref": "opaque-artifact-bundle-reference",
    "output_bundle_ref": "opaque-artifact-upload-reference",
    "session_mode": "create_or_resume"
  }
}
```

**Important:** `profile` and `arguments` are our registered execution profiles; the Provider validates them and uses approved commands. Do not interpret the submitted JSON as an arbitrary `bash -c` command. Provider owns the Pi launch adapter but should remain capable of launching other preapproved workload profiles later.

### 3.4 Progress and output events

Runner sends authenticated events (or an Application-pulled event stream) to A. **Use the same event envelope for all service actions.**

```json
{
  "event_id": "evt_0001",
  "request_id": "req_1042",
  "revision_id": "rev_0001",
  "execution_id": "exe_5001",
  "type": "execution.progress",
  "status": "generating",
  "timestamp": "2026-11-03T12:00:00Z",
  "detail": { "step": "officecli_document_generation", "message": "Document processing" }
}
```

Additional event types: `execution.queued`, `execution.started`, `execution.needs_clarification`, `execution.ready`, `execution.blocked`, `execution.failed`, `execution.cancelled`, `sandbox.stopped`. Events are not proof of success; A checks durable result/artifact metadata before presenting a completed document.

Use callbacks or Runner event polling as a first delivery mechanism; the exact transport is still **open**. Agent A's SSE stream is to browser clients only.

### 3.5 Structured agent result

The sandbox must never return only "done" as a trustworthy outcome.

```json
{
  "agent_run_id": "run_0001",
  "outcome": "completed",
  "artifacts": [
    {
      "kind": "document",
      "filename": "srt-v1.docx",
      "format": "docx",
      "storage_ref": "opaque-output-object-reference",
      "sha256": "SHA256_HEX_PLACEHOLDER"
    }
  ],
  "validation": {
    "structure": "passed",
    "render": "passed",
    "evidence": "not_verified"
  },
  "questions": [],
  "issues": [],
  "session_checkpoint_ref": "opaque-pi-session-checkpoint"
}
```

Allowed `outcome`: `completed`, `needs_clarification`, `blocked`, `failed`, `cancelled`. The owning services verify schema, permitted artifact paths, checksum and real validator results. An unsupported model assertion is **not** a validation pass.

---

## 4. State and lifecycle contracts

Three separate state machines exist, with cross-service correlation IDs.

**Application request/revision:** `draft → queued → running → awaiting_clarification → running → awaiting_requester → finalized` with `blocked/failed/cancelled` outcomes. A finalized request can later produce a new revision.

**Runner execution:** `queued → dispatching → executing → [waiting_for_input] → executing → exporting → completed`, or `retrying/failed/cancelled`. Runner enforces one active execution per box.

**Provider box:** `created → running → stopped → running → ... → destroyed`. Persistent storage must remain intact across **stop** and **start**. A box can outlive the worker and application processes.

### 4.1 Five-minute idle stop

- Start the idle timer **after a run is no longer active and outputs/session are durably written**.
- Runner schedules stop for `last_active_execution_at + 300 seconds`.
- Before stopping, Runner and Provider recheck no active execution or new revision arrived.
- Stop the **same** box; never call `destroy/remove` for an idle timeout.
- Provider persists box identity and disk reference; Runner persists its mapping; Application retains document history.
- A later revision uses the original `sandbox_id`, **not** a new box.

### 4.2 Clarification, 15 minutes

- Pi proposes a structured material clarification; Provider records `needs_clarification`.
- Runner updates the durable state, notifies Application, and starts a 900-second deadline; output/session checkpoint is persisted.
- VM can stop while awaiting human input.
- If requester replies before deadline, Runner resumes against the same box/session; ensure deadline task is cancelled or becomes a no-op.
- If no reply, Runner resumes with **conservative policy**: explicit unknown/placeholder or blocked result. No fabricated facts, execution success or accepted evidence.
- Limit to **three rounds**, batch related questions.
- Late user answers are recorded with an explicit status; do not silently mutate an already-completed run.

### 4.3 Requester delivery, 15 minutes

- When valid/eligible artifact is exported, Application enters `awaiting_requester` and records server deadline.
- Requester may accept or submit general text + screenshot/image feedback.
- After 900 seconds of no action, an **eligible** version is finalized as `timeout_finalized`, **not human_approved**.
- Invalid/blocked documents do not automatically become validated due to time passing.
- A finalized version can be revised tomorrow: a **new `revision_id` and `execution_id`** are created under the same `request_id`; the box and Pi session are reused.

### 4.4 Retry, idempotency and failure handling

- Graphile Worker is **at least once**, so an API call or job handler can happen again.
- Idempotency keys must map repeated create/execute calls to the same persistent resources.
- A DB-level lease or lock plus Provider-side single-active-run check prevents two concurrent Pi runs in one box.
- Retry transient network/API/host errors with bounded backoff; **do not automatically repeat content edits** without reconciling prior artifacts and session state.
- On crash or restart, query Provider run status before launching a replacement. If status is unknown, flag reconciliation rather than blind duplicate execution.
- Recover scheduled deadlines from PostgreSQL after runner restart.
- Capture cancellation separately from stop/delete.

---

## 5. Agent A — Application Service implementation brief

**Your assignment:** Own the entire user experience and Application API. Use the shared v1 contracts, **mock the Runner**, and do not implement queue or BoxLite logic.

**Owned path:** `apps/application/**`.

**Build**
- React + TypeScript frontend, Fastify API, application DB migrations and project/user authorization.
- HPE organization and project memberships (one org initially; organization key in schema).
- Curated skill catalog, request submission, file metadata, upload/attachment validation.
- S3-compatible object storage adapter with local development option and scoped URLs.
- Request/revision/version history, status, preview/download, feedback text+images.
- Clarification UI and deadline; SSE to browser for progress/errors.
- A typed Runner client implementing `POST /v1/executions` and `GET /v1/executions/:id` plus event subscription/mocked callbacks.
- Present outcome `timeout_finalized` clearly separately from requester acceptance.

**Suggested database tables (only yours):** `organizations`, `users`, `projects`, `project_memberships`, `skills`, `requests`, `revisions`, `attachments`, `document_versions`, `clarifications`, `request_events`. Exact schema/key fields to be defined in your service.

**Mock-first vertical slice**
1. Login (local pilot identity).
2. Select SRT.
3. Upload notes and screenshot.
4. Submit request and receive mock execution ID.
5. Show queued/running/ready via mock events.
6. Preview/download a **fixture** DOCX (clearly labeled mock).
7. Submit general feedback + screenshot and see Version 2 in history.

**Acceptance tests**
- Unauthorized users cannot access another project's documents/events.
- Submission results in one request and one initial revision even on browser retry.
- Uploads are linked to correct project/request.
- SSE reconnect/event deduplication leaves correct UI status.
- Revision after five days is attached to same request, without overwriting Version 1.
- A blocked result is not displayed as a validated success.

**Definition of done:** Service-local migrations, runnable app/API, README, tests, stub Runner integration, no dependency on Agent B/C code.

---

## 6. Agent B — Job Runner Service implementation brief

**Your assignment:** Build a generic durable execution scheduler and microservice; use **Graphile Worker**. Do not implement browser UI or directly import BoxLite SDK.

**Owned path:** `services/job-runner/**`.

**Build**
- TypeScript/Node.js worker service and small authenticated HTTP API (Fastify suitable).
- Own PostgreSQL schema and Graphile Worker queue configuration.
- Queue `start_execution`, `poll_agent_run`, `stop_idle_sandbox`, `clarification_timeout`, `requester_timeout`, and `reconcile_orphaned_run` registered tasks. Names are **proposed local task names**.
- Execution record with request/revision/sandbox links, idempotency, attempts, timestamps and durable deadline rows.
- Typed Sandbox Provider HTTP client; **mock Provider** and assert request/response compatibility.
- Retry policy, lease/single-flight lock, cancellation, reconciling after worker restart.
- Progress event publishing to Application; preserve event IDs, ordering and deduplication.
- Never invent direct SQL accesses to Application or Provider DBs.
- Track active execution separately from paused/stopped box lifecycle.

**Suggested tables (only yours):** `executions`, `execution_attempts`, `execution_events`, `deadlines`, `sandbox_bindings`, `idempotency_keys`, `execution_leases`. Graphile Worker manages its own queue tables inside this **Runner DB**.

**Mock-first vertical slice**
1. Receive execution request with `Idempotency-Key`.
2. Enqueue and return `execution_id`.
3. Claim job; ask mock Provider to create/start a box, stage files and execute.
4. Poll completion, capture output metadata, publish ready event.
5. Schedule stop at +300 seconds, recheck run idle, invoke mock stop.
6. Simulate revision five days later; restart the same `sandbox_id`.
7. Simulate clarification +900-second conservative timeout and requester +900-second finalization.

**Acceptance tests**
- Same idempotency key never creates two jobs/boxes.
- Two concurrent attempts against same sandbox do not run Pi twice.
- Worker crash during execution reconciles Provider state before any retry.
- Five-minute stop does not fire if a new revision is active.
- Timers survive process restart.
- Retry policy distinguishes transient service failure from document/validation failure.
- Run status/event IDs remain correct on duplicate callback.
- No direct import of BoxLite or dependency on Sandbox Provider database.

**Definition of done:** Isolated Graphile service with migrations, mock Provider adapter, durable state tests, API and README. No need to run a real VM for your local tests.

---

## 7. Agent C — Sandbox Provider Service implementation brief

**Your assignment:** Build a reusable generic sandbox microservice around **BoxLite Python SDK**, and a supported `pi-document-runner` workload profile. Do not implement Application/Runner schemas or document business logic.

**Owned path:** `services/sandbox-provider/**`.

**Build**
- FastAPI HTTP service with service authentication, input validation, structured errors and health/readiness.
- Separate Provider PostgreSQL registry for box/runtime IDs, state, disk references, image digest/profile, run IDs and last activity.
- Abstract runtime interface with a first `BoxLiteProvider`; other providers can be added later **for new boxes**.
- Use **persistent `Boxlite` runtime API**, not auto-removing convenience wrappers. `Boxlite.default()`, `create(...)`, `get(...)`, `box.exec(...)`, `box.stop()`, `box.info()` and `box.remove()` are documented SDK primitives; confirm exact version/pinning when coding.
- Build/pin OCI image containing Linux/Node.js, Pi, OfficeCLI, current approved skills, rendering and validation tools.
- Create/start/stop/re-attach boxes, transfer approved inputs, execute one task per box, stream safe progress, export artifacts, inspect, cancel, and explicit destroy.
- Persist Pi session JSONL on retained disk; restart Pi with the **specific saved session**, not `--no-session`.
- Store actual process/agent-run outcome separately from the VM status; stopping a box is not completing an agent run.
- Limit CPU/RAM, filesystem mounts, networking and credential exposure.
- Implement the document runner as a **registered workload profile**. Generic provider APIs never accept arbitrary untrusted shell scripts from callers.
- The provider may need an internal command/RPC bridge to Pi. If using Pi RPC, do not interpret a successful prompt acknowledgment as task completion; consume completion events through `agent_settled`.

**Suggested tables (only yours):** `sandboxes`, `agent_runs`, `box_runtime_refs`, `artifact_exports`, `provider_events`. Keep BoxLite writable disk contents and Pi session **outside Postgres**.

**Mock/real vertical slice**
1. Create a box using a pinned local OCI fixture image.
2. Execute a command and collect exit code/output.
3. Stop the box **without deleting** it.
4. Reattach/start the same box and verify a test file is still present.
5. Restart the Provider service, then reattach and verify state.
6. Run Pi connected to the configured LiteLLM model, loading a simple approved skill.
7. Save Pi session, stop box, restart and resume same session with second user turn.
8. Generate/edit a small DOCX via OfficeCLI; export and checksum it.
9. Test provider/host restart recovery; record any SDK limitations rather than assuming success.

**Acceptance tests**
- Stable `sandbox_id` maps to the same BoxLite writable disk after stop/start.
- `stop` and `destroy` are distinct; stop does not remove data.
- Two active runs for one sandbox are rejected.
- App/Runner credentials are never exposed to agent workspace.
- Bad file paths and unsupported command profiles are rejected.
- Health reflects registry and BoxLite runtime readiness.
- Pi session files are saved and resumed from a named path; a new revision can read prior workspace documents.
- Exported artifacts match expected checksums.
- VM state is recoverable after provider restart **and host restart**, or a precise blocker is documented.

**Definition of done:** FastAPI service, BoxLite adapter, registry migrations, pinned image/build instructions, tested persistent-stop/restart behavior, Pi/LiteLLM/OfficeCLI proof, README.

---

## 8. Test plan shared across the three sessions

| Phase | A: Application | B: Job Runner | C: Sandbox Provider | Cross-service result |
|---|---|---|---|---|
| **0 — Contracts** | Define local DTOs; mock Runner | Define local DTOs; mock Provider | Implement Provider DTOs | All match this handoff |
| **1 — Independent API** | Login/request UI + fixture | Queue/timers with mocks | Box create/start/stop with fixture | Each service tests independently |
| **2 — Simulated integration** | Render mock events/artifact | Dispatch mock execution | Return mock result | Full request flow without AI |
| **3 — Real agent integration** | Real inputs/download | Real Provider calls | BoxLite + Pi + LiteLLM + OfficeCLI | Real v1 DOCX generated |
| **4 — Persistence** | Revision history | Stop/restart/leases | Same VM/session after stop | v2 after simulated five days |
| **5 — Hardening** | Auth, retention, SSE | Retry/recovery/timers | Host restart, network/secret tests | Pilot acceptance evidence |

### Mandatory integrated acceptance scenarios

1. **Happy path:** SRT input → Pi + OfficeCLI → v1 DOCX; original unchanged.
2. **History:** v1 survives export, VM stop and Application reload.
3. **Five-day revision:** Restart same BoxLite VM + saved Pi session → feedback + screenshot → v2 DOCX, preserve v1.
4. **Clarification:** Material missing info → question → reply or +15-minute conservative continuation; no fake PASS evidence.
5. **Requester timeout:** Eligible document +15 minutes → `timeout_finalized`; explicit acceptance remains distinguishable.
6. **Failure:** Provider unavailable or model fails → clear retryable/non-retryable event, no duplicate Pi run.
7. **Recovery:** Worker restart and Provider restart do not lose deadlines, box refs or session files.
8. **Isolation:** User/project B cannot access A's original files, output objects or Pi session.
9. **Backups:** Test restoration of app object storage, DB records, Provider registry, BoxLite disk/session (not just backup creation).
10. **Baseline parity:** Compare generated SRT against permitted known-good local Copilot CLI output and existing regression fixtures; do not assert "100%" without evidence.

---

## 9. Shared nonfunctional requirements

**Security and data handling**
- The Application authenticates users and checks project authorization; internal services authenticate each other.
- Restrict BoxLite network destinations, including access to other projects, host services and private subnets.
- Use short-lived scoped storage links and model access; do not persist upstream API keys in skill files, snapshots or Pi session logs.
- Treat uploaded notes, documents and screenshots as **untrusted content** even in dedicated VMs.
- Reject unsupported extensions, macros and dangerous file types according to the approved processing policy.
- Require HPE permission for the actual chosen inference provider and document content flow.

**Operations**
- Correlation IDs in every log/event; configurable timeouts and bounded retries.
- Preserve session/checkpoint continuity but do not assume an in-flight Pi process resumes in RAM.
- Record BoxLite version, Pi version, OfficeCLI version, skill commit, model alias and sandbox image digest in execution metadata.
- Daily backups are the existing architectural goal; define tested RPO/RTO before broader rollout.
- No hard-coded host addresses, secrets, memory limits, API tokens or HPE production system identifiers in the repository.

**Licensing / component reality**
- Graphile Worker executes **TypeScript/Node.js** tasks, not native Python tasks.
- BoxLite is an SDK/runtime, so **the Python provider is a service we build around it**.
- BoxLite's `SimpleBox` convenience API may automatically remove data; use persistent runtime/box APIs for this design.
- Pi session storage must be explicitly enabled; `--no-session` prevents later conversation resumption.
- Existing LiteLLM is an **external dependency already configured by the user**; its concrete model aliases and endpoint must be supplied at deployment.
- An agent skill `SKILL.md` teaches behavior; authorization and command/network restrictions belong in executable code.

---

## 10. Ready-to-paste session instructions

These are initial developer handoffs, not additional implementation files.

### Agent A — Application

> You are Agent A, the **Application** owner. Read `IMPLEMENTATION-HANDOFF-THREE-SERVICES.md` and `PROJECT-DOCUMENTATION-ASSISTANT-LIGHTWEIGHT.md`. Implement **only** `apps/application/**`: React + Fastify + your own PostgreSQL DB, HPE local accounts/projects, curated skills, request submission, uploads, status/SSE, document preview/download, text/image feedback and revision history. Create a mock client for the Runner's proposed `/v1` contract; do not implement Graphile Worker, BoxLite or Pi. Start with the browser request → mock v1 document → feedback → mock v2 flow. Add migrations, tests, env example and README. Report any contract ambiguities instead of changing shared architecture.

### Agent B — Job Runner

> You are Agent B, the **Job Runner** owner. Read `IMPLEMENTATION-HANDOFF-THREE-SERVICES.md` and the lightweight architecture document. Implement **only** `services/job-runner/**`: Node.js/TypeScript + Graphile Worker with its own PostgreSQL DB, execution submission API, queue, idempotent scheduling, Provider HTTP client, status/events, retries, single-flight per sandbox, five-minute idle stop, 15-minute clarification and requester timers, cancellation and crash reconciliation. Mock the Sandbox Provider first. Do not implement the UI, Pi, BoxLite SDK or cross-database reads. Add migrations, tests, env example and README. Raise any contract changes as proposals.

### Agent C — Sandbox Provider

> You are Agent C, the **Sandbox Provider** owner. Read `IMPLEMENTATION-HANDOFF-THREE-SERVICES.md` and the lightweight architecture document. Implement **only** `services/sandbox-provider/**`: Python + FastAPI + BoxLite Python SDK, own PostgreSQL registry, generic authenticated create/start/stop/execute/inspect/cancel/destroy API, persistent VM disk across stop/start, Pi session persistence/resume, LiteLLM model access, approved skill/OfficeCLI image and artifact export. First prove stop/restart after a Provider and host restart using real BoxLite; do not treat `SimpleBox(auto_remove=True)` as a persistent box. Keep the API generic, do not implement App/Runner databases or document business rules. Add migrations, tests, env example and README. State exactly what works versus what is unverified.

---

## 11. Open implementation decisions — not blockers to scaffold

The following should be pinned through implementation/testing, not guessed:

- Exact React build solution and selected Extend UI components.
- Local authentication method and password/session security; production HPE approval.
- PostgreSQL ORM/migration library in A/B/C, exact S3 implementation, artifact signing and callback authentication.
- BoxLite SDK version, host virtualization compatibility, image build, host disk path and reboot behavior.
- Pi model provider configuration and actual LiteLLM alias; safe credential mediation.
- OfficeCLI regression behavior on real approved SRT templates.
- Runner-to-Application event transport choice (signed webhooks versus polling); use mock contracts until resolved.
- File upload limits, polling cadence, max concurrent boxes, cost/resource budgets and expiry/deletion policy.
- Exact authorization and eligibility rules for timeouts, conservative fallbacks and error states.

**Do not expand this into a generic automation-building platform before the first three-service vertical slice has been demonstrated.**

---

## 12. Primary technology references

- [Graphile Worker documentation](https://worker.graphile.org/docs) — PostgreSQL-backed queue with Node.js tasks and at-least-once processing.
- [BoxLite repository](https://github.com/boxlite-ai/boxlite) — embedded OCI/microVM runtime and persistence.
- [BoxLite Python SDK reference](https://github.com/boxlite-ai/boxlite/blob/main/docs/reference/python/README.md) — `Boxlite.create/get`, `Box.exec/stop/remove`, lifecycle and state.
- [Pi RPC reference](https://pi.dev/docs/latest/rpc) — language-independent process integration, command response versus agent completion.
- [Pi Sessions](https://pi.dev/docs/latest/sessions) — durable JSONL conversation sessions and explicit resumption.

**End state:** Three separately testable services; one real SRT flow; request-persistent BoxLite + Pi session; safe later revisions. The working, existing document skills remain the core business value.
