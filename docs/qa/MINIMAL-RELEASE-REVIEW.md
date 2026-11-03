# Independent minimal-release review — 3 November 2026

The reviewed candidate is suitable for continued isolated qualification. This review does **not** approve a stable deployment or change `ready_for_phase2` to true. The integration lead owns deployed-version verification and the final readiness record.

## Reviewed sources

- Provider scoped-transfer/completion implementation: `ff71f43`, integrated as `a2540e9`; cancellation follow-up: `a1ba19177b0d1a04a768eb31f79837d9200bcb61`.
- Final fragmented hosted transfer and eventual deletion follow-up: `909980b`.
- Application: `8bf1928`, followed by OfficeCLI OPC compatibility fix `27eb5f2`.
- Pi/OfficeCLI workload: `023fce7`.
- Logical off-host restore tooling and evidence present in the integration checkout: `1592711` and `docs/release/offhost-restore.json`.

These are reviewed source identities, not claims about the GCC deployment. The initial implementation review used a separate worktree and disposable PostgreSQL resources. The bounded follow-up below created only fresh session-owned Cloud fixtures; it did not alter retained staging databases, unrelated Cloud resources or live deployment configuration.

## Independently executed checks

| Check | Result | Scope and evidence |
| --- | --- | --- |
| Provider regression before cancellation follow-up | 69 passed; 1 deselected | New PostgreSQL 16 container, fake runtime/actual SDK loopback. `independent-provider-2026-11-03/provider-tests.txt` |
| Provider regression including cancellation follow-up | 72 passed; 1 deselected | A second new PostgreSQL 16 container, removed after execution. `independent-provider-2026-11-03/provider-cancellation-tests.txt` |
| Final Provider transport/deletion regression | 75 passed; 1 deselected | A third new PostgreSQL 16 container, removed after execution; exact source `909980b`. `independent-provider-2026-11-03/provider-final-tests.txt` |
| New Cloud hostname preflight tests | 2 passed; 14 unselected by `-k host_port` | A fourth new PostgreSQL 16 container, removed after execution; exact source `72c2738`, actual SDK loopback. `independent-provider-2026-11-03/provider-preflight-tests.txt` |
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

### P1 — killing only the execution leader did not establish descendant termination: resolved in source/tests and implementation-agent hosted evidence

The Cloud wrapper launches workload subprocesses; Pi launches in a separate session. The pinned SDK's leader-kill behavior did not establish termination of those descendants. Reporting terminal cancellation and releasing the active slot after that signal could permit continued side effects.

Commit `a1ba191` carries the exact retained Cloud runtime reference into the execution handle, makes same-box confirmed stop authoritative after best-effort leader kill, and records the sandbox stopped before publishing terminal cancellation/timeout. Stop failure retains active ownership for recovery. Source review confirms stop polls the same server identity until a nonrunning state; the independent regression runs include the new cancellation checks. The Provider implementation agent's `docs/release/cloud-cancellation-descendant.json` demonstrates the ready marker before cancellation, terminal cancellation/stopped registry, same-box restart plus ten seconds, no delayed descendant marker, and empty cleanup remainder. Independent QA inspected that record; it did not personally drive that hosted execution. Final deployed evidence remains separate.

## Source review observations

- Provider transfers are scoped beneath `/opt/workflow-transfer`; no-follow descriptor-relative access, size/checksum bounds, immutable publication and a durable file-operation fence prevent path escape and blind replay of uncertain writes.
- Cloud completion requires a nonce/checksum envelope. Empty stdout plus native exit zero does not establish success. Unrecoverable active attach remains explicitly ambiguous.
- Runtime secret references are resolved at dispatch; reviewed profiles and durable snapshots retain references. Output/journal redaction is separate from application authorization.
- The application authenticates server-side, requires the configured Origin for mutations, scopes requests/files to owners, keeps outputs inaccessible until completion, and preserves checkpoint files outside the public file API.
- Request identity, output checksums and required session checkpoints are checked before completion. Objects use conditional immutable writes. Sandbox stop is reconciled after successful export; stop failures preserve completed results for retry.
- The visible product remains instructions/attachments, paginated persistent requests, and a result/error/download view. No extra dashboard/chat/approval/editor flow was found.

