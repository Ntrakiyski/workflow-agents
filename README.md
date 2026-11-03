# Workflow Agents

Reusable infrastructure for queuing jobs and running approved workloads in persistent isolated environments.

**Current status: Phase 1 release candidate `1.0.0-rc.1`. Full acceptance is incomplete; Phase 2 is not ready to consume a stable release.** Real BoxLite Cloud execution and stopped-box persistence passed. [Current validation](docs/phase1/CLOUD-VALIDATION.md), [readiness gates](docs/phase1/readiness.json) and [independent QA](docs/qa/CLOUD-REVIEW.md) record the evidence and remaining limits.

![Phase 1 services and validation overview](docs/phase1/visuals/preview.png)

## Services and execution flow

| Service | Stack | Responsibility |
| --- | --- | --- |
| [Job Runner](services/job-runner/README.md) | Node.js 22+, TypeScript, Fastify, Graphile Worker, PostgreSQL | Authenticated submissions, queueing, scheduling, retry policy, cancellation, execution status and audits |
| [Sandbox Provider](services/sandbox-provider/README.md) | Python 3.12, FastAPI, Psycopg, BoxLite SDK 0.11.0, PostgreSQL | Approved workload execution, persistent sandbox identity, start, stop, explicit destruction and audits |

A client submits a generic job to Runner. Runner commits the job and queue work to its own database, then calls Provider through its versioned REST API. Provider executes an approved profile through a runtime adapter and stores lifecycle and run records in its own database. Clients poll job status and durable events.

The two services deploy independently. They share neither database credentials nor source-level runtime integrations. Runner has no BoxLite SDK dependency.

## Where it runs

Both APIs and their separate PostgreSQL databases are private resources in GCC Coolify's `workflow-agents-phase1` project, environment `staging`. The Sandbox Provider API is self-hosted on GCC. **The guest VMs and their writable disks run in BoxLite Cloud.** Active Cloud mode does not require GCC KVM access.

The recorded deployed source is `04b7dc46dc8e1bc6c126f8304823c4739d5ec5c9`. Documentation pushes do not redeploy it. [Deployment configuration and recovery instructions](deploy/README.md) describe commit pinning, private networking, secret injection and storage.

There is no application dashboard. The services expose authenticated `/v1` APIs, health endpoints, owner-scoped metrics and JSON OpenAPI documents. Swagger and ReDoc are disabled. The Document Assistant UI and backend remain future Phase 2 work.

## Contracts and documentation

| Start here | Content |
| --- | --- |
| [Root AGENTS.md](AGENTS.md) | Architecture, stack, working rules, commands, deployment boundaries and known limits |
| [Closeout: 3 November 2026](docs/phase1/CLOSEOUT-2026-11-03.md) | What was delivered, what was verified and what remains |
| [Phase 1 requirements](PHASE-1-REUSABLE-SERVICES.md) | Primary implementation requirements; original handoff text is preserved |
| [Architecture context](PROJECT-DOCUMENTATION-ASSISTANT-LIGHTWEIGHT.md) | Service separation and future consumer context |
| [API compatibility rules](docs/contracts/v1.md) | Authentication, lifecycle, errors, idempotency and versioning |
| [Runner OpenAPI](contracts/v1/runner-v1.openapi.json) | Frozen Runner `/v1` candidate contract |
| [Provider OpenAPI](contracts/v1/provider-v1.openapi.json) | Frozen Provider `/v1` candidate contract |
| [Validation diagrams](docs/phase1/visuals/README.md) | Architecture, request flow, filesystem retention proof and open gates |
| [Future Phase 2 requirements](PHASE-2-DOCUMENT-ASSISTANT.md) | Context only; no application implementation is included |

Historical local-runtime and migration reports remain under `docs/phase1/`. The current delivery record is `CLOUD-VALIDATION.md`; older test counts and host blockers describe their recorded environment and time.

## Develop and test

Each service is independently buildable from its own directory. Use the [Runner setup](services/job-runner/README.md) and [Provider setup](services/sandbox-provider/README.md) for exact dependency, environment, migration, test and Docker commands. There is no root application install command.

Tests require dedicated disposable PostgreSQL databases. Runner integration tests drop its schemas; Provider tests truncate registry tables. Never point `TEST_DATABASE_URL` at staging, production or retained operational data.

[GitHub Actions](.github/workflows/phase1.yml) validates contracts, Runner typechecking/build/tests and Provider tests against real PostgreSQL. CI uses mocked runtimes and SDK loopback HTTP. Real Cloud execution is supported by separate deployed evidence, not by CI alone.

Agent instructions and verified procedures are maintained with each service:

- Runner: [AGENTS.md](services/job-runner/AGENTS.md), [development skill](services/job-runner/.agents/skills/job-runner-development/SKILL.md), [operations skill](services/job-runner/.agents/skills/job-runner-operations/SKILL.md).
- Provider: [AGENTS.md](services/sandbox-provider/AGENTS.md), [development skill](services/sandbox-provider/.agents/skills/sandbox-provider-development/SKILL.md), [operations skill](services/sandbox-provider/.agents/skills/sandbox-provider-operations/SKILL.md).

## Remaining release work

Scoped artifact transfer, active-command and complete-output recovery, hosted failure injection, off-host and coordinated Cloud backup/restore, host restart persistence and broader resource/security qualification remain incomplete. See the [machine-readable gates](docs/phase1/readiness.json) for exact scope.

No Pi, OfficeCLI, document workflow, React application, new LiteLLM service or general YAML workflow engine is implemented here. Future consumers use versioned APIs and operator-approved profiles without adding application logic to infrastructure.
