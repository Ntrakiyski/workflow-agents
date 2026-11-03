# GCC Coolify suitability evaluation

Assessment date: 2026-11-03 (Europe/Sofia). Target: `https://hosting.gccssofia.com/`. Scope: evaluate only. The user's instruction to pause deployment remains in force. No GCC project, application, database, volume or deployment was created for this evaluation; no existing workload was changed. A Coolify diagnostic initiated its connectivity-validation check; no host configuration change was requested.

**Decision: the observed capacity supports a small, bounded Phase 1 staging trial. Full deployment acceptance remains conditional on actual restricted-container BoxLite execution, persistence and recovery tests.** This is not a production capacity guarantee or authorization to deploy.

## Evidence and interpretation

Live host readings below were supplied by the user from the GCC VM. The evaluator inspected the GCC Coolify API independently. Available direct SSH credentials were rejected, so these host readings are attributed to the user rather than claimed as independently executed commands.

| Area | Observed evidence | Interpretation |
| --- | --- | --- |
| Architecture/kernel | x86_64, `7.0.0-1017-azure` | Compatible architecture; pinned Python/Node/PostgreSQL OCI indexes contain linux/amd64 variants. |
| Virtualization | AMD-V, Microsoft hypervisor; `kvm_amd: Nested Virtualization enabled`; `/dev/kvm` exists | Host prerequisite is present; root/user device visibility is not a successful microVM test. |
| Device permissions | Mode 660, root:kvm, host KVM GID 993 | Non-root Provider UID 10001 needs narrow device access and supplemental group 993. |
| CPU | Four logical CPUs; load average 1.25/0.74/0.68 | Snapshot supports a modest trial; load average is not CPU utilization or a peak-demand measurement. |
| RAM | About 15 GiB total, 6.7 GiB used, 8.9 GiB available | Enough observed memory headroom for the proposed approximately 2.9 GiB aggregate limit. Available memory includes reclaimable cache and is not reserved. |
| Swap | 2 GiB total, 1.5 GiB used | Could be residual pages from earlier pressure. Current paging activity is unknown; inspect `vmstat` swap-in/out during qualification. No swap or host changes are proposed. |
| Disk | 123G root filesystem, 40G used, 83G available; `/data` shares `/dev/root` | Enough observed space for the fixture trial. Root and `/data` are the same capacity pool; image cache, database growth, retained disks and backups compete. |
| Container runtime | Docker 29.9.0, cgroups v2, AppArmor default and builtin seccomp | Provides resource controls; compatibility with BoxLite's standard security/jailer remains untested. |
| Existing workloads | 20 Coolify application/service resources; 15 running. User Docker sample lists 25 running containers | This is an occupied shared host. Service resources can contain several containers; resource and container counts are different measures. Several containers show the host-wide memory ceiling. |
| Coolify | 4.5.3; one reachable local server and standalone Docker destination | Basic discovery/API access works. No `workflow-agents-phase1` project exists in GCC. Creation/configuration has not been tested or attempted. |

The host snapshot is not a sustained-load test. No swap-pressure diagnosis, peak workload envelope, storage durability guarantee or runtime performance claim is inferred from it.

GCC server UUID: `jg8gsskgw44okokksco0k84c`; destination UUID: `jgkwk80w0ko08gog0k4sc0w0`. Existing Worfklow resource IDs must remain separate from any future GCC resource IDs. A deployment implementation must bind the target URL and project/resource manifest explicitly, verify their identity, then mutate only the new project resources. Merely changing the URL of the current Worfklow manifest is not a migration procedure.

## Proposed initial limits — not applied

| Component | CPU ceiling | RAM ceiling |
| --- | --- | --- |
| Job Runner |0.5 CPU|384MiB|
| Sandbox Provider, including VMM processes/guest memory |1.5 CPU|2048MiB|
| Job Runner PostgreSQL |0.25 CPU|256MiB|
| Sandbox Provider PostgreSQL |0.25 CPU|256MiB|
| Aggregate ceilings |2.5 CPU|2944MiB (2.875GiB)|

