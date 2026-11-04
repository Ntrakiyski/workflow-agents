# Agent instructions — Sandbox Provider

This service is **Phase 1 reusable infrastructure**, not a Pi- or document-specific app. Read `PHASE-1-REUSABLE-SERVICES.md`.

Read the root [AGENTS.md](../../AGENTS.md) first. This file adds Provider-specific instructions. The current candidate version is `1.0.0-rc.3`; [readiness](../../docs/phase1/readiness.json) remains false for Phase 2 until separately qualified.

## Stack and source map

- Python 3.12, FastAPI, Uvicorn, Psycopg 3, JSON Schema and BoxLite Python SDK **0.11.0**. Production and development dependency locks are service-owned. Do not silently downgrade to an older quickstart version.
- `provider/app.py` owns HTTP composition, `provider/service.py` lifecycle and run coordination, `provider/db.py` the registry, `provider/runtime.py` the abstraction/local adapter and `provider/cloud_runtime.py` the explicit Cloud adapter.
- `migrations/` owns registry, run, cancellation-fence and runtime-backend state. Packaged `provider/openapi.json` and profile schema match the reviewed root contracts. `Dockerfile` builds from this directory alone.
- `README.md` contains configuration, lifecycle and recovery procedures. `VERIFICATION.md` records service tests; the [current Cloud report](../../docs/phase1/CLOUD-VALIDATION.md) records real hosted evidence.

## Scope and ownership
- Own only `services/sandbox-provider/**`. Python + FastAPI + BoxLite Python SDK; its own PostgreSQL registry.
- Public/internal API is generic: ensure/create, start, stop, inspect, execute approved profiles, cancel, destroy.
- Keep BoxLite behind a `SandboxRuntime` adapter; later clients may use different workloads/providers.
- Never add SRT, HPE project, requester, OfficeCLI or Pi-specific fields to the generic contract.
- STOP must preserve persistent writable disks. DESTROY must be a separate explicit authorized action.
- Never accept arbitrary untrusted shell from a client. Enforce approved OCI image digests/profiles, argument schemas, resource limits and network policy.
- A new consuming use case must use config/profile APIs; generic capability changes require a versioned, independently tested provider release.

## Mandatory quality workflow
- For Python/runtime/API changes, read `.agents/skills/sandbox-provider-development/SKILL.md`.
- For installation, upgrades, diagnostics, recovery or incident handling, read `.agents/skills/sandbox-provider-operations/SKILL.md`.
- Test real BoxLite persistence, two-box isolation, auth/negative paths, service restart and host restart where hardware permits.
- Persist sandbox identity, run status and audit events in the Provider DB, not another service's DB.
- Provide verified health, structured logs, redaction, metrics and a service-owned README.
- Work in a separate branch/worktree; do not edit other services.

## Runtime modes and persistence

- `SANDBOX_RUNTIME_MODE=cloud` selects `BoxLiteCloudRuntime`; `local` is the code default. Neither adapter falls back to another backend or fake. Only tests inject `FakeRuntime`.
- Active GCC staging uses Cloud. The API and PostgreSQL registry run on GCC; guest VMs and writable disks run at BoxLite Cloud. Configure HTTPS origin, runtime-only API key and a stable account scope. No GCC KVM mapping or security relaxation is needed in Cloud mode.
- Local GCC execution remains blocked by bubblewrap namespace restrictions despite usable host KVM. Preserve that finding; do not claim Cloud tests qualify local microVMs.
- Persist backend/account binding, creation dispatch authority and returned runtime ID. Reconcile ambiguous creates against the exact recorded name. A missing list result does not authorize another creation. Backend changes must not reinterpret historical rows or create replacement disks.
- Keep automatic deletion and automatic stop disabled for the Cloud persistence profile; disable automatic resume. Retained operations use the existing returned ID. Stop preserves files; destroy requires separate permission and explicit confirmation.
- Preserve the named volume `/var/lib/sandbox-provider` and one writer per local SDK home. Cloud guest disks are external to this volume. Keep one Provider process for this candidate and avoid overlapping redeployments.

## Build, test and run

