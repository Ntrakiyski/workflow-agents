# Sandbox Provider v1 (release candidate)

Independent Python 3.12 / FastAPI / PostgreSQL service with BoxLite 0.11.0 behind `SandboxRuntime`. It owns its registry and never queries Runner tables. The API contains no application-specific behavior.

**Release status: incomplete.** Real microVM persistence/isolation and host recovery require qualified KVM hardware. Passing API/database tests with a fake runtime does not pass those gates.

## Build and run

From this directory:

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.lock
# Export DATABASE_URL, PROVIDER_AUTH_JSON and PROVIDER_PROFILES_JSON securely.
.venv/bin/python -m provider.app
```

Production installs use `requirements.lock`; development installs use the complete pinned `requirements-dev.lock`. `requirements.txt` and `requirements-dev.txt` document direct dependencies. Do not mix service dependency environments. Python 3.12 is the tested interpreter.

```sh
docker build -t workflow-sandbox-provider:1.0.0-rc.1 .
```

The Dockerfile is independently buildable with this directory as build context. It pins the Python base by OCI index digest and runs UID/GID 10001. A named volume must retain `/var/lib/sandbox-provider`; image directory ownership initializes a new volume correctly. `BOX_ROOT` holds BoxLite's own registry and disks; the separate PostgreSQL database holds public identities and run/audit records. Neither store alone is a recoverable environment.

The entrypoint always instantiates the real BoxLite adapter. There is no environment variable that silently enables a fake runtime. Only tests inject a double. Provider has no public domain or host port in staging; use a private network alias and credentials. Do not mount the Docker socket, host root or arbitrary directories; do not enable privileged mode. A narrow `/dev/kvm` mapping plus a matching supplemental KVM group can be required. Standard BoxLite jailer/seccomp is retained; if the host/container cannot satisfy it, report the deployment blocked rather than weakening it.

## Configuration

| Variable | Meaning/default |
|---|---|
| `DATABASE_URL` | Required connection to **Provider's** PostgreSQL database, using its own credential |
| `PROVIDER_AUTH_JSON` | Required array of credential policies; see below; secret |
| `PROVIDER_PROFILES_JSON` | Required approved configuration matching `provider/profiles.schema.json` |
| `BOX_ROOT` | `/var/lib/sandbox-provider/boxlite`; persistent writable SDK registry/disks |
| `PORT` | `8000` |
| `LOG_LEVEL` | `INFO`; request bodies, tokens and workload output are never logged |
| `MAX_SANDBOXES_PER_OWNER` | `20`; retained non-destroyed boxes per effective owner |
| `MAX_BODY_BYTES` | `65536`, may only be lowered |
| `MAX_OUTPUT_BYTES` | `32768` per stdout/stderr stream; also capped by workload policy |
| `RUN_POLL_SECONDS` | `0.25`; state/cancellation polling interval |
| `AUDIT_RETENTION_DAYS` | `90`; archival planning threshold, **not automatic deletion** |

Credential format (replace placeholders with independently generated secrets at least 24 characters):

```json
[
  {"token":"REPLACE_WITH_STRONG_CLIENT_TOKEN", "actor_id":"fixture-client", "owner_id":"fixture-owner", "permissions":["sandbox:read","sandbox:create","sandbox:start","sandbox:stop","sandbox:execute","sandbox:cancel","sandbox:destroy"], "sandbox_profiles":["minimal-linux:v1"], "workload_profiles":["fixture-write-file:v1","fixture-read-file:v1"]},
  {"token":"REPLACE_WITH_STRONG_RUNNER_TOKEN", "actor_id":"job-runner", "owner_id":"job-runner", "delegate_owners":["fixture-owner"], "permissions":["sandbox:read","sandbox:create","sandbox:start","sandbox:stop","sandbox:execute","sandbox:cancel"], "sandbox_profiles":["minimal-linux:v1"], "workload_profiles":["fixture-write-file:v1","fixture-read-file:v1"]}
]
```

Only an explicitly configured delegate can send `X-Owner-ID`, and it must select an allowed owner. Ordinary clients cannot supply it. Tokens are compared as bytes; Unicode invalid tokens fail authentication safely. `actor_id` remains the authenticated service identity; `owner_id` is the authorization/storage owner. References in bodies never grant access. Permissions separately gate `sandbox:read`, `sandbox:create`, `sandbox:start`, `sandbox:stop`, `sandbox:execute`, `sandbox:cancel` and `sandbox:destroy`; allowlisted profiles also apply. Read-only credentials cannot mutate environments or runs.

`config/profiles.template.json` is a template, not deployable until its digest placeholder is rendered. The repository contract fixture uses a Python image and trusted direct argv programs that write/read a bounded filename under `/opt/workflow-fixture`, a rootfs location rather than potentially volatile `/tmp`. Pin a verified immutable image digest. Future approved workloads can be added through operator configuration: JSON Schema arguments, fixed executable/argv tokens, environment, cwd, resource policy and profile authorization. Only whole `${arg:NAME}` argument tokens can interpolate validated scalar values. Executable/cwd/environment are never selected by clients; no shell string is constructed. `$ref` in argument schemas is rejected to avoid external schema resolution. Keep profile IDs immutable when changing behavior or image versions.

BoxLite disk capacity accepts **whole GiB only** (`disk_mib` divisible by 1024); other values are rejected, never rounded silently. SDK disk size is at least the base-image capacity: qualify the image fits the requested disk before accepting a real profile. CPU/RAM and disk virtual capacity use SDK options; denied/allowlist networking uses SDK `OutboundNetworkSpec`. No host mounts or published guest ports are configured. Runtime resource/security enforcement still needs real-host tests; a configuration assertion is not evidence that the kernel applied it.

## API and semantics

`provider/openapi.json` is the packaged frozen `/v1` contract. Root `contracts/v1/provider-v1.openapi.json` is authoritative; keep copies identical. `/openapi.json` serves it. Health endpoints are unauthenticated; every `/v1` route requires credentials. Errors are safe root `{code,message,retryable,correlation_id}` objects; correlation IDs are echoed.

Create and execute require `Idempotency-Key`. Deduplication is durable per effective owner, operation and target. Canonical request fingerprints reject changed reuse. Create also ensures one retained `(owner_id, owner_ref)`; destroyed references remain tombstones. Start/stop bodies are `{}`. Execute returns 202 and a durable run; poll for real completion. Nonzero exit codes fail. Unsupported `artifact_output_ref` fails 422 before execution: this version has no external scoped transfer adapter and never fetches caller URLs. Results provide bounded stdout/stderr; artifact arrays remain empty. No transfer or external backup is implied.

`POST /sandboxes/{id}/runs/cancel-by-reference` durably fences an execution reference under the same sandbox row lock as execute. A delayed execute cannot start after cancellation won the race. Existing run replays keep their current state; new fenced references fail 409 `execution_cancelled`. This permits Runner to cancel after a timeout with no returned run ID.

PostgreSQL row locks and a partial unique index enforce one active run per sandbox across processes. Workers use session advisory locks for recovery ownership. There are four simultaneous dispatch slots per Provider process; run the production image as one Uvicorn process. Multiple Provider instances must not independently mount/copy the same BoxLite home without a separately qualified runtime configuration.

STOP preserves disks; only the separately authorized explicit DESTROY endpoint calls SDK remove. It refuses active runs and requires `confirm:true` plus a reason. Cancellation is an intent until the runtime confirms the command stopped. Unknown outcomes never start a fresh run automatically.

## Migrations, recovery and rollback

Startup applies service-owned SQL migrations under a PostgreSQL advisory lock. Replaying migrations is idempotent. Explicit migration command:

```sh
DATABASE_URL=... .venv/bin/python -m scripts.migrate
```

The migration credential owns its database; do not give it access to Runner's database. Migration tables: `schema_migrations`, `sandboxes`, `runs`, `idempotency`, `cancellation_fences`, `audit_events`. Audit UPDATE/DELETE is rejected by a database trigger. Retention does not erase idempotency keys or tombstones. Archive audits under a separately controlled maintenance process; this release deliberately has no automatic purge.

On restart, Provider inspects registered retained runtime identities. A missing box becomes failed and is never replaced with an empty environment. A running execution with a persisted SDK execution ID reattaches to that ID; recovered output may be incomplete and is flagged truncated. If the process died between dispatch intent and recording the SDK execution ID, Provider conservatively stops the same sandbox and marks `ambiguous_execution` nonretryable. If stop cannot be proven, active ownership remains `cancelling`; no next execution is admitted. Operator inspection is required before deciding business-level retry.

Rollback this candidate by redeploying its prior immutable image/commit with unchanged persistent volume and database. Current migrations are additive; no automatic destructive down migration exists. Before a future incompatible migration, export and restore-test a complete backup, and use that matching backup/image pair for rollback. Never point an older incompatible schema version at a live registry.

## Backup and restore qualification

A named volume is not a backup. A coordinated backup must retain PostgreSQL registry/audits/idempotency/fences **and the complete BOX_ROOT**:

1. Deny new submissions, cancel/reconcile active runs and stop all sandboxes through the API. Verify no active run remains.
2. Stop only this Provider application, then dump only its database with PostgreSQL 16 `pg_dump --format=custom` using a protected credential mechanism.
3. Archive the entire stopped named volume/BOX_ROOT with ownership and checksums; record database dump checksum, volume archive checksum, SDK/image versions and timestamp together. Encrypt and copy off the execution host.
4. Restore to a new isolated database and volume using the same SDK/image, preserving UID 10001 ownership; do not overwrite live resources during the drill.
5. Start Provider against the restored pair. Confirm the same sandbox identities, marker files, events and deduplication/fences. Explicitly destroy only disposable drill sandboxes.

These are required operational steps, not a claim that full VM backup/restore or host reboot was tested here. A real stopped-disk backup/restore drill and safe host-restart proof remain incomplete without qualified host access. Database-only restore proof cannot stand in for retained disk proof. No host-reboot test is part of the ordinary test command.

## Tests and evidence

Use a new isolated PostgreSQL database that tests may truncate. Never point `TEST_DATABASE_URL` at production or another service's database.

```sh
TEST_DATABASE_URL=... .venv/bin/python -m pytest -q -m 'not real_runtime'
TEST_DATABASE_URL=... .venv/bin/python -m pytest -q -rs
# With KVM, explicit real approved config and persistent BOX_ROOT:
.venv/bin/python -m pytest -q -m real_runtime -rs
```

The default test suite uses real PostgreSQL and a deterministic in-memory runtime. It validates strict wire schemas, auth/owner/delegation, allowlists/path rejection, idempotency, quotas/output bounds, concurrency, cancel/execute races, stop/destroy distinction, audit append-only behavior, JSON log redaction, schema migration replay and Provider-instance recovery. These restart tests model a new service instance while preserving the fake runtime; they are not physical host or actual microVM recovery evidence. `test_real_runtime.py` explicitly skips without KVM and never falls back to a fake.

A test-only real HTTP process is available from the source checkout:

```sh
# Uses required DATABASE_URL/auth/profile env above; loopback only.
PORT=58002 .venv/bin/python -m tests.serve_fake
```

That server emits readiness503 with `runtime:disabled`; the production image excludes tests. It supports the generic approved fixture programs in the published template and exists solely for HTTP integration with a real Runner/PostgreSQL. It does not execute external workloads or prove isolation/persistence.

See `VERIFICATION.md` for actual executed commands and current blockers.
