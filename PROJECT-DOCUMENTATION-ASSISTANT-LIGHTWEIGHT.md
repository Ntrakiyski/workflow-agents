# Project Documentation Assistant — Lightweight Microservices Approach
**Product Definition & Architecture — Pi + LiteLLM + OfficeCLI + BoxLite**

**Status:** Proposed architecture; not implemented  
**Updated:** November 3, 2026  
**Organization:** HPE (one organization initially)  
**Companion:** [Full Enterprise Architecture — Version 3](./PROJECT-DOCUMENTATION-ASSISTANT.md)

---

## 1. Project Vision

Give HPE employees a simple web interface for the **document skills that already work locally**, rather than first developing a general-purpose document-automation platform.

**Existing baseline:** The original operator reports high-quality SRT/Use Case results when running GitHub Copilot CLI in a folder containing `SKILL.md` instructions, templates and OfficeCLI. Those successes are the **comparison baseline**, not an endorsement that the new Pi runtime has already achieved identical quality.

**Current direction:** Expose those skills using **Pi + the existing LiteLLM proxy + OfficeCLI**, running in persistent request-specific BoxLite environments.

**Core principles**
- Reuse and version the approved skills and templates; do not reproduce them as a new generic YAML workflow language.
- Keep the requester experience simple: choose skill, provide rough instructions and files, inspect output, request changes.
- Build **three independently deployable microservices** with narrow APIs and independent databases.
- Keep the worker and sandbox infrastructure reusable for other workloads.
- Assign **one persistent BoxLite microVM per document request**; stop it when idle without losing files or the saved Pi conversation.
- Save important documents and session checkpoints outside the VM as well.
- Preserve originals; use validation and source-grounded reasoning rather than inventing content.
- Treat security, data classification and hosting approval as necessary gates for any HPE pilot.

**Goal:** A second employee can obtain an acceptable document from an approved skill through a browser, including revisions days later, without using a CLI.

---

## 2. Four Product Pillars

### Pillar 01 — User Experience & Application

**Purpose:** Own the employee-facing product, API, identity, requests, document versions and feedback.

**Core Capabilities**
- Hybrid request screen: choose SRT/Use Case skill, type informal instructions, attach screenshots and documents.
- Authenticate local HPE users and authorize project membership.
- Create persistent requests; show steps, progress and errors via SSE.
- Offer in-app document preview where reliable, and downloadable files.
- Display targeted agent clarification questions and their deadlines.
- Accept general natural-language change requests plus screenshot/image attachments.
- Keep all output versions available; a requester can return five days later for another revision.
- Keep application business data and source/output files under application ownership.

**Goal:** Employees use a simple document application instead of operating Pi, OfficeCLI or sandbox infrastructure.

**Technology Stack**
- **UI:** React + TypeScript; Extend UI is a preferred component candidate, not yet validated.
- **Application API:** Fastify + TypeScript/Node.js. A browser must not access the database or sandbox directly.
- **Application database:** Separate PostgreSQL logical database, owned only by the Application Service.
- **Files:** Self-hosted S3-compatible object store for originals, output versions, previews and critical checkpoints.
- **Updates:** SSE from the Application to its browser clients; Runner-to-Application event transport to be specified.

### Pillar 02 — Approved Skill Library

**Purpose:** Distribute the existing tested document automations without implementing a visual automation builder.

**Core Capabilities**
- Maintain a small catalog of approved skills, descriptions, required inputs and output families.
- Bundle existing `SKILL.md`, templates, examples, scripts and verification instructions.
- Pin a Git version/commit for each execution so outputs are traceable.
- Keep different workflows distinct: SRT creation, guarded SRT evidence updates, and Use Case drafting.
- Make skill changes through Git and test them before publishing to users.
- Reject unsupported formats/templates instead of guessing how to fill them.

**Goal:** Share the existing document capabilities as curated, reliable automations.

**Technology Stack**
- **Source of truth:** Existing skill/template files maintained in Git.
- **Catalog:** Small versioned JSON or YAML listing, not an executable workflow DSL.
- **No initial visual builder:** Adding arbitrary user-created automations is deferred.

### Pillar 03 — Agent & Document Execution

**Purpose:** Run Pi, OfficeCLI and the selected skill for the duration of a document request and its later revisions.

