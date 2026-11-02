# Project Documentation Assistant
**Project Definition & Architecture Planning — Version 3**

**Status:** Architecture decisions agreed; implementation not started  
**Last updated:** November 2, 2026  
**Organization:** HPE (one organization initially; design for more later)

---

## 1. Project Vision

Build an internal AI-powered platform that transforms rough notes, screenshots, attachments, and supporting material into professional, structured documents using reusable templates and automations.

The platform has two experiences:

- **Use an automation:** Select a prepared document workflow, provide informal input, and receive a validated, reviewable document.
- **Create an automation:** Onboard a document template, configure its mappings and rules, test it, and publish a reusable workflow.

**Core principles**
- Simple UI; users do not need to understand agents, skills, YAML, or document field paths.
- Template-aware generation grounded in provided sources; no fabricated facts, test results, or evidence.
- Explicit, versioned YAML workflows; deterministic controls around AI interpretation.
- Fresh sandbox per job execution; preserve all important history outside the sandbox.
- Independent validation and format-specific AI review before delivery.
- Human-in-the-loop only for material clarification; the requester can review and request changes.
- Self-hosted infrastructure; expand from proven workflows rather than claiming universal template support.

---

## 2. Four Project Pillars

### Pillar 01 — User Experience

**Purpose:** The frontend through which HPE employees request documents, follow progress, and request revisions.

**Core Capabilities**
- Browse and select a ready automation (for example, an SRT generation workflow).
- **Hybrid request screen:** automation choice + natural-language instructions + file/screenshot uploads.
- Show workflow steps, live status, progress, and errors.
- Display the agent's clarification questions within the original job screen.
- Preview generated documents in the app and download deliverables.
- Let the **requester** accept a version or submit **general text feedback plus screenshots/images** of requested changes.
- Keep previous jobs and versions accessible so the requester can return tomorrow and request more changes.
- No full in-browser Office editor and no mandatory inline document comments are required by the agreed experience.

**Goal:** Let an authorized employee request, understand, and revise a document without interacting directly with YAML, Pi, OfficeCLI, or E2B.

**Technology Stack**
- **Frontend:** React — selected direction.
- **Document/UI components:** Extend UI — preferred, not yet validated against requirements.
- **Job updates:** Server-Sent Events (SSE) — selected.
- **Document preview and attachment UX:** Implementation research pending.

### Pillar 02 — Automation Builder

**Purpose:** Let authorized people create, test, version, and reuse controlled document automations.

**Core Capabilities**
- Upload an existing template and describe its purpose and intended audience.
- Inspect template structure and propose section, table, field, slide, cell, and image mappings.
- Review and edit AI-proposed mappings before publishing.
- Define mandatory information, source/evidence rules, terminology, and permitted transformations.
- Define ordered steps, conditional logic, expected outputs, clarification policies, and failure behavior.
- Configure **which authoring and review skills run, at which step, and against which checklist**.
- Test with representative inputs, inspect outputs, refine, save a version, and optionally publish to an authorized library.
- Distinguish SRT authoring, SRT execution-evidence updates, and Use Case drafting as separate workflows.

**Goal:** Configure an automation once so many HPE projects can reuse it with consistent execution and validation.

