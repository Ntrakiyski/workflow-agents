# Workflow Agents: repository instructions

## Purpose and current state

Workflow Agents provides two independent infrastructure services for future applications. Phase 1 implements a durable Job Runner and a persistent Sandbox Provider. Phase 2, the Document Assistant, is not implemented or authorized by this guide.

The current candidate is `1.0.0-rc.1` with authenticated `/v1` REST APIs. **Phase 1 acceptance is incomplete and `ready_for_phase2` is false.** Read [the current validation report](docs/phase1/CLOUD-VALIDATION.md), [machine-readable gates](docs/phase1/readiness.json), and [independent QA](docs/qa/CLOUD-REVIEW.md) before making readiness claims.

The recorded staging deployment runs source commit `04b7dc46dc8e1bc6c126f8304823c4739d5ec5c9`. Later documentation commits do not change that deployment. Inspect live state before an operational change. Do not equate branch HEAD, a healthy container, or passing mocked tests with the deployed release.

## Read before working

1. Read [Phase 1 requirements](PHASE-1-REUSABLE-SERVICES.md), the primary implementation requirements.
2. Read [architecture context](PROJECT-DOCUMENTATION-ASSISTANT-LIGHTWEIGHT.md) and [Phase 2 requirements](PHASE-2-DOCUMENT-ASSISTANT.md) for boundaries only.
3. Read the current reports above. Original requirements and historical reports are preserved; their initial status text is not the current delivery record.
4. Read the target directory's `AGENTS.md` and its development or operations skill before changing that service.
5. For API work, read [compatibility rules](docs/contracts/v1.md) and [release metadata](contracts/release.json).

User instructions define the authorized task. This file applies throughout the repository; nested agent files add service-specific rules. A service ownership rule does not prevent the lead from making an authorized integration or documentation change.

## Technology and architecture

| Component | Implementation | Owns |
| --- | --- | --- |
| `services/job-runner/` | Node.js 22+, TypeScript, Fastify 5, Graphile Worker 0.18, `pg`, Ajv | Jobs, schedules, attempts, queue, idempotency, job audits; its own PostgreSQL database |
| `services/sandbox-provider/` | Python 3.12, FastAPI, Uvicorn, Psycopg 3, JSON Schema, BoxLite SDK 0.11.0 | Sandbox registry, runtime identity, execution records, lifecycle and sandbox audits; its own PostgreSQL database |
| `contracts/` | Versioned OpenAPI 3.1 and JSON Schema, Python generators and tests | Reviewed wire contracts, shared profile format, compatibility policy |
| `deploy/` | Per-service Dockerfiles plus Coolify JSON configuration and operator scripts | Explicit Git commit deployment, private networking, resource settings and recovery procedures |
| `apps/application/` | Instructions only | Future Phase 2 scope; no running application or UI |

Dependency locks and service manifests contain exact package versions. PostgreSQL 16 is the tested database baseline. Each service has its own dependencies, migrations, tests, Docker build context, configuration and release metadata. There is no root application package or monolithic build.

The request path is client -> Job Runner HTTP API -> Graphile queue -> Sandbox Provider HTTP API -> runtime adapter -> approved workload. Runner never imports BoxLite or reads the Provider database. Provider never imports Graphile or reads the Runner database. Clients poll durable status and event APIs.

## Deployment and runtime boundaries

- The active project is `workflow-agents-phase1`, environment `staging`, on GCC Coolify. [Deployment instructions](deploy/README.md), [configuration](deploy/coolify.phase1.json) and [resource IDs](deploy/staging-resources.json) are authoritative operational references.
- The four resources are `job-runner`, `sandbox-provider`, `job-runner-db` and `sandbox-provider-db`. Applications deploy independently; databases have distinct credentials and persistent storage. Both APIs and both databases are private. There is no dashboard or public API documentation UI.
- **The Provider API and registry are self-hosted on GCC; active guest execution and writable guest disks are hosted by BoxLite Cloud.** `SANDBOX_RUNTIME_MODE=cloud` selects `BoxLiteCloudRuntime` behind `SandboxRuntime`. Local mode remains explicit and is the code default. Neither mode silently falls back to another runtime or a mock.
- Cloud mode uses runtime-only `BOXLITE_API_KEY`, an HTTPS `BOXLITE_REST_URL` and a stable `BOXLITE_ACCOUNT_SCOPE`. It needs no local `/dev/kvm`. Preserve backend/account bindings; changing configuration must not reinterpret existing sandbox identities.
- Local GCC execution remains blocked by the container's bubblewrap namespace boundary despite host KVM availability. Worfklow lacked host KVM; our Worfklow resources were removed after migration. Do not redeploy there during routine maintenance.
- Preserve the Provider named volume at `/var/lib/sandbox-provider`. It retains local SDK data/history, not Cloud guest disks. A volume or registry dump is not a complete sandbox backup.
- Keep one Provider process for this candidate and avoid overlapping redeployments. Never grant privileged mode, host `SYS_ADMIN`, the Docker socket, broad host mounts, or host security changes as a routine fix. Do not reboot a shared host.
- Inspect exact project membership before mutations. Do not create a duplicate project or modify unrelated Coolify resources. Documentation cleanup does not authorize deployment or repinning.

