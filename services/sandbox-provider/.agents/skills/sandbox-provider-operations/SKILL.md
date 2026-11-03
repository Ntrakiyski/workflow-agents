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
