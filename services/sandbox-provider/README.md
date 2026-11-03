# Sandbox Provider v1 (release candidate)

Independent Python 3.12 / FastAPI / PostgreSQL service with BoxLite 0.11.0 behind `SandboxRuntime`. It owns its registry and never queries Runner tables. The API contains no application-specific behavior.

**Release status: incomplete.** Explicit hosted BoxLite Cloud on GCC passed real Runner→Provider HTTP execution, same-box stop/start file retention, two-box file separation and stopped-box recovery across independent service replacements. See [Cloud validation](../../docs/phase1/CLOUD-VALIDATION.md) for exact evidence and deployed commit. Scoped artifact transfer, active-output recovery, full backup/restore and broader resource/security gates remain incomplete. Local BoxLite still fails the GCC bubblewrap user-namespace boundary. Authenticated Cloud readiness alone does not qualify workloads.

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

The entrypoint instantiates a real BoxLite adapter selected explicitly by `SANDBOX_RUNTIME_MODE=local|cloud`; local remains the default. Neither mode falls back to another runtime or a fake. Only tests inject doubles. Provider has no public domain or host port in staging; use a private network alias and credentials. Do not mount the Docker socket, host root or arbitrary directories; do not enable privileged mode. Local mode can require narrow `/dev/kvm` access and the matching KVM group. Cloud mode uses authenticated outbound HTTPS/WebSocket connections and needs no KVM device/group or host policy changes. It never publishes guest ports or creates a tunnel.

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
| `SANDBOX_RUNTIME_MODE` | `local` by default; `cloud` explicitly selects the hosted SDK REST backend |
| `BOXLITE_REST_URL` | Cloud-only required HTTPS origin, without credentials/query/path; external configuration |
| `BOXLITE_API_KEY` | Cloud-only required account key; secret, runtime only, never included in profiles/images/logs |
| `BOXLITE_ACCOUNT_SCOPE` | Cloud-only required stable operator label for this account; also prefixes new box names |
| `BOXLITE_REST_PATH_PREFIX` | Optional server-provided routing prefix; distinct from the operator account label |
| `RUNTIME_REQUEST_TIMEOUT_SECONDS` | `30`, range1..120; bounded Cloud control requests/state polling; no automatic create/exec replay |
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

## Explicit hosted Cloud mode

Cloud mode retains BoxLite0.11.0, matching the canonical hosted guide revision
2026-11-02.1. It uses `Boxlite.rest(BoxliteRestOptions(...))` with an
`ApiKeyCredential`, never a convenience/context-manager box that might create
or remove persistent state. No dependency or public `/v1` change is required.
Configure the mode, HTTPS origin, API key and stable account scope in Coolify;
remove local KVM device options from this application's deployment. Keep the
Provider registry database persistent. `BOX_ROOT` remains available for retained
local history; it does not contain Cloud guest disks.

Cloud rounds fractional-GiB RAM upward. A **new Cloud creation** therefore
requires memory to be at least1024MiB and a multiple of1024MiB, CPU1..16 and
whole-GiB disk. Invalid profiles fail422 before Cloud requests; limits are
never silently rounded. Keep old immutable profiles configured/authorized for
historical reads, and introduce a new profile ID for Cloud capacities. An
approved image must be an immutable OCI digest accepted by the account; there
is no automatic substitution with a mutable Cloud image alias.

Approved sandbox profiles can supply optional operator-owned `entrypoint` and
`cmd` arrays. These are fixed direct argv values, never request interpolation.
Use a suitable persistent PID1 for the chosen image. For example, an approved
Python fixture can configure `entrypoint` as
`["/usr/local/bin/python3","-c","import time; time.sleep(31536000)"]` with
`cmd:[]`; workload files remain under `/opt/workflow-fixture`, a rootfs path.
Consumers cannot select the executable or introduce a shell through the API.

Cloud creation sends `auto_delete=0`, `auto_stop=0`, `auto_resume=False`,
`auto_remove=False` and `detach=True`. Modern lifecycle fields are essential:
the SDK's deprecated `auto_remove` flag alone is not a Cloud retention policy.
Inbound is disabled and no port/tunnel operation is called. Denied outbound
means no guest NIC; allowlisted outbound uses the exact approved host rules.
SDK0.11 encodes disabled inbound using its compatible outbound-only wire
shape; returned metadata must still confirm disabled inbound. Enabled outbound
with an empty allowlist would be unrestricted and is rejected by profile policy.

Before approved execution/start, the adapter verifies returned identity,
requested image string, CPU/RAM, zero automatic deletion/stop, disabled
automatic resume, and inbound/outbound policy. A mismatch fails closed. Python
`BoxInfo` does not expose disk capacity or a resolved image digest, so this
metadata check is **not** disk-limit or pulled-image attestation. Validate
actual guest capacity, denied traffic and account image behavior in the real
qualification. Never advertise metadata alone as isolation proof.