**Core Capabilities**
- Run Pi headlessly inside the request-specific BoxLite VM.
- Connect Pi to the **existing LiteLLM endpoint** using a backend-selected model alias.
- Load global skills and the approved request-specific document skill.
- Use OfficeCLI to inspect, generate, edit and render documents; validate the resulting artifacts.
- Preserve the original uploaded files and operate on working copies.
- Save the Pi session to durable files on the VM's retained writable disk.
- On a later revision, restart the **same** BoxLite VM and explicitly reopen the saved Pi session.
- Record missing information, blocked claims and failures instead of inventing test results.
- Keep tool/network permissions restricted; trusted skills are not a security boundary.

**Goal:** Reproduce the original document-generation quality using Pi + LiteLLM + OfficeCLI while retaining conversational continuity between revisions.

**Technology Stack**
- **Agent:** Pi runtime (Node.js) executing within the microVM.
- **Inference:** Existing LiteLLM; scoped job credentials or internal gateway design to be verified.
- **Document tools:** OfficeCLI, existing `SKILL.md` assets and skill-defined checks.
- **Sandbox:** BoxLite persistent microVM, allocated by the Sandbox Provider.
- **Session persistence:** Explicit Pi session files and job workspace on retained VM disk, backed up/exported according to policy.
- **No extra agent framework:** The Sandbox Provider is not a Pi-specific system; it launches approved commands in generic boxes.

### Pillar 04 — Independent Execution Infrastructure

**Purpose:** Run two reusable microservices independently of the Application: a durable Job Runner and a generic Sandbox Provider.

**Core Capabilities**
- Job Runner accepts authorized execution requests from the Application.
- Queue, dispatch, deduplicate and retry jobs; enforce concurrency limits and timeouts.
- Schedule **five-minute idle stops** and **15-minute clarification/requester deadlines** where applicable.
- Sandbox Provider creates, starts, stops, inspects and executes inside persistent BoxLite environments.
- Sandbox Provider maintains the mapping from public sandbox IDs to BoxLite runtime/disk identities.
- The Runner calls the Provider's authenticated API, never BoxLite's library directly.
- Three services own their own database schemas and credentials; no cross-database access.
- Preserve disk, agent session and request-to-sandbox mapping across service restarts; test physical host recovery.
- Enforce project isolation, sandbox networking and operational audit events.

**Goal:** Keep job execution and sandbox operation portable, independently deployable and reusable for future projects beyond document generation.

