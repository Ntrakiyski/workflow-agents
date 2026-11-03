# Phase 1 deployment

`coolify.phase1.json` is the reviewed resource configuration. Service Dockerfiles, dependency locks and migrations in Git are authoritative. `profiles.staging.json` is operator configuration for the generic fixture only; its Python image index digest was resolved with `docker buildx imagetools inspect` on 2026-11-03. Capacities and profiles are configurable settings, not service source constants.

Create **one** project `workflow-agents-phase1`, environment `staging`, applications `job-runner`/`sandbox-provider`, and PostgreSQL resources `job-runner-db`/`sandbox-provider-db`. Before creating, list projects to avoid a duplicate. Record all returned UUIDs and mutate only these resources. Do not copy deployment settings to an unrelated project.

Set application build context to its own service directory, Dockerfile `/Dockerfile`, and exact Git commit SHA. Disable automatic deployment and domain generation. There are no public domains or host port mappings; consumers connect from the private Docker network. Shared bridge reachability is not tenant isolation: credentials, per-owner access and allowed profiles remain required.

Generate distinct database passwords and client/service tokens securely; put them in Coolify runtime-only locked variables. The provider delegate credential authorizes only the explicitly configured Runner owner IDs. Client tokens cannot choose delegated ownership. Applications never receive the other database's credentials. Required service-specific variables and verified migration/start commands are in each service README.

Run `host-preflight.sh` directly on the selected execution host and inspect current capacity before enabling microVMs. A device listing is insufficient: use the exact non-privileged container restrictions for the real-runtime marker/isolation test. Add only the narrow `/dev/kvm` device if it exists and is usable. If standard BoxLite security cannot operate under these restrictions, retain failed readiness and document the specific incompatibility. No runtime fallback, privileged mode, host socket, broad mount, virtualization configuration change or shared-host reboot is authorized.

Provider named storage is mounted at `/var/lib/sandbox-provider`; `BOX_ROOT` points inside it. Mounting the parent preserves SDK registry plus disks together. Run exactly one Provider process/instance per BoxLite home, and serialize provider redeployments to avoid overlapping SDK ownership. Stop boxes explicitly without removing them before planned maintenance. `destroy` is for explicitly authorized deletion only.

The manifest's Provider container health checks liveness so an unavailable runtime can still expose honest diagnostic APIs. This is **not** release readiness: independently inspect `/health/ready`, which must fail if real BoxLite/KVM is unavailable. Runner readiness must include its DB and worker. Deployment acceptance requires real generic jobs, logs, audit records, stop/start retention, service recovery and approved host-restart proof.

## Backups and recovery

Use separate scheduled PostgreSQL logical backups for both new database resources, with defined local retention and an operator-configured off-host copy destination. Local backups alone do not survive host/disk loss. Restore backups to isolated resources first and compare migrations, row counts, audit/event identities and pending jobs before cutover. `verify-db-restore.py` performs a disposable local `pg_dump`/`pg_restore` drill against explicitly named test containers, not production.

A consistent Provider backup requires a maintenance window: prevent new submissions, drain/cancel active runs truthfully, stop all retained boxes through the API, stop the Provider process, capture its registry database and entire BoxLite named volume as one recovery set, then restart and verify registry-to-runtime identity before resuming Runner. The backup must preserve ownership, permissions and relative SDK disk paths. Keep the SDK and service versions plus image digests with that recovery set. Encrypt and copy it off-host; test restoration to an isolated KVM-capable host. A volume or a registry-only dump is not a recoverable VM backup.

Never automatically recreate a sandbox if a retained disk is missing. Mark it failed, preserve the identity and audit record, and restore its matching recovery set. Rollback uses the prior immutable service commit/image with a database backup compatible with that version; do not drop forward-migrated tables while jobs may still reference them. Both service READMEs describe their migration reversibility and exact recovery commands.

The final verification record states which backup/restore and restart tests actually ran. Host-restart and BoxLite disk-restore qualification remain incomplete until safely executed on authorized hardware.
