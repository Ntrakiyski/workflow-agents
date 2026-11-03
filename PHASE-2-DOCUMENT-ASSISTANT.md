# Phase 2 — Build the Document Assistant Application and Its First Real Use Case

**Project:** Project Documentation Assistant  
**Stage:** 2 of 2 — application and real use case, **after** Phase 1 verification  
**Status:** Implementation handoff; not implemented or tested  
**Date:** 2026-11-03  
**Dependency:** [Phase 1 — Reusable Infrastructure Services](./PHASE-1-REUSABLE-SERVICES.md)  
**Product definition:** [Lightweight Microservices Architecture](./PROJECT-DOCUMENTATION-ASSISTANT-LIGHTWEIGHT.md)

## 1. Goal and prerequisites

Use the **already validated, reusable** Job Runner and Sandbox Provider as external services to deliver the first actual product use case: an HPE employee submits a document request and gets a correctly produced document, then returns later to request revisions.

**Goal:** Prove a complete document request → Pi+LiteLLM+OfficeCLI generation → delivered Version 1 → idle BoxLite stop → restart with **same Pi session** → feedback-driven Version 2 workflow, with real API integration, frontend behavior, backend correctness and auditability.

**Phase 2 must not start as a production claim** if Phase 1 cannot provide authenticated, versioned API endpoints, durable jobs, stop/start persistence, audit logs, and passing integration tests. If Phase 1 is incomplete, Application scaffolding may proceed with mocks but **real integration must be labeled blocked**.

### What already exists and is NOT to be rebuilt

- **LiteLLM**, already operated and configured independently. Connect to its approved endpoint; do not create a new proxy, models, or LLM service.
- **Graphile Worker Runner**, built and independently verified in Phase 1. Use its generic `/v1/jobs` API; do not add SRT columns or code to it.
- **BoxLite Sandbox Provider**, built and independently verified in Phase 1. Use its generic sandbox API; do not hardcode Pi or Word document logic into its core runtime.
- **Existing Oden document skills and OfficeCLI procedures**, provided as assets to reuse after their path/version and HPE-permitted test input set are identified. The original Copilot CLI results are a quality baseline, not proof that Pi has already passed the same tests.

---

## 1A. Strict Phase 1 dependency boundary and agent guidance

**Phase 2 is a consumer, not a contributor to Phase 1 internals.** Implementation may begin with mocks, but real integration depends on the **released, independently validated** Runner/Provider APIs from [Phase 1](./PHASE-1-REUSABLE-SERVICES.md).

- Pin the exact Runner and Provider release versions and consume only their authenticated, documented APIs.
- Configure job profiles, allowed OCI images, model alias, skill bundle and scheduling/deadline values externally. Do not add application-specific fields, handlers, SQL tables or conditionals inside those infrastructure services.
- The Application and its document-agent workload are **new Phase 2 code**—so Phase 2 is not literally configuration-only. What remains configuration-only is how Phase 2 **uses Phase 1**, assuming Phase 1 has the promised generic capabilities.
- A new future use case should follow the same pattern: application/business logic plus approved workload profile, with no infrastructure source changes.
- If a capability is missing, stop and file a **generic, versioned Phase 1 change request**. Run its own release checks and backward-compatibility suite before using the new API version. Do not modify Runner/Provider as a convenience workaround.
- Phase 2 acceptance includes a test proving that the application works against a **pinned Phase 1 release** with no modifications to `services/job-runner/**` or `services/sandbox-provider/**`.

**Agent development and operation instructions:**
- Application: [AGENTS.md](./apps/application/AGENTS.md), [development skill](./apps/application/.agents/skills/application-development/SKILL.md), [operations skill](./apps/application/.agents/skills/application-operations/SKILL.md).
- Job Runner and Sandbox Provider: their own Phase 1 `AGENTS.md` and scoped skills remain the only authority for their development/operations.
- `README.md` plus automated test/CI scripts must verify real behavior; agent skill guidance does not substitute for reproducible checks.
- Run agents from the service directory or explicitly load the scoped skill, as nested skill discovery depends on the agent's working directory.

---

## 2. Three-service integration

