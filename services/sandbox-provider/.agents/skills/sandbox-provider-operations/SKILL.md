---
name: sandbox-provider-operations
description: Install, monitor, audit, recover, and upgrade the standalone BoxLite sandbox service without losing persistent VM disks.
---

# Sandbox Provider operation procedure

1. Read `services/sandbox-provider/AGENTS.md`, the service `README.md`, and the published API version.
2. Verify virtualization/KVM or supported host backend, BoxLite version, writable disk path, registry connectivity and capacity before starting work.
3. Audit box create/start/run/stop/destroy by `sandbox_id`, actor, correlation ID, timestamp and lifecycle outcome.
4. For restart or recovery, inspect registry and BoxLite disk before reattaching; never recreate a box blindly if the result of a prior operation is ambiguous.
5. On idle stop, confirm run completion and exported artifacts; invoke non-destructive stop, not remove/destroy.
6. Back up and restore registry plus retained disk data consistently; verify persistence after Provider and host restart.
7. Troubleshoot network, resource, profile and startup failures using structured logs without printing secrets or customer files.
8. Before upgrading, pin tested SDK/image versions, verify API compatibility and rollback plan; re-run stop/start/isolation fixture tests afterward.
9. Document tested behavior, failures, unverified assumptions and operational limits; do not claim VM memory or Pi context continuity without tests.

## Implemented candidate operations (2026-11-03)

- Production start: `python -m provider.app`; service directory is the Docker build context. Use pinned `requirements.lock` and the checked-in Dockerfile. Required secret variables are `DATABASE_URL` and `PROVIDER_AUTH_JSON`; approved operator profiles use `PROVIDER_PROFILES_JSON`.
- `/health/live` proves process only. `/health/ready` returns503 if DB/KVM/SDK is unavailable; an injected fake returns `runtime:disabled` and can never be counted as verified BoxLite.
- Keep `/var/lib/sandbox-provider` in a named persistent volume owned by UID10001. `BOX_ROOT` plus the independent PostgreSQL registry require a coordinated off-host backup; follow README's stopped-volume/database restore drill. Full disk restore and host-reboot validation are incomplete until actually executed.
- Retain `auto_delete=0`, `auto_remove=False`, `detach=True`, standard SDK jailer/seccomp and explicit stop vs destroy. No production auto-fallback, privileged container, Docker socket or arbitrary host mount.
- Query `/v1/sandboxes/{id}/events` with the owning credential for durable safe events. Missing runtime disks become failed, not recreated. `ambiguous_execution` is nonretryable; inspect the stopped environment before manually authorizing a new execution reference.
- Retention configuration denotes archival policy only: append-only audit triggers prevent ordinary UPDATE/DELETE and deduplication/tombstones remain for resource lifetime.
- `GET /metrics` with a `sandbox:read` credential returns owner-scoped Prometheus sandbox/run state gauges; use the same explicit delegation header policy. The automated test verifies unauthenticated denial and cross-owner count isolation. Health remains unauthenticated and carries no resource payloads.
- Set `MAX_CONCURRENT_RUNS` (default4, range1..4) to the qualified host's workload capacity before deployment. This bounds concurrent dispatches per Provider process while reserving PostgreSQL pool slots for API/recovery. Lowering to1 is regression-tested across two queued sandboxes. Keep one production process per BoxLite storage root.
- `python -m scripts.qualify_runtime --session <explicit-lowercase-UUID-hex> --mode lifecycle` is the production-dependency-only operator runtime probe. Use its isolated SDK home in the named volume, never the active API SDK home. A fixed session makes cron replay safe; `prepare` then an independently recorded container replacement then `verify` then `cleanup` can qualify stopped-disk retention. Existing box names/changed identities are refused. Its direct-runtime JSON excludes API/DB/audit/host-restart claims. The eight local safeguard tests use a fake runtime or a missing-KVM negative; only captured real-host results qualify microVMs.
- When Coolify refuses `--group-add`, set optional Docker build argument `KVM_GID` to the host KVM device's positive numeric group ID as a build-time-only variable. The image retains UID/GID10001 and `USER provider` resolves its supplementary group. Default builds add no group; zero/non-numeric values fail. Verify `id` under the exact runtime restrictions and retain narrow `/dev/kvm` mapping. This is device-file permission, not privileged execution or proof of BoxLite compatibility.
- After a failed qualification, `python -m scripts.read_runtime_diagnostic --session <same-session>` reads at most two 8KiB tails from that isolated SDK home's dated `boxlite.log` files. It requires existing session state, refuses directory symlinks, skips file symlinks and redacts configured secrets. It never opens runtime/database state. BoxLite 0.11.0 intentionally hides host causes from Python exceptions; the operator logs retain the actual bubblewrap/KVM diagnostic. Logs do not prove successful VM execution.
