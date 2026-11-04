# Minimal Workflow Requests application

This candidate implements three tasks: submit instructions with permitted files, find every authorized request through a persistent paginated list, and retrieve final text or downloadable files. It uses React/TypeScript, Fastify, its own PostgreSQL database and application-owned S3 storage. Phase 1 acceptance is still incomplete; passing mocked execution tests does not change that gate.

The continuation defers the broader Phase 2 catalog, dashboards/analytics, workflow editor, infrastructure controls, chat, feedback/revisions, approvals, clarification dialogs, skill management, project/account administration and document editors. There are no hidden implementations of these features.

## Runtime configuration

Use `.env.example` as the key inventory; the service does not automatically load dotenv. Inject secrets through the runtime deployment secret manager. Production Docker context is this directory alone. Startup applies the service-owned versioned schema, checks S3, then starts API and reconciliation worker. Exact npm dependencies are locked.

`APPLICATION_USERS_JSON` is a server-owned array of `{username,owner_id,password_sha256}`. Generate unique strong passwords externally and provide their SHA256 hex digests; raw passwords never enter browser source, images or Git. HTTP Basic is handled by the browser without an account-management screen. Use HTTPS publicly. The same stable owner can be shared only when intentional; owners isolate every request, input and download. Mutating API calls require an `Origin` matching `APPLICATION_ORIGIN` to reject cross-origin ambient credentials. Programmatic clients supply the same Origin explicitly.

Only the backend receives Runner/Provider tokens. Configure both for the same infrastructure service owner, permitted immutable profiles and Provider `sandbox:create`, `sandbox:read`, `sandbox:start`, `sandbox:stop`, `sandbox:file:write`, `sandbox:file:read` permissions. Runner needs submission/read permissions and access to selected sandbox/workload profiles. End-user authorization is application owned; no browser can choose a service owner or access service tokens. Do not use delegate headers from the browser.

Preload the reviewed `workloads/pi-document-agent` runtime bundle into private S3 at `RUNTIME_BUNDLE_OBJECT_KEY`, then configure its exact SHA256. It is an uploaded archive, never a cloned VM. The selected workload bootstrap expects `/opt/workflow-transfer/runtime/runtime-bundle.tar.gz` and the same bundle hash. LiteLLM endpoint/key/model configuration belongs to the reviewed workload environment policy, not browser code or request JSON.

S3 must support conditional `PutObject` with `If-None-Match: *`. This behavior was executed against RustFS `rustfs/rustfs@sha256:1cfa82fb394a7c6a4ffc24f5333b52afee608d258503f94b37fcce5cc965c896` (`1.0.0-alpha.83`). Exact same-byte recovery succeeds; changed content at an existing object key fails. Keep S3 private and persistent. Default startup requires an existing bucket. The operator-only `INITIALIZE_STORAGE=true` mode creates only the configured missing bucket and installs the approved GitHub runtime asset after verifying the pinned checksum. Repeated startup checks the existing object bytes; conflicting bytes fail. No browser request controls bootstrap.

Input limits: up to eight files, at most one DOCX plus UTF-8 TXT/Markdown, 10 MiB each and 20 MiB combined. DOCX inputs undergo bounded ZIP/XML structural checks, including encrypted/embedded/macro rejection. Workloads can impose a lower total text-context limit; rejection is a visible failure. Output files use the same per-file cap and 20 MiB combined. Runtime archives are limited to 256 MiB and transferred in chunks of at most 1 MiB. The worker reconciles up to two requests concurrently and prepares up to two user workspaces in the background. Long uploads do not block reconciliation for ready workspaces. Resource/load qualification remains separate.

## Durable execution and delivery

`POST /api/requests` atomically commits the request, owner-scoped idempotency fingerprint, attachment assignment and append-only audit. The row is the dispatch outbox. Changed reuse returns 409. Concurrent submissions sharing a key serialize; a lost response can be reconciled with that exact key.