These are conservative trial configuration proposals, not measured requirements or CPU/RAM reservations. Provider RAM is increased from the current API-only manifest's 1024 MiB to allow more room for microVM/runtime overhead. CPU ceilings do not add CPU hardware or reserve it away from existing workloads. Start builds sequentially, since build processes are not necessarily subject to the final application runtime limits.

Start Runner global concurrency and Provider execution concurrency at 1. Initially admit one running fixture sandbox; create a second only for the controlled isolation scenario. The existing generic fixture requests one virtual CPU, 256 MiB guest RAM and a 1024 MiB whole-GiB disk policy. Those guest settings are included within the Provider budget, not an extra independent allocation. Actual image size, disk/network enforcement and runtime overhead still require testing.

`MAX_CONCURRENT_RUNS` limits active command dispatches, not all running microVMs. A retained idle VM can continue using memory until stopped. Per-owner registered-sandbox quotas also do not express a global memory budget. Control admission and stop idle fixture boxes during qualification; do not infer safety from execution concurrency alone.

## Container security is the remaining compatibility question

The [pinned BoxLite 0.11.0 deployment guide](https://github.com/boxlite-ai/boxlite/blob/v0.11.0/docs/guides/deployment-patterns.md#docker-container-deployment) shows Docker running with `--privileged` and `/dev/kvm`, and warns about shared/multi-tenant environments. This does not independently prove that blanket privilege is unavoidable, but the project's restricted configuration has not been qualified.

The first acceptable qualification would use the existing non-root UID, all capabilities dropped, no-new-privileges, standard SDK security, resource limits, named persistent storage and only narrow KVM access plus the actual host KVM group:

```text
--device=/dev/kvm:/dev/kvm:rw --group-add=993
```

Those options are proposed, not applied or tested on GCC. Verify the device API and actual create/execute behavior from that restricted container. Device visibility alone is insufficient. Inspect specific failures from AppArmor, Docker seccomp, namespace creation, filesystem permissions or SDK security before drawing a conclusion. No privileged mode, unconfined security profile, broad host mount, Docker socket, host-wide security change or reboot is approved by this evaluation.

If the runtime cannot operate under the agreed restrictions, stop the qualification and assess a separately isolated execution host or a narrowly justified configuration change. Do not copy the privileged example onto the shared GCC host as a shortcut.

## Deployment shape if approved later

Prefer both services and both PostgreSQL databases together in one new GCC project, `workflow-agents-phase1`, environment `staging`. Keep all four resources private, with separate database credentials/volumes and stable internal application aliases. Place the BoxLite SDK registry/disks together in the Provider named volume, with only one Provider writer. This avoids adding cross-host HTTP/database networking for the initial trial.

Rebuild the pinned service source for linux/amd64; do not copy ARM64 service images or promise migration of persistent ARM VM disks. Worfklow has no successfully created BoxLite VM to migrate. Use fresh staging state and credentials while retaining the existing Worfklow deployment and its historical QA evidence. Its removal is a separate action, not part of this evaluation.

## Required qualification and remaining gates

1. Execute a real generic marker-write workload under the exact restricted Provider configuration; inspect resource pressure, paging, logs and audits.
2. Stop without destruction, restart the same runtime identity and read the marker; run another command.
3. Perform the two-sandbox isolation and authorization negatives, bounded retries, duplicate submission and cancellation scenarios.
4. Restart Runner and Provider independently against retained state; verify actual runtime reattachment and no duplicate execution.
5. Test coordinated stopped registry/database plus entire VM-volume backup/restore to an isolated target; configure off-host backups. Current free disk and persistent volumes are not a backup strategy.
6. Host-restart recovery remains unverified; no shared-host reboot is authorized.

Scoped artifact transfer/export remains an independent implementation gap. Moving to GCC does not resolve it or the remaining release gates. Phase 1/Phase 2 readiness remains blocked until its required checks and generic functionality are complete.
