# Project Documentation Assistant — Lightweight Approach
**Product Definition & Implementation Direction — Pi + LiteLLM Alternative to Version 3**

**Status:** Proposed simpler approach; not an implemented application  
**Date:** November 2, 2026  
**Audience:** HPE internal pilot  
**Reference:** [Full Version 3 architecture](./PROJECT-DOCUMENTATION-ASSISTANT.md)

---

## 1. Project Vision

Provide HPE employees with a simple browser interface for the **existing, working document skills** rather than rebuilding those skills as a generic AI automation platform.

The proven local workflow, as reported by its original operator, is:

- A computer folder containing document templates, instructions, and `SKILL.md` files.
- **GitHub Copilot CLI** operating in that folder, with **OfficeCLI** and the supporting document skills/tools.
- An operator supplying inputs and guiding the agent to create or update SRT and other project documents.
- Reliable results in the operator's tests. This is a user-reported observation, **not yet a measured acceptance rate across different people and projects**.

The new requirement is primarily **accessibility**: other employees should be able to perform the same task without learning a CLI or navigating skill directories. **The lightweight implementation uses Pi + LiteLLM + OfficeCLI**; the existing Copilot CLI workflow remains the comparison baseline, not the runtime we are deploying.

**Core principles**

- **Reuse first:** Preserve working skills, prompts, templates, and document operations.
- **Add an interface, not a platform:** Expose a short list of approved skills through a small UI.
- **Simple model integration:** Use Pi as the agent runtime, connected to the existing LiteLLM proxy. Benchmark Pi on the same SRT fixtures previously used with Copilot CLI instead of assuming equivalent results.
- **Don't over-generalize:** No arbitrary workflow builder or universal document-template interpretation in the first delivery.
- **Preserve originals and document quality:** Operate on job copies and retain evidence/validation appropriate to the skill.
- **Expand only after employee testing:** Let demonstrated needs justify more infrastructure.

**Goal:** A second employee can select an existing SRT/Use Case skill, provide materials, and obtain an acceptable document through a browser.

---

## 2. Four Project Pillars

### Pillar 01 — User Experience

**Purpose:** A small web interface for using the document skills we already have.

**Core Capabilities**
- Show a short catalog of **approved automations** (for example SRT creation and Use Case drafting).
- Select an automation and see a short explanation of its inputs and limitations.
- Enter free-form instructions and attach notes, screenshots, and other supported files.
- Click **Generate** and see a straightforward queued/running/completed/error status.
- Download and, when practical, preview generated files.
- Submit general text feedback and optional annotated screenshots; trigger a new document version.
- Return to previously generated outputs if the pilot needs persistent history.

**Goal:** Remove the need for users to operate Pi or any CLI, or understand skills, templates, or command-line instructions.

**Technology Stack**
- **Frontend:** Small React UI (Extend UI components optional, not a requirement).
- **Backend interaction:** A few REST endpoints; simple status polling initially, SSE only if useful.
- **Preview:** Basic download first; rendered preview only after checking fidelity on real templates.

### Pillar 02 — Skill Library & Configuration

**Purpose:** Reuse existing document automations as approved, curated items rather than building a new automation designer.

**Core Capabilities**
- Package or reference the existing `SKILL.md` files, template assets, supporting scripts, and documented rules.
- Maintain a curated list: automation ID, display name, description, required files, instructions, and skill directory.
- Pin the version/commit of the skill bundle used for a job.
- Permit the maintainer to update skills through Git and retest them; no visual YAML editor.
- Keep distinct operations distinct: new SRT generation, guarded SRT evidence update, and Use Case drafting.
- Reject unsupported templates, formats, and uncontrolled edits rather than improvising.

**Goal:** Share the existing working workflows without recreating their knowledge in a second framework.

**Technology Stack**
- **Primary assets:** Current document skills, templates, scripts, and OfficeCLI.
- **Catalog:** Small checked-in config (JSON or YAML; exact representation unimportant at this stage).
- **Versioning:** Git commits/tags for approved skill releases.
- **Out of scope initially:** User-created arbitrary automations, graphical template editor, generic workflow DSL.

### Pillar 03 — Agent & Document Execution

**Purpose:** Reproduce the existing document-skill behavior behind the UI using Pi + LiteLLM + OfficeCLI.

**Core Capabilities**
- Run **Pi non-interactively** with the approved skill/task prompt, staged job files, and the configured LiteLLM model alias; verify the chosen Pi integration before implementation.
- Install/configure Pi, OfficeCLI, and global skills in a versioned runner image; load approved automation-specific skills and files for each job.
- Create a **new per-job working directory**; copy approved templates and source inputs; never edit originals.
- Expose controlled OfficeCLI tools and a tightly restricted shell where needed; apply filesystem, network, process, and model-budget limits outside the agent's prompts.
- Capture exit status, agent output, produced files, and relevant validation results.
- Use the existing skill's document-specific checks, plus basic file-open/render checks.
- Show errors or missing information explicitly rather than inventing technical results.
- Apply revision feedback to a copy of the prior output in a new job workspace.