## Integration evidence and remaining limits

The lead's `docs/release/cloud-failure-journey.json` records actual BoxLite Cloud with isolated real PostgreSQL and real local service processes: duplicate delivery, transient failure before effect, lost acknowledgement after effect, Runner process SIGKILL, Provider process SIGKILL and cancellation race. The reviewed six-case record has one admitted execution and one durable effect in every case; Provider crash is truthfully failed rather than blindly replayed. This is lead-executed evidence and does not prove the GCC deployment is running the reviewed commits. The corrected cancellation implementation has the separate delayed-descendant proof described above.

The lead's `docs/release/offhost-restore.json` records two isolated logical database restores, matching table digests/audit identities and idempotent replay. Its source is deployed commit `04b7dc4`; all retained runtime entries are destroyed tombstones or have no runtime. It explicitly does not exercise guest restoration or application object restoration. A self-hosted object service on the GCC host is application storage, not by itself an off-host backup.

This review has not independently executed or approved the complete deployed browser → Runner → Provider → Cloud → Pi/LiteLLM/OfficeCLI → validated download journey, application process/container replacement with persisted results, coordinated application/object/checkpoint restore, broad load/resource/network/escape qualification, host reboot or vendor-host recovery. The integration lead must record exact remaining gates and actual deployed commits. Stable Phase 2 readiness remains false while mandatory gates lack demonstrated evidence.

## Independent bounded Cloud resource follow-up

`docs/release/cloud-resource-journey.json` records actual SDK0.11.0/Provider runtime-adapter probes on new session-owned Cloud fixtures with the approved immutable Python image, 1 CPU, 1 GiB RAM, 1 GiB disk and inbound/outbound disabled. This uses the adapter directly, not the Provider HTTP API or a database. All three fixture attempts were confirmed stopped and removed by exact recorded name/server ID; private allocation/execution journals were written before dispatch. The first two attempts exposed harness assumptions, and their evidence remains alongside the final composite record.

- Two concurrent CPU workers ran for two seconds: 1.999 CPU-seconds over 2.072 wall-seconds, with one advertised guest CPU.
- The 1,039,155,200-byte root filesystem returned ENOSPC after 886,632,448 bytes of bounded writes; the fill file was removed and the observed available space restored exactly.
- Memory pressure touched 973,078,528 bytes and reached 990,605,312-byte child RSS before SIGKILL. The guest reported 1,070,071,808-byte MemTotal and no swap. No guest RLIMIT or test-directed kill applied. The missing kernel `oom_kill` counter prevents direct attribution of the signal; the result is consistent with guest OOM and is reported as bounded termination evidence.
- The external dummy interface was down, the IPv4 route table empty, and TCP connections to both fixed public IPv4 endpoints returned ENETUNREACH. This qualifies those probes for the network-denied profile; it does not qualify the Pi allowed-host policy or universal network isolation.

These bounded results improve resource evidence but do not close sustained load, broad isolation/escape, host restart or vendor-host recovery gates.

## Final Provider transport review

Source `909980b` fragments a public 1 MiB transfer into bounded hosted transport operations without changing the public contract or durable operation fence. Internal upload fragments retain exact offset/checksum replay. Internal reads reuse the first full-file checksum while device, inode, size, mtime and ctime match, then rehash at the public-read boundary or EOF; the internal stamp is stripped from the public response. Explicit destroy polls the same retained identity for eventual absence and retains a retryable pending result if confirmation times out. Source review found no actionable defect in those changes, and an independent fresh-database regression passed all 75 tests.