```text
Browser / Document requester
              |
              v
┌───────────────────────────────────────────────┐
│ APPLICATION SERVICE — React + Fastify / TS     │
│ Application PostgreSQL + self-hosted S3       │
│ HPE users/projects, skills, requests, versions│
│ feedback, clarification, history, SSE         │
└───────────────────────┬───────────────────────┘
                        | Generic /v1/jobs API
                        v
┌───────────────────────────────────────────────┐
│ REUSABLE JOB RUNNER — Graphile Worker / TS     │
│ Own DB, job execution, retry, event + timers  │
│ (validated in Phase 1; not modified for SRT)  │
└───────────────────────┬───────────────────────┘
                        | Generic sandbox /v1 API
                        v
┌───────────────────────────────────────────────┐
│ REUSABLE SANDBOX PROVIDER — FastAPI / Python   │
│ Own DB; persistent BoxLite VM lifecycle       │
│ (validated in Phase 1; not modified for SRT)  │
│                                               │
│  BoxLite persistent VM for one request:       │
│    Pi runtime + skills + OfficeCLI            │
│    input copies, session JSONL, outputs       │
└───────────────────────┬───────────────────────┘
                        | Restricted inference
                        v
                   Existing LiteLLM
```

### Ownership and contracts

| Component | Owns | Must NOT own |
|---|---|---|
| Application | Users, HPE projects, request/revision lifecycle, skill catalog, all original/output files, 15-minute domain policies, UI | Queue internals, VM disk paths |
| Job Runner | Generic `job_id`, retries, schedules, attempts, job/event logs | SRT structure, HPE login, document version decisions |
| Sandbox Provider | Generic `sandbox_id`, box stop/start/exec, disk and process records | HPE user records, SRT template semantics, document approval |
| `pi-document-agent` workload profile | Pi launch, approved skills, OfficeCLI tooling and agent session restoration | Runner queue DB and Application user authorization |
| Existing LiteLLM | Model routing for approved alias | Business workflow and document storage |

**Policy placement:** The Application decides the *meaning* of clarification or delivery deadlines; Runner schedules a generic delayed action; Sandbox Provider only starts/executes/stops a box.

**State ownership:** Application DB for `request_id`, `revision_id`, user, project and versions; Runner DB for `job_id`/attempt/deadline; Provider DB for `sandbox_id` and box reference. No service directly reads another service's DB.

---

## 3. Work package A — Application Service (Agent A)

**Owned directory:** `apps/application/**`  
**Stack:** React + TypeScript, Fastify + TypeScript/Node, own PostgreSQL, S3-compatible object storage  
**Goal:** Deliver the employee experience and fully tested business/application APIs, without reinventing queue or sandbox logic.

### Features

- One initial organization, **HPE**, local user accounts and project membership. Plan schema keys for future organizations; do not build a multi-org admin UI now.
- Curated automation catalog: approved SRT authoring and, later, other explicitly tested skills. A skill entry binds ID, description, supported inputs, template version and Git commit.
- Hybrid request UI: automation selection, natural-language instruction field, attachment upload.
- Request details UI with states, step progress, errors and Server-Sent Events.
- Preview and download of valid generated files, with available validation/issues summary.
- General text + optional image/screenshot revision feedback, not a full editor or inline comment system.
- Persistent request and version history; requester can return days later.
- Clarification question UI with a 15-minute server-defined deadline and explanation of conservative fallback.
- Requester response window with accept/request-changes actions and separate 15-minute eligible auto-finalization.
- No formal human reviewer role. Independent human-in-the-loop is **only for material clarification**.

### Suggested Application tables

`organizations`, `users`, `projects`, `project_memberships`, `skill_catalog`, `document_requests`, `revisions`, `source_attachments`, `output_versions`, `clarification_questions`, `clarification_answers`, `request_events`. Store objects in S3, not as large DB blobs.

### Browser/API contracts (proposed)

| Route | Action |
|---|---|
| `POST /api/requests` | Create long-lived request and first revision; call Runner with generic job payload |
| `GET /api/requests/:id` | Request detail/status, permissions and versions |
| `GET /api/requests/:id/events` | SSE status stream; reconnect/deduplicate events |
| `POST /api/requests/:id/feedback` | Create next revision (text and attachment refs) against same request |
| `POST /api/requests/:id/clarifications/:qid/answer` | Record answer and enqueue resume job |
| `GET /api/requests/:id/versions` | All available versions |
| `GET /api/versions/:id/download` | Authorized scoped download |
| `POST /api/requests/:id/accept` | Record requester acceptance for eligible version |