**Goal:** Reproduce the quality of the established document skills using Pi + LiteLLM + OfficeCLI, without introducing a general-purpose orchestration platform.

**Technology Stack**
- **Agent runtime:** **Pi** — selected for the lightweight implementation; verify headless operation, skill loading, and permitted tool execution.
- **Document engine:** OfficeCLI + current skill-defined scripts and validation.
- **Runner:** Simple backend-managed background worker; no Hatchet or custom YAML interpreter initially.
- **Isolation:** Separate per-job workspaces **inside isolated execution containers or an equivalent approved sandbox** before exposing the service to multiple HPE users. Per-job directories alone are **not a security boundary**. E2B microVMs can be adopted later if required.
- **Model selection:** Existing **LiteLLM** proxy with backend-selected model alias (for example, `document-agent`); configure Pi as an OpenAI-compatible client using a verified model/provider configuration.
- **Credentials:** Inject limited job-scoped access to LiteLLM; keep upstream provider secrets and persistent tokens out of skills and runner images. Exact key/gateway strategy is pending.
- **Optional later infrastructure:** E2B Embed for stronger fresh microVM isolation if required by policy or concurrency; not required just to validate the UI concept.

### Pillar 04 — Lightweight Platform & Operations

**Purpose:** Handle users, files, jobs, and delivery without deploying a full automation infrastructure.

**Core Capabilities**
- Restrict access to a small authorized HPE pilot group.
- Accept requests, assign a job ID, create an isolated execution workspace, and report status.
- Queue jobs with **one active execution initially**, or a deliberately small fixed concurrency limit.
- Keep original inputs and output versions; apply a clear deletion/retention policy.
- Retain enough logs to troubleshoot unsuccessful jobs.
- Back up retained project artifacts according to the organization’s policy.
- Add stronger authentication, project authorization, audit, and container isolation **before broader organizational rollout**.

**Goal:** Provide a manageable internal service without premature multi-tenant orchestration, microVM infrastructure, or platform governance.

**Technology Stack**
- **Backend:** Fastify/Node.js (compatible with the larger architecture if we later scale).
- **Queue:** A minimal local background worker backed by a durable job record. No orchestration platform required for the first controlled pilot.
- **Persistence:** SQLite + job directories is one pilot option; PostgreSQL and self-hosted S3 remain alternatives where approved data-handling requirements call for them. **No storage choice is finalized for this lighter variant.**
- **Auth/security:** Scope to a trusted pilot, but do not treat an operator login or work directory as sufficient protection for unrelated users' documents.
- **Deployment:** One approved execution host initially; verify Pi runtime compatibility, LiteLLM connectivity, sandbox controls, and organizational data-processing policies.

---

## 3. How the Four Pillars Work Together

| Pillar | Main question | Primary output |
|---|---|---|
| 01 — User Experience | How can an employee submit a skill-driven document request? | Small upload/request/status/download UI |
| 02 — Skill Library | Which existing, tested document skill should execute? | Versioned curated skill + template bundle |
| 03 — Agent Execution | How do we reproduce the proven skill behavior? | Pi + LiteLLM + OfficeCLI output |
| 04 — Platform & Operations | How do we manage jobs and files safely for the pilot? | Limited-access job runner and retained results |

### Simple Architecture

```text
Employee browser
  |
  v
Simple React UI
  |  Select skill + instructions + attachments
  v
Fastify API
  |  Authorize, save, create job
  v
Small background job runner (start with concurrency = 1)
  |  Create fresh job workspace
  v
Pi + approved SKILL.md + OfficeCLI
  |  Model inference through existing LiteLLM
  |  Generate / update copies + run existing checks
  v
Store outputs and status
  |
  v
UI — preview or download; optional revision request
```

The execution environment might initially be a controlled test machine or server. **Do not claim this is production isolation** until agent process/container restrictions and organization policy are validated.

---

## 4. End-to-End Example — Existing SRT Skill

1. **Choose:** Employee picks **SRT — Create Test Script** from the curated library.
2. **Describe:** Employee writes a short deployment/test description and attaches notes, screenshots and any required approved sources.
3. **Register:** Backend checks permitted user, selected skill and file types, then creates a job ID.
4. **Prepare:** Runner makes `jobs/<job-id>/inputs`, `working`, and `output` (illustrative paths), stages approved skill and template copies, and isolates job data as far as the chosen runtime supports.
5. **Run:** The worker invokes Pi with approved SRT instructions, staged files, and the backend-selected LiteLLM model; only approved document tools and constrained shell operations are available.
6. **Check:** Existing skill-specific document/evidence checks run, plus basic structural/render checks if available.
7. **Deliver:** Return a DOCX download and concise status/issues report. Keep the original inputs intact.
8. **Revise:** Employee adds feedback and a screenshot if useful; a new execution works on a copy and yields another version.

**Conceptual Pi invocation (not executable configuration):**

```text
Pi agent runner
  task: "Follow the approved SRT skill using only staged inputs."
  model_provider: LiteLLM (OpenAI-compatible endpoint)
  model_alias: document-agent
  skills: approved global + SRT-specific skills
  tools: approved OfficeCLI wrappers + restricted shell
  output_directory: per-job workspace/output
```

