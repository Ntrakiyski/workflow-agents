# Phase 1 implementation decisions

Primary requirements: `PHASE-1-REUSABLE-SERVICES.md`. Original architecture documents remain unchanged.

## Boundaries

- Runner: Node.js/TypeScript, Graphile Worker, its own PostgreSQL database.
- Provider: Python/FastAPI, its own PostgreSQL database, BoxLite behind an adapter.
- No Phase 2 code or workload integration is included.
- Each service owns its source, migrations, dependencies, Dockerfile, and skills. Contract changes require lead review before integration.

## API baseline

The initial versioned contracts are reviewed before service implementation. Authentication uses opaque bearer credentials mapped to principals and allowlisted profiles in external configuration. Only an explicitly trusted delegating Runner credential may supply `X-Owner-ID` to Provider; audit records retain authenticated service and delegated owner. No caller-supplied business reference is an authorization identity.

Idempotency keys are scoped to owner and operation, with a canonical request fingerprint. A changed request using the same key returns conflict. Retries after ambiguous HTTP results reuse the same operation key and reconcile Provider state; they do not promise exactly-once physical effects.

Approved profiles define validated JSON arguments and fixed command/argument templates in operator configuration. Clients cannot submit shell programs or choose arbitrary images. OCI images must use immutable digests. Generic fixture profiles exercise filesystem behavior; document tools and agents remain Phase 2 work.

Unsupported artifact transfers fail explicitly; opaque references must not imply that transfer occurred. Inline output is bounded and logs omit payloads and credentials.

## Deployment qualification

Create only one new Coolify project, `workflow-agents-phase1`, with `staging`, two independent applications, and two independent PostgreSQL resources/credentials/volumes. Existing resources are read-only for this mission. Git Dockerfiles are authoritative; deployment resource settings and exact resource IDs/commits are recorded separately.

No new host, host reboot, virtualization changes, privileged containers, Docker socket mount, or unrestricted host mount is authorized. A narrow `/dev/kvm` device mapping is a BoxLite prerequisite only if the host supports it. A missing runtime yields failed readiness and explicit errors; it never silently switches to a mock.

Host-reboot persistence is unverified until explicitly authorized and safely tested. A persistent volume is not a backup; registry and stopped BoxLite data require a coordinated recoverable backup and restore drill.

## Validation terminology

Reports separate executed real-PostgreSQL and HTTP tests, mocked runtime tests, real BoxLite tests, skipped cases, and blocked gates. Unavailable KVM or unsupported SDK/container security requirements prevent Phase 1 release even if API tests pass.

## Authorized GCC migration, 2026-11-03

The user's instruction to move Phase 1 to GCC and delete it from Worfklow superseded the earlier deployment pause. Scope remained exactly our Phase 1 resources: one GCC project with separate apps/databases; no unrelated resource, host virtualization/security setting or shared network was changed. Historical database/audit state was restored and compared before source removal. New service/database credentials replaced source credentials. No working source VM existed to migrate; the source filesystem volume was not copied and that limitation is recorded.

GCC exposes KVM, but the actual non-root restricted BoxLite create fails during bubblewrap user-namespace preflight. Preserve the agreed SDK/runtime and security model. Do not equate KVM/SDK readiness200 with a working VM, silently disable the jailer, or alter host-wide AppArmor/sysctl policy. A reviewed Provider-specific security policy and namespace-aware readiness remain required follow-up work; migration can be complete while Phase 1 consumption remains blocked.