**Technology Stack**
- **Job Runner:** TypeScript/Node.js + [Graphile Worker](https://github.com/graphile/worker) + its own PostgreSQL database.
- **Runner API:** Small authenticated HTTP API (Fastify is a candidate), used by the Application.
- **Sandbox Provider:** Python + FastAPI + [BoxLite Python SDK](https://github.com/boxlite-ai/boxlite).
- **Sandbox Registry:** Its own PostgreSQL database with box IDs, disk references and lifecycle state.
- **VM storage:** BoxLite's persistent writable disk; this is not the same thing as the registry database.
- **Physical database hosting:** One PostgreSQL server may initially hold three **separate logical databases** using separate users; each service owns only its own database.
- **No Hatchet, Procrastinate or extra broker** in this choice.

---

## 3. Architecture Diagram & Ownership

```text
┌──────────────────────────────────────────────┐
│ 01 — APPLICATION SERVICE                     │
│ React + Fastify (TypeScript)                 │
│ Application PostgreSQL DB + S3 document store│
│ Users · Projects · Requests · Versions       │
└───────────────────────┬──────────────────────┘
                        │ Authenticated HTTP + events
                        ▼
┌──────────────────────────────────────────────┐
│ 02 — JOB RUNNER SERVICE                      │
│ Graphile Worker (TypeScript / Node.js)       │
│ Runner PostgreSQL DB                        │
│ Execution IDs · Queue · Retries · Deadlines │
└───────────────────────┬──────────────────────┘
                        │ Authenticated provider API
                        ▼
┌──────────────────────────────────────────────┐
│ 03 — SANDBOX PROVIDER SERVICE                │
│ FastAPI (Python) + BoxLite Python SDK        │
│ Sandbox Registry PostgreSQL DB              │
│ Sandbox IDs · Create · Start · Stop · Inspect│
│                                              │
│ ┌──────────────────────────────────────────┐ │
│ │ BoxLite — persistent VM per request     │ │
│ │ Pi (Node.js) + OfficeCLI + SKILL.md     │ │
│ │ Saved Pi session + document workspace   │ │
│ └───────────────────┬──────────────────────┘ │
└─────────────────────┼────────────────────────┘
                      │ Controlled model access
                      ▼
             Existing LiteLLM Proxy
```

**Three stable identifiers:** `request_id` is the Application's document-history identity, `execution_id` belongs to the Runner for each attempt or revision, and `sandbox_id` belongs to the Provider and identifies the persistent VM.

**Ownership rules**
- Application DB: User/project identity, requests, comments/feedback, document versions and links to files.
- Runner DB: Queue records, execution attempts, retries, scheduled deadlines, job events and links to request/sandbox IDs.
- Sandbox Provider DB: BoxLite runtime identifiers, persistent disk location, state and recovery metadata.
- Pi session files and working documents: Inside the VM, backed up/exported for resilience.
- Original uploaded and final output artifacts: Application-owned object storage.

None of these services should directly query another service's database. A logical database split does not require three separate PostgreSQL installations.

---

## 4. Complete Request Lifecycle

1. **Create request:** User selects SRT skill, supplies notes/screenshots. Application stores originals and creates `request_id`.
2. **Queue execution:** Application calls the Runner API with a request reference, authorized file references, skill version and idempotency key.
3. **Create sandbox:** Graphile Worker dispatches to Provider. The Provider creates a BoxLite VM from the prepared agent image and stores its `sandbox_id` and disk reference.
4. **Run Pi:** Provider stages the approved files and launches Pi with LiteLLM and OfficeCLI. Pi's session is saved on the persistent VM disk.
5. **Version 1 ready:** Provider exports output. Runner records execution result and notifies Application; Application stores Version 1 and publishes the status to UI.
6. **Five minutes idle:** A scheduled Runner action asks Provider to **stop** the VM; BoxLite files and saved Pi session remain. Stop only after active execution and result export have ended.
7. **Five days later:** Requester submits text and screenshot feedback against `request_id`. Application creates a new revision request.
8. **Resume:** Runner creates another `execution_id`, Provider restarts the **same** BoxLite environment, and Pi reopens the saved session plus new feedback.
9. **Version 2 ready:** Export and retain Version 2; repeat the idle-stop policy. Old document versions remain accessible.
10. **Host restart:** Restore Provider registry plus persistent BoxLite storage; reconstruct the mapping and resume only through an explicitly tested recovery path.

### Clarification and delivery timeouts

The earlier product decision remains applicable: **HITL only when Pi needs material clarification**. Questions are shown in the UI. After **15 minutes** without a response, the runner can resume with a conservative authorized default or a visible unresolved gap, **not a fabricated technical result**. An eligible delivered version can be timeout-finalized after its separate 15-minute requester window, without claiming human approval. Implement these deadlines as persistent jobs/state transitions rather than leaving a VM processing in a wait loop.

### Job reliability

Graphile Worker provides **at-least-once execution**, not exactly-once guaranteed physical effects. Use deduplication keys and transactional execution records so a retried job does not accidentally start two Pi processes against the same persistent VM. The Runner must enforce one active execution per `sandbox_id`, cancellation rules, and bounded retries for external-service failures.

---

## 5. Why Graphile Worker Rather Than Procrastinate?

| Requirement | Graphile Worker | Procrastinate |
|---|---|---|
| Language executing tasks | **TypeScript / Node.js** | Python |
| PostgreSQL-backed | Yes | Yes |
| Queue, retries and delayed jobs | Yes | Yes |
| Separate Redis requirement | No | No |
| Calls Python Sandbox Provider | Through HTTP API | Native Python HTTP client |
| Best fit for this chosen stack | **Selected for standalone Runner** | Not selected |

**Graphile Worker does not have an official Python worker runtime.** It executes JavaScript/TypeScript tasks. A Python program can enqueue through PostgreSQL SQL functions, but cannot directly register a native Python Graphile task. Source: [Graphile Worker documentation](https://worker.graphile.org/docs).

**Why Procrastinate was proposed earlier:** When the Runner was tentatively Python, [Procrastinate](https://github.com/procrastinate-org/procrastinate) was a reasonable PostgreSQL-native Python queue. It is not required now that the Runner is TypeScript. Its project also publicly notes that it is looking for more maintainers.

**Selected decision:** Use Graphile Worker in the TypeScript Runner and use Python **only for the BoxLite Sandbox Provider**, where its SDK is directly useful.

---

## 6. What We Deliberately Avoid

- **No general-purpose YAML automation interpreter or visual template builder.** Use the tested skill catalog and Git-managed documents.
- **No Hatchet or second orchestration engine.** The Runner owns modest state transitions around Graphile jobs.
- **No E2B control plane.** The Provider embeds BoxLite through Python.
- **No separate desktop automation.** Pi and OfficeCLI operate headlessly.
- **No assumption of full process-memory resume.** Store Pi's conversation sessions explicitly; BoxLite stop/restart guarantees must be validated separately from Pi session restoration.
- **No one-way ephemeral sandbox per job** when the product requires days-later continuity. One request retains the Box and creates new execution records for revisions.
- **No provider-specific API in the Application or Runner.** Runtime replacement is designed into the Provider; **migration of existing persistent VM disks is not automatic**.
- **No unconditional agent trust.** Keep tool restrictions, model egress controls and document validation despite VM isolation.

---

## 7. Known Foundations and Validation Gates

**Reusable originals:** `docx-template-testscript`, `docx-template-usecase`, `srt-video-and-screenshots-update`, OfficeCLI skill, templates and local document verification rules. The original operator's successful Copilot CLI results are a baseline, not proof of equivalent Pi reliability.

**Before organizational use, verify:**
- Pi can run the actual existing SRT skill with LiteLLM and OfficeCLI, with output quality comparable to the baseline.
- BoxLite SDK can create, stop and restart a box **without deleting the writable disk**, including after Sandbox Provider and host restarts.
- A saved Pi session can reopen correctly and use previous document files after several days.
- Persistent VM disks, registry and critical Pi session checkpoints are backed up and recoverable.
- Graphile delayed tasks reliably stop idle boxes; clarification and delivery deadlines can survive worker restarts.
- Graphile retries do not run duplicate active Pi sessions in the same sandbox.
- Service-to-service authentication, project permissions, allowlisted networking, file scanning and HPE data policies are enforced.
- Changes to skill bundles are versioned and tested before being made available to other users.

**Not yet fixed:** Exact authentication library, object-store product, API schemas, logging and tracing, retention/deletion approval, concurrency count, CPU/RAM allocation, Pi model alias, BoxLite host specification and whether all document families are in the first release.

---

## 8. Current Decisions and Next Test

| Component | Proposed/selected |
|---|---|
| Frontend | React + TypeScript |
| Application API | Fastify / Node.js |
| Application DB | Own PostgreSQL logical database |
| Document files | Self-hosted S3-compatible storage |
| Job Runner | **Graphile Worker + TypeScript**, independently deployed |
| Runner DB | Own PostgreSQL logical database |
| Sandbox Provider | **FastAPI + Python BoxLite SDK**, independently deployed |
| Sandbox DB | Own PostgreSQL logical database |
| VM | **One persistent BoxLite microVM per document request** |
| Agent | Pi with saved session and versioned skills |
| Document engine | OfficeCLI |
| Inference | Existing LiteLLM proxy |
| Request revisions | Restart same BoxLite VM and reopen the saved Pi session |
| Idle stop | After five minutes without active execution; retain disk |
| Clarification / requester windows | 15 minutes each, with previously agreed conservative/finalization policy |

**Next concrete technical test:** Build one BoxLite image with Pi + OfficeCLI + the SRT skill. Use the three-service boundary to create a request, generate Version 1, stop the box after five idle minutes, simulate service and host restarts, reopen the same Pi session, apply feedback, and generate Version 2. Verify both file integrity and database ownership.

**One-sentence definition:** A lightweight HPE document application using **React/Fastify**, an independent **Graphile Worker TypeScript Runner**, and an independent **Python BoxLite Sandbox Provider**, with Pi + LiteLLM + OfficeCLI and request-persistent agent sessions.