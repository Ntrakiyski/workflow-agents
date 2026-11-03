# Preflight evidence

> **Current Cloud validation, 2026-11-03:** The active GCC deployment explicitly uses BoxLite Cloud; real HTTP execution and stopped-box recovery passed without KVM or host-policy changes. The Worfklow/local preflight below remains historical. Read [CLOUD-VALIDATION.md](CLOUD-VALIDATION.md) and [readiness.json](readiness.json).

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

## Actual Coolify host runtime probe

The first Provider deployment `gpldydq3pasenqyhkbdlhwfu`, immutable source `99203a5005450be1ef6b84653ee3fca13407d41c`, successfully built on ARM64. It then attempted only the narrow `/dev/kvm` device mapping under non-privileged restrictions. Docker refused startup with:

```text
error gathering device information while adding custom device "/dev/kvm": no such file or directory
```

This confirms the actual execution host lacks the required device. The device mapping is removed for API-only staging deployment, which retains the real BoxLite adapter and returns unavailable runtime readiness. No host configuration, existing resource, virtualization setting or runtime technology was changed. Actual VM execution, VM disk retention, isolation, process reattachment and host-restart recovery remain blocked.

The first Runner deployment `db1h7hqhw2gaszg8y3mt6yjz` built and started its API/queue but Coolify's generated health check failed because its command requires curl or wget. The image's native Node health check alone did not satisfy Coolify. Both service Dockerfiles are being corrected to include curl; the failure is recorded and affected container deployment checks must be rerun.

## Completed staging follow-up

The curl packaging fix was rebuilt, probed and successfully deployed for both services. Latest independent container replacements at source `df7cc68` finished: Provider `vvvwvav3pd3bs6amd7quwsl0`, Runner `zvzmx90vgdxvcz6nvc9at0hk`. Actual ARM64 container diagnostics observed eight logical CPUs, BoxLite 0.11.0, UID 10001, about 73.4 GB available in the named volume, host memory 16,333,647,872 bytes total and about 9.78 GB available at the sample. Application-volume marker, registry, jobs and audit retention checks passed across replacement. These observations resolve application packaging/storage checks, not the missing host KVM, real VM filesystem persistence, isolation or reattachment gates. See [final report](FINAL-REPORT.md) and [retention evidence](DEPLOYED-RETENTION-EVIDENCE.json).