**Backend correctness matters as much as UI.** Test authorization, DB transactions, revision monotonicity, input/object ownership, SSE replay, request idempotency and long-lived history. Browser tests alone are insufficient.

### Application → Runner mapping

Illustrative, contract names subject to the frozen Phase 1 API:

```json
{
  "client_reference": "document-request:req_1042/revision:rev_0002",
  "workload": {
    "profile": "pi-document-agent:v1",
    "arguments": {
      "skill_bundle_ref": "approved-skill-git-commit",
      "input_bundle_ref": "scoped-input-reference",
      "previous_output_ref": "scoped-previous-version-reference",
      "feedback_ref": "scoped-feedback-reference",
      "model_alias": "document-agent",
      "session_mode": "resume"
    }
  },
  "sandbox": {
    "mode": "reuse",
    "owner_ref": "document-request:req_1042",
    "profile": "document-agent-box:v1",
    "persistent": true
  },
  "limits": {
    "max_duration_seconds": 1800,
    "max_attempts": 2
  }
}
```

The sample 1800-second limit is illustrative, **not** a selected final budget. Backend resolves authorized profiles and object references; no user can submit arbitrary signed commands to the Provider.

---

## 4. Work package D — Document-Agent Workload Profile (separate integration ownership)

**Owned directory:** `workloads/pi-document-agent/**` (proposed new path)  
**Stack:** OCI image with Linux/Node.js, Pi, OfficeCLI, approved skills, render/validation dependencies  
**Goal:** Package the existing document procedure as a **versioned workload profile** that the Phase 1 generic Sandbox Provider can launch, without hardcoding OfficeCLI into Provider service code.

### Workload responsibilities

- Build and pin a reproducible image containing Pi, OfficeCLI, global operational skills and tested supporting tooling.
- Load SRT-specific skill, template and sample inputs from approved immutable refs.
- Connect Pi to the existing LiteLLM proxy using a configurable validated model alias; no upstream provider credentials baked into image/sessions.
- Run Pi headlessly with sessions **enabled**. Save the session JSONL in the retained writable disk and record a stable session path/key.
- On later revisions, reopen the existing session and load previous output/source files plus new feedback.
- Use OfficeCLI to create or update a **copy** of the template/previous output; keep originals intact.
- Run the current skill-specific verification steps, basic structural/render checks and actual file-open tests.
- Report structured outcomes and issues; never report fabricated PASS evidence.
- Support material clarification by emitting a **structured `needs_clarification` result**, not a free-form instruction to the user.
- Produce an artifact manifest with checksums, validation status, and an exported session/checkpoint reference.

**Example workload result (illustrative):**

```json
{
  "outcome": "needs_clarification",
  "questions": [
    {
      "id": "q_001",
      "question": "The notes and screenshot disagree about the API result. Which should be documented?",
      "reason": "Contradictory provided sources",
      "blocking": true,
      "source_refs": ["notes.txt", "screenshot-03.png"]
    }
  ],
  "artifacts": [],
  "session_checkpoint_ref": "opaque-checkpoint-reference"
}
```

The workload is an optional execution profile on generic infrastructure, not a fourth required independent database microservice. The Application and Runner manage business and execution state; the Provider runs an authorized pinned profile.

### Source assets to onboard

The original handoff identifies `docx-template-testscript`, `docx-template-usecase`, `srt-video-and-screenshots-update`, OfficeCLI skill and generic conversion/validation tools. **Their actual contents must be accessed and tested**; this file does not assume exact paths, templates or CLI flags are currently present in this repository.

**Baseline criterion:** Compare generated outputs and evidence placement against known-good local Copilot CLI executions on permitted sample inputs. Do not claim parity without a reproducible comparison.

---

## 5. Request, clarification and revision lifecycle

### Version 1

1. Application authenticates requester, stores original input and creates `request_id`, `revision_id`.
2. Application submits generic Runner job `profile=pi-document-agent:v1`, sandbox `mode=ensure`, `owner_ref` tied to request.
3. Runner allocates a box via Provider, executes the approved document profile and observes results.
4. Pi with LiteLLM works inside BoxLite; OfficeCLI produces the document and validation information.
5. Provider exports artifacts; Runner reports them; Application verifies/stores Version 1 and displays it.
6. Runner schedules a **five-minute idle stop** after execution is finished and data/session are durable. Provider stops **without deleting** box files.

### Five days later: Version 2