On authenticated page load, `/api/session?prepare=1` queues one durable workspace for the configured stable owner. There is no registration flow. Workspace provisioning creates one retained sandbox with a stable workspace UUID/reference, uploads the reviewed runtime once with durable byte progress, and submits `PREPARE_WORKLOAD_PROFILE` (v3) with empty arguments and a maximum 180-second duration. Only a completed preparation job with exit zero and the exact expected runtime SHA256 acknowledgement makes the workspace ready. Requests can be admitted while it prepares. After readiness, the worker uploads only each request’s originals and versioned request JSON into its request-ID folder, then submits an independent generic Runner reuse job in that same sandbox. It persists job/sandbox identities and deduplicated durable event IDs. Transport recovery repeats the same keys/payload; it never creates a new workload attempt to overcome an uncertain side effect. Request JSON and file/session metadata belong to the application, not infrastructure databases.

The workload reads `requests/<UUID>/request.json` below the fixed guest root. Input paths are safe basenames under that request's `inputs/`. The versioned result is `requests/<UUID>/outputs/result.json`; its request UUID must match the controller's known request. Artifact basenames resolve only inside `outputs/`; session basenames only inside `session/`. The application independently parses the manifest shape. Each saved session descriptor requires the canonical `media_type: application/x-ndjson`.

Exit zero does not establish success. Completion requires transferred manifest/identity, declared sizes/SHA256, permitted formats, bounded actual DOCX ZIP/XML parsing, nonempty text or files, no failed workload validation and at least one saved Pi session. Originals, request/result JSON, output files and required session checkpoints are exported to immutable S3 objects before the result becomes visible. A shared sandbox stops after all requests are terminal and the configured `IDLE_STOP_SECONDS` has elapsed. A durable stop intent prevents new jobs from dispatching during stop while allowing new submissions; the next request or login starts the same saved disk without another runtime upload or installation. A delivered result never stops a running sibling. Failed stop remains a retry and cannot revoke delivery. Legacy requests from schema version 1 retain their original per-request sandbox/stop behavior and stable identities.

Structural validation does not establish factual content, translation accuracy, pagination or actual rendered layout. The UI states that content accuracy and rendered layout were not independently reviewed. Failed/corrupt/missing output never becomes empty success. There is no automatic replay or overwrite of previously delivered files.

## System prompt and request folders

The button beside Instructions opens a default system prompt textarea. Edits save per owner when the field loses focus; submission also saves it and snapshots the exact text with that request. Later edits cannot change submitted requests. The request detail exposes its saved prompt. The system prompt and request instructions form Pi’s system instructions; attachment text remains untrusted reference data. The guest binds the actual UUID directory and retains the constrained OfficeCLI tool target. Prompt wording does not enforce a filesystem boundary by itself.

Each v3 request uses `/opt/workflow-transfer/requests/<request UUID>/` for inputs, working copies, outputs, session and agent state. Pi sessions have independent histories. The runtime installation is shared and prepared before concurrent sessions start. This release keeps the existing DOCX/text capabilities; it does not expose arbitrary shell tools or permit unrestricted file creation.

Configure a new immutable sandbox/workload profile pair with `max_concurrent_runs: 2` in the matching Provider and Runner sandbox profile copies plus matching global/owner capacity. Existing profiles default to one. The application cannot enable shared concurrency by itself; deploying it against a single-run profile only queues requests or fails profile admission. Keep the configured runtime SHA fixed for a retained workspace; mismatches require deliberate operator reconciliation, not silent replacement of the user’s disk.

## HTTP surface