The Provider first commits its opaque sandbox name and backend binding, then
durably records that Cloud creation may have been dispatched, before the
external POST. A timed-out creation can be reconciled only to that exact name
with matching metadata. If it cannot be found, a repeated API request returns
nonretryable `ambiguous_creation` instead of creating another box. The SDK list
does not paginate; an absent result is not proof of global absence. Operator
reconciliation is required, not blind fence reset or a new create. A preexisting
name is refused on the first attempt. Only the returned Cloud ID is used for
retained start, stop, inspect, execute and explicit destroy.

Migration003 stores `runtime_backend` and `runtime_create_attempted`. Existing
rows default to `boxlite-local`; switching mode does not move or reinterpret
their identities. They remain queryable under their original profile policy,
but mutations against the wrong backend fail409. The Cloud binding hashes the
configured origin, stable account scope and routing prefix, excluding the key;
legitimate key rotation within the same account preserves access. Verify the
replacement key belongs to that same account. Do not reuse the account label
for another account or change routing/origin to rebind existing records.

Stop polls bounded metadata until the same ID is retained in a settled stopped
state; start similarly waits for running. Explicit deletion waits for stop and
confirms absence, allowing bounded reconciliation of a transition refusal.
SDK `close()` is a no-op in this pinned version and never invokes account-wide
shutdown. No code enumerates then deletes unrelated account resources.

Cloud readiness performs a bounded authenticated SDK list request. It returns
503 when authentication/control connectivity fails and never consults local
KVM. A200 proves that read capability, not creation quota, guest execution,
policy enforcement or persistent backup. Public health errors omit credentials,
native response bodies, account metadata and workload output.

Recovery of a **stopped** Cloud box uses its persisted backend plus returned ID
and verifies the same retained filesystem through the real integration suite.
Recovery of an **active command's output** is deliberately incomplete: SDK0.11
can recover a zero exit status after losing output, without exposing every
loss to Python. The adapter refuses Cloud `attach` with nonretryable
`ambiguous_execution`; the service stops that exact box and requires operator
reconciliation, preserving its disk and never rerunning the command. Native
`error_message` results also fail closed. Fresh stream-disconnection behavior
still needs failure-injection qualification; a successful normal stream does
not establish reconnect/replay guarantees.

Cloud owns the guest disk and physical execution host. GCC backups cover the
Provider registry/audits/configuration, not that remote disk. The reviewed
Cloud capability response does not enable export/snapshot/import/clone; no
independent full guest backup/restore has been demonstrated. Define and test
an approved external data backup/export procedure before accepting durable
production data. Provider/GCC restart recovery and physical Cloud-host restart
are separate gates; the latter cannot be proven by restarting this container.

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

The default test suite uses real PostgreSQL and a deterministic in-memory runtime for API behavior. The Cloud adapter suite additionally uses the **actual pinned SDK** against a loopback HTTP stub, including separate Provider instances with retained PostgreSQL/backend IDs. It verifies wire lifecycle/network/resource fields, transition polling, authentication failures, creation fencing, metadata drift and backend isolation. The stub creates no real guest, disk or isolation boundary. These tests are not hosted Cloud or physical host recovery evidence. `test_real_runtime.py` covers the separate local mode, skips without KVM and never falls back to a fake. Real Cloud qualification goes through the deployed service HTTP integration probe.

A test-only real HTTP process is available from the source checkout:

```sh
# Uses required DATABASE_URL/auth/profile env above; loopback only.
PORT=58002 .venv/bin/python -m tests.serve_fake
```

That server emits readiness503 with `runtime:disabled`; the production image excludes tests. It supports the generic approved fixture programs in the published template and exists solely for HTTP integration with a real Runner/PostgreSQL. It does not execute external workloads or prove isolation/persistence.

See `VERIFICATION.md` for actual executed commands and current blockers.

## Operator runtime qualification

`scripts/qualify_runtime.py` is explicitly **local-mode-only** and refuses Cloud
mode. It uses only production dependencies and the real
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

Read bounded SDK operator logs from an existing session without opening the
runtime or creating another session:

```sh
python -m scripts.read_runtime_diagnostic --session "$QUALIFICATION_SESSION"
```

The helper reads only the latest two 8KiB tails of that session's dated
`boxlite.log` files, redacts configured secrets, and refuses symlinked log
directories/files. BoxLite deliberately returns a sanitized Python error;
its SDK log contains the native preflight cause. This is diagnostic evidence,
not an execution test.