1. User opens the **same request** and submits general text and optional screenshots.
2. Application creates a **new revision** under the same `request_id`.
3. Runner schedules a new execution with `sandbox.mode=reuse` and same opaque owner reference / `sandbox_id`.
4. Provider starts the original stopped box. Workload reopens the saved Pi session explicitly.
5. Pi sees relevant previous context, previous files and new feedback; produces Version 2.
6. Application retains Version 1 and Version 2; box stops again when idle.

**Important:** A stopped VM preserves its disk, not necessarily the exact running Pi process memory. Session continuity comes from explicit saved conversation/checkpoint files. Real restart + Pi resume must be proven after service and host restarts.

### Clarification (15 minutes; max 3 rounds)

- Pi emits structured material question; Application displays it; Runner schedules a generic deadline.
- Resume with user answer when provided in time.
- On no response, Application decides an approved conservative response policy and queues continuation. The agent may mark unknown/placeholder or return blocked, but must never invent facts or test results.
- No VM needs to run while awaiting the answer.
- Persist question, reason, answer/timing, fallback and result for traceability.

### Requester delivery (15 minutes)

- Eligible output appears as `awaiting_requester`; requester accepts or requests changes.
- If no response after 15 minutes, Application records **`timeout_finalized`**, not `human_approved`.
- Validation-blocked documents do not automatically become valid through timeout.
- A finalized output may be revised later using same history and Pi session.

**Do not make the generic Runner decide that an SRT is approved or what missing content to invent.** It executes delays; the Application owns document policy.

---

## 6. Tests required for Phase 2

### Agent A — Backend and frontend testing

- Unit tests for request/revision state transitions, RBAC, file type/size checks, deadline calculations, feedback and object ownership.
- Integration tests with **real Application PostgreSQL** and S3-compatible test storage.
- API tests for authorized and unauthorized user/project access, idempotent POSTs, version retrieval, expired signed URLs, invalid callbacks.
- Contract tests for the validated Phase 1 Runner API (no direct Provider DB access).
- SSE reconnect, replay, deduplication, status consistency.
- Frontend tests for select/upload/submit, progress/errors, clarification questions, document preview/download and later feedback.

### Agent D — Pi document profile testing

- Image build, pinned tool versions, runtime availability, original skill-loading behavior.
- End-to-end Pi→LiteLLM→OfficeCLI command execution on a permitted SRT fixture.
- Document opens, template-required sections preserved, screenshots/evidence in intended places, no invented results.
- Session JSONL saved, resumed after BoxLite stop/start, and previous output available.
- Screenshots + feedback produce a new artifact; previous version unchanged.
- Model/network failure, timeout, invalid image, unsupported template and blocked evidence cases.
- Output file checksum and validation report independently corroborate agent claims.

### End-to-end QA (must run in addition to developer tests)

| Scenario | Expected proof |
|---|---|
| Happy path | Real browser submission creates a valid SRT document and external artifact |
| Input safety | Missing/contradictory notes generate a clarification or visible gap, not invented success |
| Five-minute stop | Box stops only after execution/export and retains disk and Pi session |
| Five-day revision | Simulated delayed feedback reopens same box/session and produces Version 2 |
| Persistence | App, Runner, Provider restart and host reboot preserve necessary state |
| Isolation | Project B cannot read Project A files, versions, or agent session |
| Error path | Disconnected LiteLLM / Provider failure yields bounded retries and intelligible UI error |
| Timers | 15-minute clarification and requester windows survive service restart |
| Duplicate delivery | Retried job does not create duplicate active Pi runs or overwrite prior file |
| Audit and logs | Trace browser request → job → box → artifact, with timestamps, actors and no leaked credentials |
| Known-good parity | Real SRT output compared to permitted baseline, differences documented |

**A passing UI screenshot is not sufficient.** Tests must cover frontend, Application API, DB/storage, Runner API, Provider runtime, Pi session persistence and real OfficeCLI artifacts.

---

## 7. Gate for calling the use case working

**Before declaring Phase 2 complete:**