The implementation agent's final `docs/release/cloud-transfer-journey.json` records seven actual hosted passes against exact source `909980bdc0851d2bea6f454ae8fddc43b48b4e4f`: three-chunk upload/download/checksum/replay, cross-owner/path denials, stop/start plus Provider process replacement, symlink rejection, file checkpoint export/reupload into a distinct sandbox, delayed-descendant cancellation absence after restart, and isolated forensic registry restore. Cleanup is empty; all seven restored table fingerprints and 37 audit rows/identities are retained. Independent QA inspected the record and independently matched all twelve Provider source-file hashes plus the harness hash to current files. This is implementation-agent execution evidence on isolated local services with actual Cloud guests; it is not GCC deployment proof, a VM clone or a live registry-to-guest rebinding restore.

## First deployed browser attempt and truthful failure behavior

Independent QA verified the actual HTTPS certificate, expected anonymous 401/Basic realm and application health identity at `https://workflow-agents.68.210.88.115.sslip.io`. The app deployment supplied by the lead is `2f7820f619fe023b4278c2f97e43f7709d59d8cd`; Provider files in that commit and the lead's infrastructure deployment `4bab06c` independently match the final hosted source hashes.

One fresh pinned-OfficeCLI synthetic DOCX was submitted through Chromium. Attachment admission, confirmation, same-key replay retaining the request ID, changed-body 409 and persistent list/reload/reopen all passed. Request `e4ce9738-c52d-4bb7-a862-93d18a2c2962` then became failed. The lead identified a native Cloud profile rejection before Runner dispatch; that server-side diagnosis is separate from this reviewer's observed API/UI evidence. The failed request was retained, not cleared or manually replayed; no further request was submitted by QA.

Read-only follow-up confirmed the failed row remains listed, final text is absent, the protected original download matches all 5,205 uploaded bytes/SHA256, anonymous request/input access returns 401, an authenticated foreign account receives 404 for both resources, and a cross-origin mutation is rejected with 403 before admission. The actual failed UI clearly shows Failed, the request identifier, concise contact-support guidance and the original attachment; no infrastructure detail leaks. Source review confirms request/file queries remain owner-scoped, failed requests cannot expose result files/text, and permanent dependency errors append a durable failed audit record without clearing identities.

Evidence: `docs/release/hosted-application-attempt-1.json` and `docs/release/hosted-application-failure-review.json`. A complete browser-to-Pi success, output authorization and post-replacement result persistence remain unproved by this failed attempt. QA is waiting for the corrected runtime/profile deployment before any separately authorized fresh synthetic submission.

## Cloud hostname-policy correction review

Commit `72c2738` rejects unsupported `hostname:port`/scheme rules during the existing Cloud create preflight, before the registry transaction. It does not silently remove requested restrictions. Independent execution of both new tests passed against an isolated PostgreSQL 16 database and the actual pinned SDK loopback: rejected rules caused no SDK HTTP request and no sandbox/idempotency/audit insertion; an exact hostname passed preflight. Existing historical read paths remain available.

The implementation agent's `docs/release/cloud-hostname-network.json` records actual cached-image Cloud guests with 2 CPUs, 2 GiB RAM, inbound disabled and exact-hostname outbound metadata. The permitted LiteLLM HTTPS endpoint responded 401 without model credentials; `example.com` and direct-IP HTTPS terminated TLS before any HTTP response. Raw TCP connections were accepted, which the evidence correctly preserves rather than claiming blanket packet denial. Exact session-owned fixtures were confirmed absent after cleanup.

Independent QA inspected that bounded evidence; the author executed its Cloud calls. Hostname rules provide no destination-port controls, and these checks do not qualify complete TCP filtering, UDP/DNS restrictions, rebinding or comprehensive isolation. The separate pinned full-image pull failed on registry-token transport and was cleaned up; no guest execution or network success is inferred from that failure. No runtime fallback, unpinned alias or broad egress opening was used in the reviewed correction.

## rc2 workload/profile integrity review