### Restricted GCC container: observed blocker and proposed correction

On 2026-11-03, the independently captured native SDK log showed:

- Non-root UID10001, groups993/10001, `/dev/kvm` read/write, no effective
  capabilities, `NoNewPrivs=1`, Docker seccomp mode2.
- Successful image manifest/layer downloads and creation of a persistent COW
  root disk, followed by failure before the VM subprocess could start.
- `bwrap --unshare-user` denied; raw `clone(CLONE_NEWUSER)` returned errno1
  (`EPERM`). The SDK detected
  `kernel.apparmor_restrict_unprivileged_userns=1`, selected its bundled bwrap,
  and generated an AppArmor profile inside the container. It did not load it.
- The disposable failed box was explicitly removed; there was no successful
  guest command, retained marker or running microVM.

The enforced boundary is currently incompatible with BoxLite's standard
bubblewrap jailer. The SDK's AppArmor diagnosis comes from a sysctl check;
that log alone does not distinguish an AppArmor denial from Docker seccomp.
Docker's default seccomp also gates namespace-bearing `clone`, `unshare` and
mount operations when host `CAP_SYS_ADMIN` is absent. Host LSM audit records
and a bounded syscall trace are needed to attribute each denied operation.
KVM permission changes cannot resolve this namespace failure.

The minimum candidate correction is a reviewed policy attached only to the
new Provider container, followed by complete qualification. It has **not**
been applied or verified:

1. Retain UID10001, `--cap-drop=ALL`, no-new-privileges, narrow `/dev/kvm`
   mapping, the dedicated persistent volume, resource caps and SDK standard
   jailer/seccomp. Do not grant host `CAP_SYS_ADMIN`, disable the SDK jailer,
   enable privileged mode or use an unconfined security profile.
2. Derive a container-specific seccomp profile from the Docker default. After
   confirming actual denied calls, permit only the namespace setup and mount
   calls needed by unprivileged bubblewrap, constrain arguments where possible,
   and retain all unrelated denials. Seccomp cannot itself determine whether
   a mount call originates in the child user namespace; kernel namespace
   permissions and the AppArmor policy must preserve that boundary. This
   requires review, not a blanket syscall allowance copied from an example.
3. If AppArmor audit records confirm a denial, prepare a separately named
   Provider profile granting the necessary user namespace and bounded mount
   operations. Have the host operator review/load that new profile and attach
   it only to this application. Do not change global sysctls or existing
   Docker/application profiles. The SDK-generated profile contains broad
   permissions and is diagnostic input, not a reviewed production policy.
4. Installing system `bubblewrap` in the image is a possible packaging step:
   BoxLite prefers a working `bwrap` on PATH. It does **not** load an AppArmor
   profile into the host kernel, remove the inherited Docker profile or bypass
   outer seccomp. Debian image package contents and the host's AppArmor profile
   must be verified; setuid packaging cannot bypass no-new-privileges. An image
   package addition alone is not a demonstrated fix.
5. Once explicitly approved policies are applied, first repeat the same
   bubblewrap namespace probe under exact deployment restrictions, then real
   BoxLite create/execute, stop/start retention, two-box isolation, API/Runner
   integration, container-replacement recovery and backup/restore. Record
   resource pressure and denied-operation logs. No host reboot is authorized.

Current `/health/ready` checks PostgreSQL, `/dev/kvm` access/API version and
the pinned SDK import. It does not execute bubblewrap, so it can return200 on
this known-blocked host. Treat that response as prerequisites only until this
readiness defect is fixed; it must never be used as evidence of workload
readiness. The proposed follow-up is a bounded startup probe of the exact bwrap
selected by the SDK, using its non-destructive `--unshare-user --ro-bind / /
-- true` preflight in a child process. Cache the outcome briefly rather than
forking on every public health request, fail closed with readiness503 on
denial/timeout, and publish only a safe classification. Do not create a VM,
download an image, remove a box or expose native operator diagnostics from
readiness. Even a passing namespace probe leaves real execution acceptance
dependent on the separate qualification suite.

`GET /metrics` is an authenticated Prometheus endpoint requiring `sandbox:read`. It scopes sandbox/run state gauges to the effective credential owner (and honors explicit delegation), without owner IDs, paths, workload text or credentials in labels. `/health/live` and `/health/ready` remain public safe health endpoints. Scrape `/metrics` on the private network using a read-only credential.

Coolify may override image health checks with its own `curl` probe; the production image includes `curl` and CA certificates for this integration. With missing host KVM, an explicitly API-only staging deployment may use `/health/live` for container liveness, while `/health/ready` must continue to return503 and block workload acceptance. This does not qualify BoxLite or Phase2 readiness.