The actual Pi CLI/SDK invocation, `models.json` configuration, tool restrictions, and LiteLLM credentials must be validated on the same permitted SRT fixtures used in the existing Copilot CLI workflow. That workflow is our **quality baseline**, not a runtime dependency.

---

## 5. What We Deliberately Do Not Build Yet

| Full Version 3 concept | Simpler alternative |
|---|---|
| Visual automation creator | Curated approved skill catalog maintained in Git |
| New declarative YAML workflow DSL | Existing `SKILL.md` and small run configuration |
| Hatchet orchestration | One small background worker and job-status persistence |
| E2B Embed microVM manager | Controlled pilot runner; introduce hardened per-job sandbox before broad multi-user production |
| Agent choice | **Pi** using the same approved skills; compare output against Copilot CLI baseline |
| Separate LiteLLM model gateway | Use existing **LiteLLM** directly via a scoped model credential or small approved gateway; do not build a new model platform |
| Separate Pi author and reviewer | Start with existing skill-defined verification; add independent review only if defects justify it |
| Fully generalized DOCX/XLSX/PPTX/PDF automation | Only approved, already-tested formats and skills |
| Visual template mappings | Explicit mappings already defined in the skill/template package |
| Complex 15-minute durable HITL workflow | Prefer a simple status and follow-up submission; add live clarification if testing shows it is necessary |
| Enterprise multi-organization management | Small HPE pilot with minimal authorization |

**This is not a rejection of Version 3.** Version 3 remains the larger future architecture if genuine usage, scale, or compliance requirements justify it.

---

## 6. Pilot Success Criteria

The simplest useful demonstration is:

> An authorized HPE employee who has never used GitHub Copilot CLI selects the existing SRT skill, uploads a real permitted sample, and produces a document comparable to the operator's known-good result, without opening a terminal.

Assess:
- Is the generated document factually and structurally comparable to the current working process?
- Does it preserve the original template and required evidence placement?
- Can the employee complete the request without technical assistance?
- Can a feedback request generate another valid version?
- Are job failures understandable and recoverable?
- Is the data-handling and execution boundary permitted for the pilot?

**Do not claim measured 100% success or production readiness** before repeatable tests across representative inputs and users.

---

## 7. Validation Gates Before Broader HPE Use

These are important even for a deliberately small product.

1. **Pi execution:** Confirm the selected Pi runtime can load the original skill bundle, connect to LiteLLM, call approved OfficeCLI tools, produce artifacts, and report errors in headless mode.
2. **Model access and identity:** Confirm HPE-approved LiteLLM providers and data-handling rules; use narrow per-job credentials or an approved internal gateway. Do not store upstream model credentials in the sandbox image.
3. **Execution security:** Determine when a fresh container or stronger sandbox is mandatory; uploaded documents and instructions are untrusted. Per-job directories alone are not a security boundary.
4. **Document quality:** Compare with known-good SRT/UC outputs and existing regression fixtures; validate targeted edits, source evidence and rendering.
5. **File and access policy:** Decide which permitted HPE files may be processed; verify encryption, retention, authorization, deletion, and backup requirements.
6. **Operational fit:** Test how failures, timeouts, process restarts, and small bursts of requests are handled.
7. **Data preservation:** Never overwrite user originals or controlled project documents as a shortcut.

Failure of these checks means the pilot design must be strengthened; it does **not** justify quietly launching an unsafe shared execution service.

---

## 8. Where This Sits Relative to the Full Architecture

**Lightweight approach = Product A: Document Skills as a Service**

- Primary business problem: **Share the existing successful document skills with employees through a simple UI.**
- First implementation: approved skill catalog, one lightweight job runner, **Pi + existing LiteLLM + OfficeCLI**; the established Copilot CLI outputs serve as parity test fixtures.
- Deliberately avoids building an automation marketplace/platform before the business needs it.

**Full Version 3 = Product B: Enterprise Document Automation Platform**

- Additional ambition: visual creation of arbitrary automations, declarative workflow DSL, durable distributed orchestration, isolated microVMs and advanced review/governance.
- The design is documented separately in [PROJECT-DOCUMENTATION-ASSISTANT.md](./PROJECT-DOCUMENTATION-ASSISTANT.md).
- It is an expansion path, **not the prerequisite for giving employees access to the existing skills**.

---

## 9. Suggested Next Step

1. Package one existing **SRT creation skill**, its templates and supporting tools as a reproducible tested bundle.
2. Validate **headless Pi execution** with OfficeCLI and a backend-selected LiteLLM model alias; compare output against known-good Copilot CLI runs.
3. Build the smallest **select → upload → run → download** browser flow.
4. Run real permitted sample inputs through both the old local workflow and the UI workflow and compare the artifacts.
5. Add feedback/version history and stronger multi-user safeguards based on what the pilot actually requires.

**One-sentence definition:** A lightweight internal web interface exposing existing document skills to HPE employees through **Pi + LiteLLM + OfficeCLI**, without prematurely rebuilding them into a general automation platform.