1. The **Phase 1 gate** remains passed at the exact service versions being used.
2. Application and document-agent profile have reproducible passing unit/integration/component tests.
3. A real authorized user can submit files via UI and obtain a valid, downloadable Version 1.
4. Idle stop preserves the VM; same-request feedback reopens its Pi session and yields Version 2.
5. Both document versions and original inputs are stored outside the VM and recoverable.
6. Unauthorized access, duplicate jobs, unclear evidence, and service failures are tested.
7. Requester/clarification timeout behavior is implemented according to product decisions and verified with controlled time tests.
8. Structured logs, audit records and a traceable correlation chain exist through all three services.
9. Results are compared against existing skill outputs and acceptance defects documented.
10. Known limitations, security/data-processing approvals and operational recovery steps are recorded.

**No "100% reliable" claim without repeatable evidence.** When a test is skipped because credentials, real HPE sources, host KVM or approvals are absent, record the blocker clearly.

---

## 8. Development handoffs and branch ownership

```text
workflow-agents/
├── PHASE-1-REUSABLE-SERVICES.md       # complete first
├── PHASE-2-DOCUMENT-ASSISTANT.md      # this file
├── services/
│   ├── job-runner/                    # Phase 1 reusable; no document coupling
│   └── sandbox-provider/              # Phase 1 reusable; no document coupling
├── apps/
│   └── application/                   # Agent A only
└── workloads/
    └── pi-document-agent/             # Agent D only; approved BoxLite profile/image
```

- Build on separate branches/worktrees; do not let multiple agents edit the same files concurrently.
- Do not change reusable service behavior just to make an SRT request pass; if a generic capability is genuinely missing, issue a **versioned** Runner or Provider change with its own Phase 1 regression tests.
- Each agent owns local DB migrations, code, tests, README, OpenAPI usage notes and environment example for its own area.
- Reconcile shared contracts through an integration reviewer; the previous three-service handoff contains older mixed-phase instructions and should not override the split documents.

### Copy-ready Agent A — Application

> Read `PHASE-2-DOCUMENT-ASSISTANT.md`, `PHASE-1-REUSABLE-SERVICES.md`, and the lightweight architecture. Implement only `apps/application/**`. Build React + Fastify application, own PostgreSQL DB, S3 artifact adapter, HPE local auth/project permissions, approved skill selection, request/upload, status/SSE, clarification UI, document preview/download, general text/image feedback and persistent version history. Consume the frozen **generic Runner API**, first through mocks then integration. Never query Runner or Sandbox DBs; do not write BoxLite code. Add real backend tests, frontend tests, contract tests, audit/logging and a reproducible report of what passed and failed.

### Copy-ready Agent D — Document Agent Profile

> Read `PHASE-2-DOCUMENT-ASSISTANT.md` and the Phase 1 service contract. Implement only `workloads/pi-document-agent/**`. Build a pinned BoxLite-compatible OCI workload profile with Pi, OfficeCLI, existing approved document skills and validation. Connect to an **existing LiteLLM endpoint** through configured secret injection. Save/reopen the same named Pi session across persistent VM stop/start and later revision, and export artifacts with checksums and structured issues. Prove an SRT Version 1 and Version 2 using approved fixtures. Do not modify generic Runner/Provider code without a versioned and independently tested proposal.

### Independent Phase 2 integration/QA agent

> After Phase 1 gates pass and Agents A/D have completed their own tests, run end-to-end real-service and browser tests for SRT generation, 5-minute box stopping, five-day-later session resume, document version preservation, 15-minute no-response behavior, unauthorized access, duplicate/retry recovery and correlated audit logs. Verify the actual output document and Pi session history, not just UI statuses. Produce a pass/fail evidence table and identify blockers without silently relaxing requirements.

---

## 9. Open implementation details (not invented)

- Which real SRT template, screenshots and skill bundle may be used and under what HPE processing approval?
- Exact LiteLLM author model alias, network endpoint, key mediation and per-job usage budget.
- Whether OfficeCLI correctly preserves each required real SRT/UC template structure and evidence placement under Pi.
- UI library/viewer choice, object storage product, auth/session library, upload limits and user concurrency.
- Event transport from Runner to Application (polling or authenticated callbacks), without direct DB coupling.
- How long persistent request boxes may occupy disk before archival/deletion under HPE policy, and tested backup/restore procedure.
- Actual performance of BoxLite stop/start and Pi session reopening on target hardware.
- Whether a more extensive review skill is needed after baseline tests; the lightweight project does not automatically require separate author/reviewer LLM orchestration.

**Deliverable:** One fully integrated, independently tested Document Assistant use case proving that the validated reusable Job Runner and Sandbox Provider work for a real business application, without becoming tied to that application.
