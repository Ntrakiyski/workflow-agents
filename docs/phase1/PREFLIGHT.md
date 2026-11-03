# Preflight evidence

Observed 2026-11-03. No existing Coolify resource was changed.

## Workspace and source

- New clone: `/home/workflow-agents`, repository `Ntrakiyski/workflow-agents`, starting commit `3cde455`.
- GitHub authentication works as repository owner; public repository; default branch `main`.
- Integration branch: `phase1/integration`; specialized agents use sibling worktrees under `/home/workflow-agents-worktrees`.
- Development host: Linux x86_64, Python 3.12.3, Node 22.22.3, Docker 29.5.3, 2 CPUs, 3.7 GiB RAM. `/dev/kvm` absent and CPU flags expose neither vmx nor svm. Real local BoxLite microVM tests are blocked.
- Two disposable, loopback-only PostgreSQL 16 test containers have distinct credentials and independent ephemeral storage. These are local test resources, not Coolify deployment databases.

## Coolify discovery

- Connector: `worfklow_coolify`, dashboard `worfklow.org`.
- Selected server: `qk48swgog4kok0og8848wwg8` (`localhost`, Coolify host).
- Selected Docker destination: `a48owkoog444c84oo844wgow` (network `coolify`).
- Server metadata reports Ubuntu 24.04, aarch64, 8 CPUs, 16,333,647,872 bytes RAM; metadata collection date 2026-10-27. This is inventory, not current available capacity.
- Both service resources must have no public database ports; Provider has no public domain/port. Use stable custom network aliases for application traffic; application UUID alone is not a DNS hostname.
- BoxLite 0.11.0 publishes CPython 3.12 manylinux 2.28 wheels for both aarch64 and x86_64. Wheel availability does not prove KVM or container execution works.
- Read-only SSH checks to the resolved execution host were denied for the available root SSH key. Host KVM, writable persistent disk capacity, and current available CPU/RAM remain **unverified**. An existing SSH access method was requested while implementation proceeds.
- Coolify supports narrow `--device` custom Docker options. No privileged container, unrestricted host mount, Docker socket mount, host reboot or virtualization setting change is permitted by this mission.

## Required follow-up

Run `deploy/host-preflight.sh` on the actual Coolify execution host, then use the exact deployed Provider container configuration for the real BoxLite persistence/isolation test. If host access remains unavailable, staging API/database deployment may proceed with failed runtime readiness, and real microVM acceptance must remain blocked. Never interpret absence of KVM inside a container without a device mapping as proof that the host lacks KVM.