| Route | Behavior |
| --- | --- |
| `GET /` | Authenticated minimal React application |
| `POST /api/attachments` | One bounded multipart file; immutable owner-owned original |
| `POST /api/requests` | Instructions, optional system prompt snapshot and attachment UUIDs, mandatory `Idempotency-Key` |
| `GET /api/session?prepare=1` | Owner prompt, workspace preparation progress; queue background preparation/wake |
| `PUT /api/settings` | Save the authenticated owner’s default system prompt |
| `GET /api/requests?limit=25&cursor=...` | Authorized newest-first keyset pagination with explicit next cursor |
| `GET /api/requests/:id` | Authorized status/text/validation and visible file metadata |
| `GET /api/files/:id/download` | Reauthorizes owner/delivery state, verifies bytes/checksum, attachment download |
| `GET /health/live` | Process liveness only |
| `GET /health/ready` | Application DB and S3 connectivity only |

Foreign/missing requests/files return 404. Unsafe inputs/malformed API fields return 422. Status displayed is pending, running, completed or failed; Provider IDs, native errors and runtime secrets are absent from the UI. Application audit preserves owner, authenticated actor, action, correlation, timestamp and safe outcomes; Runner event IDs are persisted separately.

## Development and verification

```sh
npm ci
node scripts/test-services.mjs up
npm run typecheck
npm run format:check
npm test
npm run build
npm run test:browser
```

Setup creates only two dedicated labeled local test containers, PostgreSQL 16 and the RustFS digest above, bound to loopback ports 25433/29002. Credentials are generated into ignored mode-600 `private/test/` files. It refuses to replace existing containers. Tests require local database name `workflow_app_test` and **drop the `application` schema**. Never provide retained staging or operational restore credentials. `APPLICATION_TEST_CONFIG` can select an equivalent private test configuration for backend tests; the HTTP adapter test/browser harness use the generated default test setup.

`node scripts/test-services.mjs down` explicitly removes only those labeled test containers and their anonymous database volume. It preserves the ignored RustFS data directory; inspect needed evidence before deleting test files manually.

The Browser plugin was unavailable. Playwright verifies 1366×900 desktop and 390×844 mobile: instructions/attachment → confirmation → completed result → authorized download → list/reload → reopen persisted result. PostgreSQL and RustFS are real; test-only Runner/Provider fixtures are injected in `tests/`, never selectable by a production environment variable. Hosted BoxLite, Pi, LiteLLM and OfficeCLI are separate acceptance tests.

## Operations, backup and recovery

Use exact Git commit pinning and this Dockerfile; expose port 8082 only through authenticated HTTPS ingress. DB, S3, Runner and Provider remain private. Runtime secrets are never build arguments. Run a single application worker process for this candidate; PostgreSQL advisory locks also prevent concurrent workers handling the same request, but multi-worker/load qualification is not claimed.

Back up the application database, every object referenced by `application.files`, the approved runtime archive and nonsecret profile/version inventory as a recovery set. Encrypt and copy off-host. Compare `files.object_key`, `size_bytes` and `sha256` against restored objects; retain request/job/sandbox UUIDs, idempotency fingerprints, event IDs, append-only audit and `schema_migrations`. Preserve exact service/workload commit and runtime hash. A PostgreSQL dump alone cannot restore files.

Restore into isolated DB/bucket resources, apply pinned schema, verify all identities/checksums/audits, then inspect active external executions before reconciliation. Never run this test suite against a recovery database. Quiesce admissions/workers during coordinated capture/cutover; never clear an ambiguous job/sandbox ID to restart it. Cloud guest restoration and host-restart claims remain governed by root readiness evidence.

The versioned [checkpoint helper](scripts/APPLICATION-BACKUP.md) encrypts quiescent rows plus every referenced original/result/session object; local real PostgreSQL/RustFS restore, replay and negative cases passed. The [release evidence](../../docs/release/) separately records actual deployed off-host capture, hosted execution and replacement checks when executed. `VERIFICATION.md` preserves implementation test scope; root readiness remains authoritative.

An operator may use the root `deploy/recover-completed-document-export.mjs` only for its fixed, reviewed request/job/sandbox/manifest target. It verifies the known completed job and exact original/output/session hashes under the same advisory lock, records authorization, resumes export and preserves failure audits. It never submits or executes work, clears external identities or permits arbitrary recovery targets. General uncertain execution still fails without replay.