## API, security and durability rules

- Preserve the frozen generic contracts under `contracts/v1/`. Reviewed contract changes must update generators, service-local copies and compatibility tests together. Never hand-edit one generated copy in isolation.
- `/v1` uses scoped opaque bearer credentials. Identity comes from credentials. Only the Provider's explicitly configured Runner delegate can set `X-Owner-ID` for allowed owners.
- Require owner-scoped idempotency on create, submit and execute. Changed payloads conflict. Reconcile ambiguous external effects using the same execution reference and key. Never blindly replay a workload as a fresh attempt.
- Permit only approved workload profiles, validated arguments, immutable OCI image digests and bounded resource/network policy. Clients cannot supply arbitrary shell commands, images, mounts or executables.
- Enforce one active execution per sandbox. Stop preserves the disk. Destroy is a separate explicit authorized operation. Missing retained environments must fail visibly rather than become new empty boxes.
- Emit structured JSON logs with correlation, target and execution IDs, action, duration, outcome and safe error class. Persist actor, timestamp, target and outcome in append-only audits. Never log tokens, database URLs, workload payloads or document contents.
- Keep secrets in ignored `private/` files or the deployment secret manager. Do not copy attachment credentials into code, documentation, examples, command arguments or Git.
- Never add Pi, OfficeCLI, SRT, approval, requester-timeout or Document Assistant logic to infrastructure. No React UI, new LiteLLM service, Hatchet or general YAML workflow engine belongs in Phase 1.

## Development and verification

Use the service-local README and skills for full setup. Environment example files document keys; neither service automatically loads dotenv files. Use independently provisioned disposable test databases with separate credentials.

**Runner integration tests drop `runner` and `graphile_worker` schemas. Provider tests truncate registry tables. Never use retained staging, production or operational restore databases as `TEST_DATABASE_URL`.**

From `services/job-runner/`:

```sh
npm ci
npm run typecheck
npm run format:check
npm run test:unit
TEST_DATABASE_URL="$DISPOSABLE_RUNNER_TEST_DATABASE_URL" npm run test:integration
npm run build
```

From `services/sandbox-provider/`, using Python 3.12:

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.lock
TEST_DATABASE_URL="$DISPOSABLE_PROVIDER_TEST_DATABASE_URL" .venv/bin/python -m pytest -q -m 'not real_runtime'
```

In a dedicated Python environment with `contracts/requirements-test.lock` installed, run from the repository root:

```sh
python contracts/tests/test_contracts.py
python contracts/build_contracts.py
git diff --exit-code -- contracts/v1
```

[CI](.github/workflows/phase1.yml) runs contract generation, Runner typecheck/build/tests and Provider tests with real PostgreSQL. Runtime behavior in CI is mocked, including the real SDK pointed at a loopback HTTP stub. The `real_runtime` test and local `scripts.qualify_runtime` require local KVM; they do not qualify Cloud. Hosted proof uses the separately recorded HTTP fixture journey. Add meaningful regression tests for implementation changes and run only the checks relevant to documentation-only changes.

## Acceptance and recovery limits

The recorded real Cloud journey passed workload execution, same-box marker retention across stop/start, bounded two-box file separation, duplicate admission, durable audits and stopped-box recovery across independent application replacements. This is not active-command recovery or comprehensive security qualification.

Keep these gates open until new evidence closes them:

- Generic scoped artifact transfer. Nonempty `artifact_output_ref` currently returns 422.
- Active-command and complete-output recovery. Cloud attach fails closed with nonretryable `ambiguous_execution`; preserve the same box and do not replay uncertain work.
- Hosted transient retry, Provider timeout and active-worker crash failure injection.
- Off-host database backups and coordinated registry plus Cloud guest data restore. Observed vendor capabilities disable snapshot, export, import and cloning.
- Host restart persistence and broader resource, network and escape qualification.

Do not use a Cloud snapshot or VM clone as a proven capability. The user's separate Pi prototype uploads a cached runtime archive; it is reference material, not repository implementation or independent Phase 1 evidence. See [the dated closeout](docs/phase1/CLOSEOUT-2026-11-03.md).

## Git and handoff

- Work on a feature branch. If agents work concurrently, use separate worktrees and disjoint ownership. Do not overwrite another agent's uncommitted changes.
- The lead owns integration, root documentation and contract review. Freeze contracts before independent implementations change assumptions. Independent QA must inspect source and distinguish executed, mocked, skipped and blocked checks.
- Preserve requirements and historical evidence. Put current status in `docs/phase1/readiness.json` and the current validation report rather than rewriting old results.
- Keep generated scratch exports under ignored `output/`. Curated validation diagrams live in `docs/phase1/visuals/`.
- Before pushing, inspect the diff, check for secrets, run relevant validation and state the actual results. Do not mark the draft candidate stable or merge a release solely to tidy branches.
- Delete branches or worktrees only after checking cleanliness and verifying that their commits or equivalent patches are integrated. Preserve unique work.
- A handoff names the source commit, deployed commit, APIs, executed tests and remaining gates separately. Do not claim a deployment change from a documentation push.
