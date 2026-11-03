# Independent minimal-release review — 3 November 2026

The reviewed candidate is suitable for continued isolated qualification. This review does **not** approve a stable deployment or change `ready_for_phase2` to true. The integration lead owns deployed-version verification and the final readiness record.

## Reviewed sources

- Provider scoped-transfer/completion implementation: `ff71f43`, integrated as `a2540e9`; cancellation follow-up: `a1ba19177b0d1a04a768eb31f79837d9200bcb61`.
- Application: `8bf1928`, followed by OfficeCLI OPC compatibility fix `27eb5f2`.
- Pi/OfficeCLI workload: `023fce7`.
- Logical off-host restore tooling and evidence present in the integration checkout: `1592711` and `docs/release/offhost-restore.json`.

These are reviewed source identities, not claims about the GCC deployment. The initial implementation review used a separate worktree and disposable PostgreSQL resources. The bounded follow-up below created only fresh session-owned Cloud fixtures; it did not alter retained staging databases, unrelated Cloud resources or live deployment configuration.

## Independently executed checks

| Check | Result | Scope and evidence |
| --- | --- | --- |
| Provider regression before cancellation follow-up | 69 passed; 1 deselected | New PostgreSQL 16 container, fake runtime/actual SDK loopback. `independent-provider-2026-11-03/provider-tests.txt` |
| Provider regression including cancellation follow-up | 72 passed; 1 deselected | A second new PostgreSQL 16 container, removed after execution. `independent-provider-2026-11-03/provider-cancellation-tests.txt` |
| Versioned contracts | 6 passed; regeneration clean | `contracts/tests/test_contracts.py`, then generator and clean `contracts/v1` diff. `independent-provider-2026-11-03/contract-tests.txt` |
| Controller DOCX adversarial checks | 11 of 11 passed | One valid package accepted; ten malformed/unsafe packages rejected. `independent-provider-2026-11-03/docx-validation.json`; repeatable script alongside it |
| Real OfficeCLI compatibility | Passed after correction | Actual pinned OfficeCLI 1.0.160 created a fresh synthetic document, saved a paragraph, and returned schema success with zero errors; application controller independently accepted its bytes. `independent-provider-2026-11-03/officecli-compatibility.json` |
| Workload tests | 2 Node and 10 Python tests passed | Actual argument/archive/path/checksum/fence behavior; synthetic model events. `independent-provider-2026-11-03/workload-tests.txt` |

The Provider deselection is the separately marked real-runtime test. These test results do not qualify BoxLite Cloud, a model call, guest recovery, deployment replacement or host persistence. The OfficeCLI check did not render pages or assess semantic accuracy.

The application implementer separately reports 10 backend passes against actual PostgreSQL/RustFS, typecheck/build/format success, and two desktop/mobile browser passes with execution mocked. Those are implementation evidence, not this reviewer's independent full-suite execution. Independent visual inspection of the supplied 1366×900 and 390×844 result screenshots found readable status, result/downloads and validation limits without clipping or additional product screens.

## Findings and resolutions

### P2 — controller accepted malformed DOCX packages: resolved

Independent reproduction initially accepted duplicate `word/document.xml` entries, an unrelated Word namespace/body, and an external `file:///private.txt` relationship. The controller therefore provided less assurance than its delivery summary implied.

The application now rejects duplicate entries and special-file modes, bounds archive/entry sizes, streams every entry to check CRC, parses all XML/relationship parts with entities/DTD forbidden, validates the Word namespace/body, resolves internal relationship targets, and rejects external/unsafe targets. The final independent run accepted its positive fixture and rejected duplicate parts, wrong namespace, external file relationship, encoded absolute target, traversal, malformed unused XML, DTD/entity, missing relationship target, symlink, and corrupted unused binary bytes.

### P1 — hardening rejected actual OfficeCLI output: resolved

A fresh document from the exact pinned OfficeCLI binary was schema-valid but rejected by the hardened controller. OfficeCLI legitimately uses package-root relationship targets such as `/word/document.xml` and declares the main XML content type through a `Default` entry. Requiring only relative targets and a dedicated `Override` would break ordinary document submission and delivery.

Commit `27eb5f2` accepts one-leading-slash internal package references while retaining authority/URI/traversal restrictions, and calculates the effective main content type from `Override` precedence or a matching `Default`. Duplicate content-type declarations fail. Independent repeat checks accepted the actual 5,202-byte OfficeCLI document and kept all adversarial checks passing. The final validator SHA256 is recorded in both JSON evidence files.

### P1 — killing only the execution leader did not establish descendant termination: source/test correction verified; hosted proof separately required