**Technology Stack**
- **Automation definition:** Versioned YAML, inspired by the declarative idea of Google's AX; AX itself is not adopted.
- **Job definition:** Backend-generated per-request manifest, proposed as \`job.yaml\`.
- **Workflow execution:** Validated YAML-to-registered-task adapter backed by Hatchet.
- **Definition schema, visual builder, testing, publishing and ownership:** Still to be designed.

### Pillar 03 — AI & Document Engine

**Purpose:** Analyze source material, plan content placement, generate and validate documents, and challenge outputs before delivery.

**Core Capabilities**
- Run **one Pi author session for the complete job execution**, with backend/YAML-defined instructions.
- Use the approved LiteLLM author model to interpret notes, documents, and screenshots.
- Produce a **structured content plan**, validated before document editing begins.
- Call controlled document wrappers for inspection, creation, section updates, evidence placement, and rendering.
- Permit **restricted shell** operations inside the sandbox; never unrestricted host or filesystem access.
- Load **global skills** from the golden environment and **automation-specific skills** for the selected workflow.
- Run independent deterministic validators for file integrity, required content, structure, evidence rules, and rendering.
- Start a **separate Pi reviewer session** after authoring, using a format-specific review skill (\`review-docx\`, \`review-xlsx\`, \`review-pptx\`, or supported \`review-pdf\`) and a YAML-defined checklist.
- Challenge the author's "ready" claim by inspecting actual files and evidence. On defects, perform bounded author repair and revalidation.
- Preserve unresolved uncertainty; do not imply that a screenshot or generated prose independently proves a passed test.

**Goal:** Constrain the agent to interpretation and permitted document operations while enforcing document quality independently of its own claims.

**Technology Stack**
- **Agent:** Pi, installed in the golden sandbox environment.
- **Document engine:** OfficeCLI, installed in the same environment.
- **Model access:** Existing LiteLLM proxy through a controlled internal inference gateway.
- **Author and reviewer models:** Separate configured aliases, \`document-agent\` and \`document-review\`.
- **Skills:** Global + automation-specific + format-specific review.
- **Isolation:** Fresh E2B Embed microVM per job execution and later revision.
- **Tool wrappers, restricted-shell allowlist, output schemas, validators and review checklists:** Specifications pending.

### Pillar 04 — Platform & Governance

**Purpose:** Manage identity, projects, persistent files, jobs, sandbox lifecycles, security, and history.

**Core Capabilities**
- Local accounts for one initial organization, **HPE**, with authorized projects and team members.
- Include an organization boundary in the data model for future multi-organization support; do not expose organization creation initially.
- Accept authenticated job submissions and enforce project access to jobs, inputs, outputs, and automation versions.
- Store originals, document versions, preview artifacts, structured checkpoints, clarification responses, and execution metadata.
- Orchestrate jobs, queues, step transitions, bounded retries, timers, and progress reporting.
- Use dedicated KVM-capable hosting for E2B Embed; start a fresh microVM for each execution and remove it after result export.
- Enforce resource-based scheduling with hard CPU/RAM/concurrency limits and allowlisted network access.
- Retain **all originals and revisions** until authorized deletion, subject to HPE policy.
- Take **daily automated backups**, with backup/restore verification still to be specified.
- Support requester delivery and future revisions without pretending auto-finalization means human approval.

**Goal:** Operate a secure, auditable, reusable platform across HPE projects without tying document history to temporary agent machines.

**Technology Stack**
- **Backend:** Node.js + Fastify — agreed direction.
- **Authentication:** Local accounts; exact library TBD.
- **Database:** PostgreSQL — proposed data store.
- **File storage:** Self-hosted S3-compatible object storage — selected approach, product TBD.
- **Worker + durable workflow engine:** Hatchet — selected; Graphile Worker removed.
- **Sandbox service:** E2B Embed — selected, dedicated KVM-capable execution host.
- **Model security:** Short-lived job identity to controlled internal inference gateway; LiteLLM credentials remain outside the sandbox.
- **Monitoring, backup restore procedures, data policies, and deployment topology:** Implementation research pending.

---

## 3. How the Pillars Work Together

| Pillar | Main question | Primary output |
|---|---|---|
| 01 — User Experience | How does someone request and review a document? | Request, status, preview, feedback UI |
| 02 — Automation Builder | How is a repeatable document process defined? | Versioned YAML + template mappings |
| 03 — AI & Document Engine | How is the content produced and checked? | Generated file + independent validation/review |
| 04 — Platform & Governance | How is it operated safely and durably? | Authorized jobs, isolated execution, persistent history |

### Eight Architecture Layers

| # | Layer | Current decision |
|---|---|---|
| 01 | UI | React; Extend UI preferred; hybrid request screen and SSE |
| 02 | Backend | Fastify, local auth, one HPE organization, project access |
| 03 | Storage | PostgreSQL direction + self-hosted S3-compatible files |
| 04 | Workflow | Hatchet for queue and durable execution; YAML adapter |
| 05 | Sandbox | E2B Embed on a dedicated KVM host; one golden agent image |
| 06 | Agent & tools | Pi author + independent Pi reviewer; OfficeCLI and restricted wrappers |
| 07 | Models | LiteLLM, separate aliases, internal gateway, strict model selection |
| 08 | HITL & lifecycle | Clarification-only HITL; 15-minute waits; requester feedback and history |

### Simple Architecture Flow

\`\`\`text
HPE Requester — React + Extend UI
             |
             v
Fastify API — local auth, project access, SSE
             |
      +------+------+
      |             |
 PostgreSQL     S3-compatible storage
 state/jobs     inputs/templates/outputs
      |             |
      +------+------+
             |
             v
Hatchet — queue, YAML step orchestration, timers
             |
             v
E2B Embed — fresh microVM from golden agent template
             |
     +-------+----------------------------+
     |       Pi Author (LiteLLM)          |
     |       Controlled OfficeCLI tools   |
     |       Structured content plan      |
     |       Independent validators       |
     |       Separate Pi reviewer         |
     +-------+----------------------------+
             |
             v
Store artifacts, destroy microVM
             |
             v
Requester UI — preview, feedback, later revisions
\`\`\`

**Responsibility boundary:** Hatchet decides which workflow step runs; Pi interprets content and invokes approved tools; OfficeCLI changes documents; independent validators determine mechanical quality; Fastify authorizes requester actions. Skills are guidance, **not** security controls.

---

## 4. End-to-End Job Flow — SRT Example

1. **Request:** The requester selects \`srt-docx-template\`, types rough deployment notes, and attaches screenshots and supporting documents.
2. **Register:** Fastify authorizes the HPE project, stores originals, fixes the automation version, and creates a persistent job.
3. **Orchestrate:** Hatchet dispatches registered handlers based on validated YAML (not arbitrary YAML commands).
4. **Provision:** E2B Embed creates a **fresh microVM** from one prebuilt Pi + OfficeCLI golden template. No reinstall for each job.
5. **Prepare:** Approved files, template, job manifest, automation rules, global/job skills, and execution limits are supplied.
6. **Analyze:** One Pi author session uses \`document-agent\` through LiteLLM to prepare a structured content plan.
7. **Clarify if needed:** Pi calls \`request_clarification()\` for blocking/material ambiguity. Hatchet persists the question/checkpoint and releases the microVM while waiting.
8. **Generate:** The validated plan is applied to a copy of the document using controlled OfficeCLI wrappers and permitted restricted shell operations.
9. **Verify:** Deterministic validators run, then an independent Pi reviewer applies the required document-format skill and YAML checklist.
10. **Repair if needed:** Hatchet routes defects for a bounded author repair and another validation pass; critical defects must not be silently approved.
11. **Deliver:** Export document, previews, issues, and status to persistent storage; destroy the microVM; show an **eligible** version to the requester.
12. **Finalize or revise:** The requester can accept or submit general text and image/screenshot feedback. A new revision receives a **fresh** microVM.
13. **Return later:** The same job history remains available for more revisions tomorrow or later.

### Timeouts and Requester Behavior

- **Clarification:** Maximum three rounds, with related questions batched. A question waits **15 minutes**.
- **If requester answers:** Resume from saved state in a fresh microVM.
- **If requester does not answer:** Resume automatically using a **conservative, permissible** choice (for example, visible unresolved gap instead of an unsupported claim). Tell the requester what was assumed, omitted, or left unresolved. Do not invent facts, approvals, evidence, or test results.
- **Ready document:** Show status \`awaiting_requester\` and deliver the file/preview to the UI.
- **If requester does not react within 15 minutes:** Automatically **finalize only an eligible version**, recording that this was timeout-finalized, **not human-approved**.
- **If validation is blocked:** Do not turn the failed or incomplete document into a validated deliverable because the timer expired.
- **Feedback:** General text + optional uploaded screenshots/images; no inline comment system required.
- **History:** Every revision and original remains linked and accessible under project permissions, subject to HPE retention policy.
- **HITL:** Human-in-the-loop means **agent clarification only**; independent AI review and requester delivery are separate stages. There is no formal human approval workflow.

---

## 5. Automation, Job and Output Contracts

The following are **planned design artifacts**, not implemented files or native Hatchet definitions.

| Contract | Purpose |
|---|---|
| \`automation.yaml\` | Reusable, versioned workflow: steps, templates, mappings, skills, checks, clarification and repair policy |
| \`job.yaml\` | Backend-generated job ID, inputs, fixed automation version, model aliases, budget, output requirements |
| \`content-plan.json\` | Pi's structured mapping of source-backed content and evidence into document destinations |
| \`result.json\` | Machine-validated outcome, generated files, validation status, unresolved issues and execution references |

The automation YAML must specify **which skill to use and when**, including the format-specific reviewer and checklist. Only registered actions are executable. We will implement and validate the exact schemas and Hatchet adapter later.

**Execution policy agreed**
- One Pi author session for the entire job execution, plus a **separate reviewer session**.
- Global and automation-specific skills.
- Controlled tools **plus restricted shell**.
- Structured, validated content plan before editing.
- Deterministic validation and optional AI review; a dedicated review skill/checklist is required by our selected document workflows.
- Separate author/reviewer LiteLLM aliases, no automatic model fallback.
- Per-job token, request, cost, and duration limits.
- Resource-based concurrency with hard capacity limits.

---

## 6. Decisions Recorded

| ADR | Layer | Confirmed direction |
|---|---|---|
| **ADR-004** | UI | Hybrid screen; visible workflow steps/errors; preview and feedback |
| **ADR-005** | Backend | Fastify; local accounts; one HPE organization; project membership; SSE; multi-org-ready data model |
| **ADR-006** | Storage | Self-hosted S3-compatible; all originals/revisions; authorized deletion subject to HPE policy; daily backups |
| **ADR-007** | Workflow | Hatchet handles queue and durable workflows; custom YAML-to-task adapter; Graphile removed |
| **ADR-008** | Sandbox | Dedicated KVM host, E2B Embed, one universal image, hard resource limits, allowlisted networking, benchmark snapshots |
| **ADR-009** | Agent | One Pi author session per execution; wrappers + restricted shell; global and automation skills; validated plan; separate Pi reviewer with format skill and checklist |
| **ADR-010** | Models | LiteLLM; separate author/reviewer aliases; backend-controlled selection; internal inference gateway and job identity; strict bounded retries; usage limits |
| **ADR-011** | Lifecycle | HITL only for material clarification; max 3 rounds; 15-minute conservative continuation; no formal approval; requester text/image feedback; eligible version auto-finalizes after 15 minutes; durable revisions |

**Architecture decisions are closed at the high level.** This does not mean the components have been installed, integrated, benchmarked or tested for production.

---

## 7. Existing Foundations

Reported existing HPE Oden assets to evaluate and reuse:

- \`docx-template-testscript\` — SRT creation and controlled-update guidance.
- \`docx-template-usecase\` — Use Case drafting structure.
- \`srt-video-and-screenshots-update\` — evidence handling and guarded SRT updates.
- \`officecli\` and generic document skills.
- Existing backup, source-evidence and verification conventions.

The original handoff reported 12 passing regression tests on local synthetic fixtures; these **do not** establish that the new web app, sandbox service, document automation builder or multi-project workflow system exists. Existing controlled Oden documents also retain their original edit/access restrictions.

---

## 8. Remaining Technical Design — Not Yet Closed

- **Automation schema:** Exact YAML format, mapping rules, step types, registered handlers, skill and review checklist references.
- **Hatchet implementation:** Job state/checkpoint semantics, event correlation, retries, cancellation, timeout races, idempotency and adapter behavior.
- **Pi tool contract:** Exact wrappers, restricted-shell allowlist, source permissions, structured results and session separation.
- **E2B deployment:** Host KVM verification, image build, isolation validation, snapshot startup benchmarks and capacity sizing.
- **LiteLLM:** Exact upstream models, gateway authentication, model capability verification, usage enforcement, and data/privacy controls.
- **Document reliability:** Real DOCX/XLSX/PPTX/PDF fixture tests, rendered validation, evidence provenance, comment/revision preservation.
- **Storage:** Exact S3 implementation, encryption, object naming, daily-backup restore testing, deletion behavior.
- **Frontend/API:** Final Extend UI component choices, document viewer, upload pipeline, request/response contracts and SSE events.
- **Governance:** Automation ownership/publishing, HPE-approved processing boundaries, real pilot inputs, acceptance measures.
- **Release scope:** First demonstration automation and output formats; DOCX-first was proposed earlier but **not yet formally decided**.

No delivery date, budget, performance number, approved hosting hardware, or completed product implementation is assumed.

---

## 9. Current Project Status

| Area | Status |
|---|---|
| Product vision | Defined |
| Four pillars | Defined |
| Eight high-level architecture layers | Agreed |
| ADR-004 through ADR-011 | Recorded |
| Core technology selections | Agreed, not integrated |
| YAML and tool specifications | Pending |
| E2B golden image and Pi integration | Not implemented |
| Backend, UI and automation builder | Not implemented |
| MVP and pilot acceptance | Not finalized |

**Next planning focus:** Define the first SRT automation YAML and its supporting tool, Hatchet, validation and review contracts using a real permitted template and input set.