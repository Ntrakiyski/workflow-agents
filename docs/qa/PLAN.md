# Independent Phase 1 QA plan

The reviewer owns this report and `tests/qa`; service authors own implementation. Frozen reference: `contracts/v1` and `docs/contracts/v1.md`. Original Phase 1 requirements are not relaxed by mocks.

## Evidence levels

1. Contract/schema unit validation: no running service or runtime.
2. Service unit/contract tests using mocked dependencies.
3. Service integration with real PostgreSQL and Graphile Worker where applicable, mocked Provider/runtime explicitly identified.
4. Cross-service HTTP with real independent databases and mocked runtime; proves transport and application state, not VM isolation/persistence.
5. Actual BoxLite execution with the exact deployment limits: required for runtime, filesystem persistence and two-VM isolation.
6. Process/container recovery and coordinated backup/restore on retained storage.
7. Safely authorized host restart: required before relying on retained persistent environments after host reboot. No shared production host reboot is permitted in this mission.

A passed test at a lower level never implies a higher level passed. Unexecuted tests are blocked/unverified, not successes.

## Reviews and tests

| Area | Independent checks |
| --- | --- |
| Versioned APIs | Validate schemas, actual captured responses, strict payload bounds, UTC dates and error envelopes; all frozen endpoints present. |
| Identity | Missing/invalid token; safe comparison; credentials absent from logs; delegation requires explicit credential policy/owner allowlist; ordinary callers cannot spoof owner; wrong owner is 404 including nested resources/events. |
| Profiles | Unknown/denied profiles rejected; immutable digest pins; argument schema rejects traversal/shell/image/mount overrides; argv execution without client shell expansion; new generic profile is configuration-only. |
| Durable Runner | Real migrations, Graphile atomic enqueue, delayed tasks not early, bounded transient retries, deadlines, cancellation, resume as new job, worker restart and stable uncertain external operations. |
| Idempotency | Same key/body same resource; changed payload conflict; owner/operation scope; unique execution_ref; crash around runtime/create/execute does not produce fresh untracked execution. |
| Concurrency | SQL-backed global/owner limits across processes; Provider one active run per sandbox; duplicate delivery and busy stop/start/destroy races. |
| Lifecycle | Stop preserves retained data; start reattaches same identity; destroy separately authorized/confirmed; missing disk fails without new empty sandbox; cancellation becomes terminal only after confirmed stop. |
| Runtime security | Actual SDK applies network, CPU, RAM, disk cap, mounts, process and output limits; unsupported settings fail closed; no privileged, host-socket or unrestricted mount requirement concealed. |
| Recovery | Provider and Runner restarts; stopped retained disk registry recovery; active uncertain run reconciliation; schedules and event ordering survive restart. |
| Audit/logs | State and audit atomic; actor and owner separate; timestamp/correlation/target/outcome; expected submission/dispatch/retry/cancel/finish/lifecycle/recovery records; credential/payload redaction. |
| Independence | Separate databases/credentials/migrations/storage; no cross-DB imports/queries, Runner never imports BoxLite, Provider never Graphile. |
| Operations | Independently buildable images; verified README/skills commands, configuration externalized; release RC/blocked honestly; backup and restore evidence and rollback plan. |

## Initial known blockers

The development host has no `/dev/kvm`. Coolify metadata reports ARM64 but actual host KVM/capacity is unverified and existing SSH access is unresolved. Real BoxLite and deployment qualification cannot pass from mock runtime tests.