The Cloud wrapper launches workload subprocesses; Pi launches in a separate session. The pinned SDK's leader-kill behavior did not establish termination of those descendants. Reporting terminal cancellation and releasing the active slot after that signal could permit continued side effects.

Commit `a1ba191` carries the exact retained Cloud runtime reference into the execution handle, makes same-box confirmed stop authoritative after best-effort leader kill, and records the sandbox stopped before publishing terminal cancellation/timeout. Stop failure retains active ownership for recovery. Source review confirms stop polls the same server identity until a nonrunning state; the independent 72-test run includes the new cancellation checks. A hosted delayed-descendant sentinel test after stop/start is being performed by the Provider implementation agent; final hosted evidence must be recorded before treating this runtime-specific concern as fully qualified.

## Source review observations

- Provider transfers are scoped beneath `/opt/workflow-transfer`; no-follow descriptor-relative access, size/checksum bounds, immutable publication and a durable file-operation fence prevent path escape and blind replay of uncertain writes.
- Cloud completion requires a nonce/checksum envelope. Empty stdout plus native exit zero does not establish success. Unrecoverable active attach remains explicitly ambiguous.
- Runtime secret references are resolved at dispatch; reviewed profiles and durable snapshots retain references. Output/journal redaction is separate from application authorization.
- The application authenticates server-side, requires the configured Origin for mutations, scopes requests/files to owners, keeps outputs inaccessible until completion, and preserves checkpoint files outside the public file API.
- Request identity, output checksums and required session checkpoints are checked before completion. Objects use conditional immutable writes. Sandbox stop is reconciled after successful export; stop failures preserve completed results for retry.
- The visible product remains instructions/attachments, paginated persistent requests, and a result/error/download view. No extra dashboard/chat/approval/editor flow was found.

## Integration evidence and remaining limits

The lead's `docs/release/cloud-failure-journey.json` records actual BoxLite Cloud with isolated real PostgreSQL and real local service processes: duplicate delivery, transient failure before effect, lost acknowledgement after effect, Runner process SIGKILL, Provider process SIGKILL and cancellation race. The reviewed six-case record has one admitted execution and one durable effect in every case; Provider crash is truthfully failed rather than blindly replayed. This is lead-executed evidence and does not prove the GCC deployment is running the reviewed commits. Cancellation must also be rerun against its corrected implementation with the delayed descendant sentinel.

The lead's `docs/release/offhost-restore.json` records two isolated logical database restores, matching table digests/audit identities and idempotent replay. Its source is deployed commit `04b7dc4`; all retained runtime entries are destroyed tombstones or have no runtime. It explicitly does not exercise guest restoration or application object restoration. A self-hosted object service on the GCC host is application storage, not by itself an off-host backup.

This review has not independently executed or approved the complete deployed browser → Runner → Provider → Cloud → Pi/LiteLLM/OfficeCLI → validated download journey, application process/container replacement with persisted results, coordinated application/object/checkpoint restore, broad load/resource/network/escape qualification, host reboot or vendor-host recovery. The integration lead must record exact remaining gates and actual deployed commits. Stable Phase 2 readiness remains false while mandatory gates lack demonstrated evidence.

## Independent bounded Cloud resource follow-up

`docs/release/cloud-resource-journey.json` records actual SDK0.11.0/Provider runtime-adapter probes on new session-owned Cloud fixtures with the approved immutable Python image, 1 CPU, 1 GiB RAM, 1 GiB disk and inbound/outbound disabled. This uses the adapter directly, not the Provider HTTP API or a database. All three fixture attempts were confirmed stopped and removed by exact recorded name/server ID; private allocation/execution journals were written before dispatch. The first two attempts exposed harness assumptions, and their evidence remains alongside the final composite record.

- Two concurrent CPU workers ran for two seconds: 1.999 CPU-seconds over 2.072 wall-seconds, with one advertised guest CPU.
- The 1,039,155,200-byte root filesystem returned ENOSPC after 886,632,448 bytes of bounded writes; the fill file was removed and the observed available space restored exactly.
- Memory pressure touched 973,078,528 bytes and reached 990,605,312-byte child RSS before SIGKILL. The guest reported 1,070,071,808-byte MemTotal and no swap. No guest RLIMIT or test-directed kill applied. The missing kernel `oom_kill` counter prevents direct attribution of the signal; the result is consistent with guest OOM and is reported as bounded termination evidence.
- The external dummy interface was down, the IPv4 route table empty, and TCP connections to both fixed public IPv4 endpoints returned ENETUNREACH. This qualifies those probes for the network-denied profile; it does not qualify the Pi allowed-host policy or universal network isolation.

These bounded results improve resource evidence but do not close sustained load, broad isolation/escape, host restart or vendor-host recovery gates.