Run from this directory using Python 3.12:

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.lock
TEST_DATABASE_URL="$DISPOSABLE_PROVIDER_TEST_DATABASE_URL" .venv/bin/python -m pytest -q -m 'not real_runtime'
```

**Tests truncate registry tables.** Use a dedicated disposable Provider database. These tests use real PostgreSQL with fake runtime behavior or the real SDK against a loopback HTTP stub. They do not prove hosted execution.

After injecting the environment, `python -m scripts.migrate` applies migrations and `python -m provider.app` starts the service and recovery. Production installs use `requirements.lock`. The service does not automatically load dotenv files.

The `real_runtime` test and `scripts.qualify_runtime` are local-mode qualification tools. They require usable KVM, compatible container policy and an approved profile; `qualify_runtime` refuses Cloud mode. Missing KVM is a local skip/blocker, not evidence against or for Cloud. Qualify hosted behavior separately through real HTTP calls and retain exact fixture creation/destruction authority.

## Security and operational invariants

- Authentication determines actor and owner. Only an explicitly authorized delegate can supply `X-Owner-ID`; reads, events, metrics and nested run operations retain owner isolation.
- Execute fixed operator-owned argv with JSON Schema arguments. Never allow a request to choose a shell, image, mount, executable, cwd or secret environment. Preserve immutable profile IDs and image digests.
- Validate Cloud capacity without silent rounding: whole-GiB memory and disk, Cloud CPU bounds and approved network directions. Metadata checks are not complete quota or isolation proof.
- Cloud `allowed_hosts` rules have no URL schemes or port suffixes. Reject such configuration before registry creation intent. Exact-hostname rules do not enforce destination ports; preserve this limitation and separately qualify DNS/UDP behavior.
- Enforce approved sandbox execution capacity using durable registry constraints: omitted `max_concurrent_runs` means one; newly versioned Cloud profiles may opt into shared capacity. Preserve idempotency keys, execution references, cancellation fences and destruction tombstones through restart and archival.
- Exclusive Cloud active-command attach fails with nonretryable `ambiguous_execution`; its recovery stops the same retained environment. Shared runs instead reconcile their exact nonce-bound supervisor journal and never stop siblings on cancellation, deadline or recovery failure. Linux subreaper termination must reap every descendant before terminal status; uncertainty retains active/cancelling ownership. Never turn missing output into success or replay uncertain work. Fresh and recovered shared completion requires the verified envelope.
- Keep structured logs free of credentials, payloads and native sensitive errors. Preserve append-only audits of actor, target, time and outcome. Report cancellation truthfully after actual termination/fencing.
- Do not add privileged containers, host capabilities, Docker sockets, broad mounts, unconfined profiles or global host security changes as a compatibility fix. Never delete account-wide resources.

## Current acceptance and health

Provider runs privately on GCC, alias `workflow-phase1-sandbox-provider`, port 8000, with its own PostgreSQL resource. `/health/live` proves process liveness. Cloud `/health/ready` checks DB and bounded authenticated Cloud control connectivity; it does not prove guest execution or retention. Local readiness still misses the known namespace failure. `/metrics` requires `sandbox:read` and is owner-scoped.

Actual hosted execution, same-box marker stop/start, bounded two-box file separation and stopped-box recovery across independent application replacements passed. Test fixtures were explicitly destroyed and their audits retained. Do not reuse their names or destruction authority.

Generic scoped chunk transfer is implemented in candidate rc.2 under the fixed guest root `/opt/workflow-transfer`; see [its reviewed contract](../../docs/contracts/scoped-files-v1.md). It requires separate `sandbox:file:read`/`sandbox:file:write` permissions and a Python3 guest. The registry stores transfer metadata only. Commit the pending-operation generation before guest side effects; never clear another generation's fence. Recovery stops the same retained environment before allowing a retry. Preserve immutable destinations, descriptor-relative no-follow path traversal, checksums and bounded chunks.

Cloud execution uses a fixed Python wrapper with a nonce/checksummed completion envelope and bounded same-guest journal. Silent commands still require the completion envelope; empty SDK streams with exit0 are ambiguous. Active-command attachment still fails closed, without replay. Workload `secret_environment` stores only operator `WORKLOAD_SECRET_*` references; resolve values at dispatch, never into profile snapshots. Exact secret values in returned stdout/stderr are redacted; this is not exhaustive secret detection.

Cloud transfer preserves public1 MiB chunks through64 KiB internal writes and32 KiB reads using fixed-helper bounded argv. Rehash at the end of each public read; metadata-only mutation checks can miss same-tick writes. Observed upload cost is roughly11.5 seconds/MiB. Explicit destroy polls same-ID absence after acknowledgement and returns retryable `runtime_transition_pending` if deletion remains pending; replay destroy directly.

The actual Cloud journey in `docs/release/cloud-transfer-journey.json` covers local Provider process replacement, transfer ownership/path negatives, file export/reupload into a distinct sandbox, cancellation descendants and a separate forensic registry restore. It is not GCC deployment, active-command reattachment, whole-VM/coordinated restore, off-host recurring backups, host restart or broad security/resource proof. Nonempty `artifact_output_ref` still returns422; file endpoints are scoped transport. Cloud snapshot/export/import/clone remain unsupported. Follow the [current readiness record](../../docs/phase1/readiness.json).

Shared supervisors also enforce the original absolute registry deadline inside the guest, including while Provider is offline. Expired delayed dispatch never starts the workload; deadline cleanup reaps descendants and returns exit124 in the unchanged checksummed Result envelope. Provider classifies that result against the retained original deadline; no public wire field is added.