Independent read-only review of the integration checkout's v2 profile confirmed the exact current bootstrap, rc2 runtime checksum, cached immutable image, v2 sandbox binding, 2 CPU/2 GiB RAM/2 GiB disk settings, HTTPS endpoint selecting 443, exact hostname network rule and runtime-only model secret reference. The earlier failed v1 profile remains historical. The actual archive is 95,977,914 bytes with SHA256 `08a6dda2a800958428a2089639c721b19bf866d83e55976c8cf2ef167772094a`; its 15,371 members are regular files and total expanded size matches 313,357,336 bytes. All three bundled ICU SONAME library sizes/checksums independently match the pinned lock. This review did not execute another model call or claim Cloud/browser success. Evidence is `independent-provider-2026-11-03/workload-rc2-independent-review.json`.

## P2 — request pagination loses submillisecond timestamps: resolved in source

An independent isolated PostgreSQL 16/API-injection reproduction inserted three authorized requests at `2026-11-03T18:00:00.123900Z`, `.123800Z` and `.123700Z`. `GET /api/requests?limit=1` returned the newest row but encoded the next cursor as `.123Z`. The second page was empty although two authorized rows remained. PostgreSQL retains microseconds while the driver's JavaScript `Date` and `requestRow` conversion retain only milliseconds; comparing the full-precision SQL tuple against that rounded cursor silently skips rows. This violates the explicit requirement to list every authorized request through pagination.

The lead was notified to preserve the database's full timestamp precision in the opaque cursor and add a same-millisecond boundary regression. No live request, database or deployment was changed by this reproduction. The dedicated loopback PostgreSQL container used a fresh database named `workflow_app_test` and was removed in `finally`. Evidence: `independent-provider-2026-11-03/application-pagination-reproduction.json`.

The lead corrected cursor construction by selecting the full PostgreSQL UTC timestamp as text and preserving that value separately from the public millisecond date. Independent source review found no further actionable issue. A second fresh disposable PostgreSQL16 run returned all four authorized same-millisecond fixtures exactly once in full timestamp/UUID order across four one-row pages, including an equal-timestamp tie, excluded an interleaved foreign-owner row, and ended with a null cursor. The exact reviewed API SHA256 and complete page observations are in `independent-provider-2026-11-03/application-pagination-correction.json`. Both fixture containers were removed. Deployment and post-replacement browser evidence remain the lead's separate gate.

## Second deployed browser attempt and retained failure

After the lead deployed all three services at `8387b5da2084e062e7409b1af5ce81ae57b45dfd`, independent QA submitted one separately authorized fresh synthetic DOCX request: `598c30fa-e0d0-4d36-96d7-16d75bd675e7`. Browser attachment admission/confirmation, same-key replay retaining identity, changed-body conflict, and persistent list/reload/reopen all passed. The same request moved from pending to running after its bounded runtime upload, then failed before result delivery. The browser helper exited with `hosted_request_failed`, no console/page errors, and preserved its original state and request identity. No blind replay or replacement submission occurred.

Read-only follow-up confirmed the failed row remains listed, no final text or output file is exposed, and the original download matches all 5,205 submitted bytes/SHA256. Anonymous request/input reads returned 401; an authenticated foreign owner received 404. Independent screenshot inspection found the expected Failed status, generic contact-support guidance, request identifier and original attachment, with no infrastructure details. These checks do not prove successful Pi editing, validated output delivery, result authorization or post-replacement persistence; the lead is diagnosing the same retained execution separately.

Evidence: `docs/release/hosted-application-attempt-2.json` and `docs/release/hosted-application-second-failure-review.json`. The private saved state remains `private/hosted-browser-8e076d67-54f3-492e-9987-cb828d291f8f/state.json`; it contains the known request/attachment identity and no completed output identity. Stable readiness remains false.

## Retained completed-export recovery source review

