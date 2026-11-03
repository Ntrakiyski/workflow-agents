# Sandbox Provider v1 (release candidate)

Independent Python 3.12 / FastAPI / PostgreSQL service with BoxLite 0.11.0 behind `SandboxRuntime`. It owns its registry and never queries Runner tables. The API contains no application-specific behavior.

**Release status: incomplete.** The actual Coolify execution host rejects a narrow `/dev/kvm` device mapping because the device is absent. Real microVM persistence/isolation and host recovery require qualified KVM hardware. Passing API/database tests with a fake runtime does not pass those gates.

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

If the platform does not support Docker `--group-add`, build with the optional
`KVM_GID` argument set to the execution host's numeric KVM device group. This
adds that supplementary group to the existing non-root `provider` account;
`USER provider` preserves UID/GID10001 and lets Docker resolve its configured
supplementary memberships. Empty/default builds add no KVM group. Zero and
non-numeric group IDs are rejected. Set this non-secret argument as a
build-time-only platform variable, verify `id` in the resulting image, and
still map only `/dev/kvm`. Group membership does not grant kernel capabilities
or bypass Docker/seccomp/AppArmor restrictions.

## Configuration

| Variable | Meaning/default |
|---|---|
| `DATABASE_URL` | Required connection to **Provider's** PostgreSQL database, using its own credential |
| `PROVIDER_AUTH_JSON` | Required array of credential policies; see below; secret |
| `PROVIDER_PROFILES_JSON` | Required approved configuration matching `provider/profiles.schema.json` |
| `BOX_ROOT` | `/var/lib/sandbox-provider/boxlite`; persistent writable SDK registry/disks |
| `PORT` | `8000` |
| `LOG_LEVEL` | `INFO`; request bodies, tokens and workload output are never logged |
| `MAX_CONCURRENT_RUNS` | `4`; operator may lower to1..4 to fit host capacity; hard ceiling leaves DB pool capacity for API/recovery |
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

PostgreSQL row locks and a partial unique index enforce one active run per sandbox across processes. Workers use session advisory locks for recovery ownership. There are `MAX_CONCURRENT_RUNS` simultaneous dispatch slots per Provider process (default4, range1..4); run the production image as one Uvicorn process. Multiple Provider instances must not independently mount/copy the same BoxLite home without a separately qualified runtime configuration.

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

## Operator runtime qualification

`scripts/qualify_runtime.py` uses only production dependencies and the real
`BoxLiteRuntime`. It runs in its own SDK home under
`BOX_ROOT`'s parent, `.runtime-qualification/<session>/boxlite`, so it never
opens the API process's SDK registry. It does not write the Provider database
or prove API/audit recovery. Its JSON evidence identifies that narrower scope.

Generate a unique lowercase UUID hex on the operator workstation once and
place it in `QUALIFICATION_SESSION`. Supply the same explicit value on every
replay of that session, including Coolify scheduled commands; generating a new
UUID inside a repeating cron command would create separate sessions.

```sh
python -m scripts.qualify_runtime --session "$QUALIFICATION_SESSION" --mode lifecycle
```

This verifies fixture write, non-destructive stop, adapter close/reopen, the same
runtime identity and retained marker, second-box filesystem isolation, safe
stops, and explicit removal of only that session's new boxes. It requires a
configured credential policy allowed to create/start/stop/execute/destroy the
fixture profiles; credentials and workload output are never rendered. Existing
runtime names are refused, not adopted. The session state is mode600 and a
volume-local lock serializes qualification invocations. Completed commands
replay their recorded result rather than creating duplicate boxes.

To retain a stopped marker across an actual container replacement, run these
as separate operator invocations with the same session and persistent volume:

```sh
python -m scripts.qualify_runtime --session "$QUALIFICATION_SESSION" --mode prepare
# Lead operator independently replaces only this Provider container.
python -m scripts.qualify_runtime --session "$QUALIFICATION_SESSION" --mode verify
python -m scripts.qualify_runtime --session "$QUALIFICATION_SESSION" --mode cleanup
```

`prepare` and `verify` retain their stopped disposable boxes until the explicit
`cleanup`; `lifecycle` includes cleanup, including best-effort cleanup on
failure. Failed retained phases preserve state for inspection/cleanup. Each
retained phase must complete once in order; after a failed phase, inspect and
clean the session, then use a new session for another qualification. No mode
recreates a missing retained box. The CLI exits0 for a pass,2 for unavailable
runtime,1 for failure; there is no mock switch or skipped-as-success outcome.

Host KVM visibility, these source instructions and mocked safeguard tests do
not establish real execution. The lead must capture actual JSON results under
the deployed non-root/device/group/security limits. A fresh script process is
not by itself a Provider API-process replacement or physical host restart.

For a failed real-runtime qualification, use a fresh explicit session and add
`--diagnostics`. This operator-only flag emits a bounded, credential/payload-
redacted exception chain and writes the fuller redacted traceback to a mode600
`diagnostic-<mode>.json` in that session directory. It does not change service
error responses, permissions or runtime settings. The default CLI retains only
safe error classifications and creates no traceback file. Never publish the
private diagnostic file without reviewing its contents.

`GET /metrics` is an authenticated Prometheus endpoint requiring `sandbox:read`. It scopes sandbox/run state gauges to the effective credential owner (and honors explicit delegation), without owner IDs, paths, workload text or credentials in labels. `/health/live` and `/health/ready` remain public safe health endpoints. Scrape `/metrics` on the private network using a read-only credential.

Coolify may override image health checks with its own `curl` probe; the production image includes `curl` and CA certificates for this integration. With missing host KVM, an explicitly API-only staging deployment may use `/health/live` for container liveness, while `/health/ready` must continue to return503 and block workload acceptance. This does not qualify BoxLite or Phase2 readiness.
