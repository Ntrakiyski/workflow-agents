# Agent instructions — Sandbox Provider

This service is **Phase 1 reusable infrastructure**, not a Pi- or document-specific app. Read `PHASE-1-REUSABLE-SERVICES.md`.

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
