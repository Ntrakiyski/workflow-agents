---
name: pi-document-development
description: Build, qualify and recover the pinned Pi OfficeCLI document workload without coupling it to reusable infrastructure.
---

1. Read package `AGENTS.md`, README and verification evidence. Confirm the currently authorized minimal UI scope.
2. Verify supplied source assets exist; review them before reuse. Preserve originals and record source checksums. Missing helpers remain missing until independently implemented and tested.
3. Keep runtime dependencies pinned to immutable checksums plus npm integrity lock. Build with `python3 build_runtime.py`; retain the generated bundle metadata and SHA256 outside Git's binary history.
4. Run `npm test` for archive/path/checksum/OOXML/tool boundary negatives. Extract the bundle using `bootstrap.install` and run `python3 tests/runtime-smoke.py --runtime <path>` for actual Node, Pi, OfficeCLI and durable file readback.
5. Render a nonsecret profile using `render_profile.py`. Supply only an approved OCI digest, exact LiteLLM endpoint/model and the generated archive metadata. Bind the Provider secret reference to a runtime-only key. Do not write a literal key into profile JSON.
6. Confirm the effective network policy has inbound disabled and the exact approved outbound host/port. Run real permitted/denied traffic probes separately; metadata is not complete isolation proof.
7. Stage runtime and request files only through the versioned scoped transfer API. Submit the approved workload through Runner using a stable request UUID and owner-scoped idempotency. Never replay a fenced uncertain execution under a new reference.
8. Verify the stdout manifest pointer against the transferred result bytes. Independently validate checksums, OOXML package boundaries and final request identity in the controller. Treat rendered layout/content accuracy as unverified unless independently tested.
9. Export all required artifacts and session JSONL files into application-owned object storage, record durable audit evidence, then stop the same environment through the authenticated API. Stop is not destroy.
10. Record actual service commits, runtime SHA, test scope and remaining blockers. Full application readiness requires separate infrastructure acceptance and a real browser-to-Cloud-to-result journey.