The lead's exact-manifest diagnostic identified one strict application-schema mismatch: the canonical workload session descriptor includes `media_type`, while the old application descriptor rejected that key. The corrected application requires the exact `application/x-ndjson` literal used by the workload. This does not relax artifact or DOCX validation.

Independent read-only review of the one-request operator recovery script at `1d21e27`, corrected by `dc35cee`, found fixed request/job/sandbox/manifest-checksum guards, same completed job with exit zero, stopped-box owner reference, bounded checksum-validated original/session/output reads, actual controller DOCX validation, the existing worker advisory lock, a conditional export-only state transition and an appended recovery audit. The script calls no submit or execute endpoint and preserves all workload identities and failed audit history. Review findings about ambiguous start acknowledgement and cleanup order were corrected: the same-box stop is attempted when start acknowledgement is lost, and nested `finally` blocks still attempt unlock, database close and object-client close if that stop fails. Stale failure metadata is cleared during the explicit transition.

No further actionable source finding remains in this fixed one-request recovery path. This is source review, not execution approval evidence, successful result delivery or proof against process/host crashes. The operator must separately demonstrate same-job export, browser validation and sandbox stop. Exact script checksum and bounded review observations are in `independent-provider-2026-11-03/export-recovery-source-review.json`.

## Recovered same-job browser result validation

Following the lead's explicit export-only recovery and application deployment `1d21e27a571388484774e401cc5d5a5a3cec0973`, independent QA resumed only the saved second request `598c30fa-e0d0-4d36-96d7-16d75bd675e7`; no new submission occurred. Its completed output `b723f16e-fe46-42a2-b615-047982a4b6f6` downloaded through the real browser and matched all 5,282 bytes/SHA256 `e5d9c571cd9743000170961c436f6580f0e4d3afa4a9e9e00739d2e734faa81e`. Independent ZIP CRC/XML/relationship checks passed for 11 XML parts. The document contains exactly two paragraphs: the original fixture text remains, and the exact requested synthetic marker occurs once. This proves that synthetic edit and structure, not general semantic accuracy or rendered document layout.

The completed request remains in the persistent list, exposes final text and its protected result link, and preserves the exact original input bytes. Anonymous request/input/output reads return 401; an authenticated foreign owner receives 404 for each and cannot see the row in its list. An invalid Origin receives 403 before admission. Independent inspection of actual 1366px desktop and 390px mobile result screenshots found readable status/text/downloads/validation limits without horizontal overflow or browser console/page errors.

Evidence is `docs/release/hosted-application-recovered-journey.json`. The helper state now retains the exact delivered output identity/checksum for a subsequent application-replacement comparison. This result required explicit operator recovery; the failed attempt remains historical, and an uninterrupted automatic browser-to-result flow and post-replacement persistence are still separate open checks.

## Recovered-result persistence after application replacement

The lead replaced the application container at the same exact source `1d21e27a571388484774e401cc5d5a5a3cec0973` (reported deployment `y0mgz7i3yndf7o1cmvutoopf`). Independent QA then reopened only the saved second request and compared its existing delivered output identity and downloaded bytes. Request `598c30fa-e0d0-4d36-96d7-16d75bd675e7`, output `b723f16e-fe46-42a2-b615-047982a4b6f6`, all 5,282 bytes and SHA256 `e5d9c571cd9743000170961c436f6580f0e4d3afa4a9e9e00739d2e734faa81e` remained identical. The persistent list, exact marker/original text, DOCX CRC/XML/relationships, original input integrity, request/input/output authorization, Origin rejection and desktop/mobile browser-health checks passed again. Actual replacement screenshots remain readable.

Evidence: `docs/release/hosted-application-replacement.json`. This demonstrates application replacement persistence for the explicitly recovered result; it does not retroactively convert the failed automatic attempt into an uninterrupted successful flow. The lead separately authorized one fresh third browser request for that remaining automatic-flow check; its identity is preserved while it runs, and no operator recovery is planned.
