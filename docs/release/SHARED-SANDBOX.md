# Per-user prepared workspaces

This candidate implements the owner's 4 November request for one prepared sandbox per authenticated user, independent Pi sessions for concurrent requests, and an editable default system prompt. It builds on the previous minimal application release. Existing request identities and delivered files are retained.

## Request lifecycle

1. Successful application login queues durable workspace preparation in the background. The current application uses configured Basic-auth accounts; it has no registration screen. New account integrations can call the same idempotent workspace admission function.
2. The application creates one retained sandbox for the authenticated owner, uploads the pinned runtime once, then submits the approved preparation workload. The screen reports upload progress and installation/checking. Requests can be submitted while this runs and wait for readiness.
3. Each request receives its own UUID directory under `/opt/workflow-transfer/requests/`. Inputs, working copies, outputs, session history, agent configuration, caches and temporary files remain under that directory. Shared installed tools are prepared before any request runs.
4. Each request starts an independent Pi session with that request UUID. The initial candidate admits two simultaneous executions in the same user sandbox; additional requests queue. The sessions have separate conversation histories. The model endpoint's independent concurrency limits also apply.
5. The controller checks the result manifest, file sizes/checksums, saved session and DOCX structure, exports required resources into application-owned storage, then marks the result available. These checks do not prove semantic accuracy or rendered page layout.
6. Once all requests and exports finish, an idle guard stops the same sandbox while retaining its disk. Login/new admission serialize with this guard. Later requests restart the retained sandbox and reuse the installed tools.

First preparation still transfers about 96 MB and can take around 18–19 minutes on the observed Cloud transfer path. Preparing in the background and reusing tools removes that transfer from later requests; it does not make the first upload instantaneous.

## Prompt and tools

A button beside Instructions opens a textarea with the default system prompt. Changes save for that user and are snapshotted when a request is submitted; editing the default does not change an existing request. The request detail can show the exact saved value. Following the owner’s latest instruction, the saved default policy and request instructions form one text prompt sent to Pi. Attachment text remains separately labeled untrusted reference data. The UI keeps the saved default behind the System prompt button.

The default tells Pi to complete the request, preserve originals, keep request resources in its assigned folder, use available tools and report checks and limitations honestly. The workload appends the actual UUID path. Prompt guidance is not an OS filesystem boundary. The existing constrained OfficeCLI tool still binds document operations to the assigned working copy, and controller export validation remains required. Arbitrary shell execution, package installation and arbitrary file-type creation are not added by this change.

## Infrastructure and recovery

The generic [rc.3 extension](../contracts/shared-execution-v1.md) keeps capacity one for old profiles. Shared execution uses a new immutable Cloud profile with capacity two, durable admission in both services, separate run identities and supervised descendant cancellation. Cancelling one run must not stop sibling runs or the VM. Unknown outcomes keep their identity and are reconciled without a fresh model execution.

The application schema adds workspace and user-setting tables. Matching-source backup/restore covers seven tables and immutable application objects; historical five-table archives require their historical source and then a separately reviewed forward migration. A database backup or exported application object set is not a full Cloud disk backup.

## Deployed candidate

The authenticated [application](https://workflow-agents.68.210.88.115.sslip.io) is live in the existing GCC Workflow Agents project/staging environment. Only that application is public; infrastructure APIs, three databases and RustFS remain private.

| Component | Exact deployed source | Finished deployment |
| --- | --- | --- |
| Provider | `0b816c4a127dd61a1704eac2bc8e7b1c9889adad` | `eqzxxyzt4pmspla9u31xgwue` |
| Runner | `0b816c4a127dd61a1704eac2bc8e7b1c9889adad` | `cnjp6nm35djame2lrygqs990` |
| Application | `b9ba897348ebaf93c16505f50ccf926f5094a70b` | `tx9xvettt4bhn6unr5jkllxb` |

The application's initial replacement could not bootstrap because the download allowlist omitted the new rc3 asset. The deployed application fix adds the exact reviewed asset/checksum/size; public readiness now passes. No existing request was replayed. Four pre-upgrade request statuses, results and downloadable checksums survived the additive migration and replacement.

The published [rc3 runtime](https://github.com/Ntrakiyski/workflow-agents/releases/tag/pi-document-runtime-v0.1.0-rc.3) is 95,978,009 bytes, SHA256 `2ce2c1ee993c9f8706e208c99ac98d884c349408f1546fadbb7093ba211a22cc`. The current profiles are sandbox `pi-document-cloud:v3`, preparation `pi-document-prepare:v4` and request `pi-document-agent:v4`. The v4 profiles reuse the same rc3 tool archive; the request profile carries a separately checksum-bound controller and saves it read-only under each UUID’s config folder. Shared tools are neither reuploaded nor modified. It contains Node 24.22.2, Pi 1.5.0, OfficeCLI 1.0.160 and ICU 72; the guest has 2 CPU/2048 MiB RAM/2048 MiB disk and hostname-only LiteLLM outbound policy. This archive is a tool bundle, not a VM clone.

The deployed code pins are separate from configuration. The immutable v4 profiles/controller come from `1f46823e3241d03278892ff3fb7487746e2274ba`; capacity configuration is recorded at `0e62bfc859c12385f06afe9d02d6d73dfbdda70a`. Runner worker/global capacity and Provider dispatch slots are two. The default Runner owner limit stays one; the application principal explicitly allows two. The dedicated Workflow Agents model key allows two concurrent calls and 60 model calls/minute, with the existing $5 budget and single model scope.

## Executed qualification

- [Independent source review](../qa/SHARED-SANDBOX-REVIEW.md) found and verified four corrections: preparation limit, same-disk recovery after an observed stop, deadline recheck after lock contention, and checksum-bound completion classification. Its final focused Provider suite passed 29 cases and Runner integration passed 18. Earlier full Provider 96, Runner 18 integration plus 5 unit, contracts 7 and scope guards 2 passed separately.
- Application 17 backend tests, 2 desktop/mobile browser tests, 2 encrypted backup/restore cases, 5 runtime-cache tests and typecheck/format/build passed with real disposable PostgreSQL/RustFS and mocked execution. [Application CI](https://github.com/Ntrakiyski/workflow-agents/actions/runs/41826416700) and [infrastructure CI](https://github.com/Ntrakiyski/workflow-agents/actions/runs/41826416628) passed on the deployed application source; CI does not call Cloud or the model.
- Workload checks passed 2 Node and 17 Python cases, two reproducible builds and concurrent actual Node/Pi-version/OfficeCLI Unicode checks in the exact slim image. Model execution was mocked or absent in these local checks.
- [Clean actual-Cloud service qualification](../../services/sandbox-provider/evidence/shared-cloud-local-services-2026-11-04.json) at source `9a08319` passed eight checks: concurrent jobs, scoped transfer while active, detached-descendant cancellation without sibling interruption, Provider SIGKILL/journal recovery at attempt1, guest deadline while Provider was down, independent deadline with sibling completion, same-sandbox liveness and unchanged source/runtime hashes. Services/PostgreSQL ran locally and workloads were synthetic Python. All owned fixtures were cleaned. This does not substitute for the GCC/Pi application journey.

The [hosted concurrent pair](shared-hosted-concurrent.json) passed actual authenticated Chromium → GCC application → Runner → Provider → Cloud → Pi/LiteLLM/OfficeCLI → validated protected DOCX download. Requests `36144844-b877-43ee-a7c6-aec106341b4f` and `c627fb94-acc8-4d5c-a475-5ef3fb84ffca` have independent UUID session IDs and working directories in the same retained sandbox. Their saved sessions overlap for **9,647 ms**, from 13:10:11.605 to 13:10:21.252 UTC. Both completed Runner attempt 1; complete original/output/session/manifests, exact synthetic edits, preserved originals, saved prompt snapshots and desktop/mobile views passed. Provider and application audits confirm safe idle shutdown after both exports. This is measured session overlap, separately from the UI's running status.

The [same-disk resume test](shared-workspace-resume.json) passed request `5d072884-a8ca-4b09-9879-a00f4efb3c02`: login/new admission restarted the same sandbox and produced a validated protected output without upload or preparation. Final checkpoint inspection confirms the same sandbox `sbx_90cbc75fdd2c405cab2ffff81fee921c`, original preparation job `job_336ddeee-69a6-40a6-a081-f0e7a726926b`, unchanged 95,978,009 uploaded bytes, complete exports and attempt 1. Four pre-upgrade request statuses, result hashes, input/output IDs, bytes and checksums also passed retention checks after replacements.

Both CI workflows passed at configuration source `0e62bfc` ([application](https://github.com/Ntrakiyski/workflow-agents/actions/runs/41834486129), [infrastructure](https://github.com/Ntrakiyski/workflow-agents/actions/runs/41834485863)) and diagnostic source `fe73013`. CI uses mocked execution; the hosted proof above is separate. Controller checks passed 2 Node and 17 Python regressions. A [real local Pi/LiteLLM/OfficeCLI edit](combined-prompt-local.json) independently checked the combined text, exact marker, original and session.

Earlier qualification records are preserved:

- The [initial pair](shared-initial-prompt-failure.json) prepared successfully but failed document validation because the gateway discarded system messages. The owner requested combining the prompts on the existing endpoint. Immutable v4 implements that direction and reuses unchanged rc3 tools.
- The [first successful v4 pair](shared-hosted-browser.json) validated results and prompt snapshots but was serialized by Runner limits of one. A [Runner-only correction pair](shared-runner-only-pair.json) dispatched promptly but Provider still serialized it. [Runner](shared-runner-capacity.json) and [Provider](shared-provider-capacity.json) capacity readbacks document both corrections.
- After both scheduling limits were corrected, a pair reached concurrent Pi execution but exhausted the dedicated key's former 10 calls/minute allowance during tool steps. [Bounded failure diagnosis and key readback](shared-model-rate.json) record HTTP 429 and the scoped increase to 60 calls/minute. The final fresh pair above passed. Failed UUIDs, execution identities and fences remain preserved; no failed workload was replayed.

## Backup qualification

The installed off-host backup service completed capture `20261104T131307662Z-ae916641-4be5-4aa4-9561-f9178fc0ba21` with all three authenticated encrypted archives from the deployed sources above. Its daily timer is enabled and active at 02:40 UTC plus up to five minutes of jitter. This proves this invocation and timer configuration, not a history of unattended daily success. The selected operator source is `1f46823e3241d03278892ff3fb7487746e2274ba`; matching profile/controller inventory and the separately pinned tool bundle are retained.

[Application restore and replay](shared-application-restore.json) matched all **7 tables**, 15 requests, 93 audit rows, exact sequences and **55 immutable objects / 453,829 bytes** in new isolated PostgreSQL/RustFS resources. Both workspace/settings tables and request prompt snapshots are included. The 95,978,009-byte rc3 tool bundle was reconstructed into the new bucket and downloaded at its pinned checksum. [Infrastructure forensic restore and replay](shared-infrastructure-forensic-restore.json) matched both databases' rows, audits and sequences, including retained bindings. Every owned restore database/bucket/container/volume was cleaned. No restored Provider, Runner worker or Cloud client started.

[Archived prompt/session verification](shared-archived-prompts.json) confirms the default plus instructions occur in one user text for both concurrent requests and the resume request, matching each immutable request manifest and UUID session. The [bounded known-secret scan](shared-checkpoint-secret-scan.json) found no matches in authenticated row JSON or decoded object bytes; compressed DOCX XML and unknown credentials are outside that scan.

[Final live readback](shared-final-live-state.json) confirms healthy finished source pins, private infrastructure/storage/databases, trusted HTTPS, authenticated access, anonymous denial and zero temporary tasks. A Cloud guest disk, runtime rebinding and operational cutover remain outside this logical recovery proof.

## Review and remaining limits

Generic infrastructure is [draft PR #4](https://github.com/Ntrakiyski/workflow-agents/pull/4), based on the previous application candidate; application/workload integration is [draft PR #5](https://github.com/Ntrakiyski/workflow-agents/pull/5), stacked on #4. No automatic merge is authorized. Later documentation commits do not change the deployed pins above.

Stable infrastructure readiness remains false. Broader network/escape/load testing, full Cloud guest-disk recovery, shared-host reboot and general exclusive active-output recovery remain open. The bounded shared journal recovery qualifies its recorded profile/scenarios. Structural DOCX and exact synthetic markers do not establish rendered layout, pagination or general semantic accuracy.


## Persistent request timeline and total time

Application-only deployment `tx9xvettt4bhn6unr5jkllxb` at `b9ba897348ebaf93c16505f50ccf926f5094a70b` adds a vertical, newest-first status timeline with browser-local dates/times including seconds. Progress changes append to the existing audit only when the message changes, survive reopening and expose only application-owned status text. Old requests retain their real recorded milestones without fabricated intermediate history.

The request list now shows Total time from submission through completed export or failure, including queue/preparation time. A single browser timer updates active rows each second; terminal durations use the first audit matching the current outcome and do not grow during idle-stop retries. A historical terminal row without an outcome audit falls back to its last stored update. No database migration or infrastructure/workload change is required.

[Hosted timeline evidence](request-timeline-hosted.json) passed actual authenticated desktop/mobile Chromium → GCC → Cloud → Pi/LiteLLM/OfficeCLI for synthetic request `22189a66-31c2-4542-8530-230cd918b447`. Startup, input preparation, dispatch/queue, Pi work, saving and completion are saved in order. Its **72-second** total matched submission/completion timestamps, advanced while active and stayed fixed after reload/reopen. The protected DOCX preserved the original and contained the requested synthetic marker once. All 16 pre-existing requests retained statuses/result hashes, file IDs, exact bytes and checksums. Screenshots were inspected outside Git; no overflow or browser console errors occurred. The shared runtime's uploaded byte count stayed unchanged.

All 18 local backend checks, two desktop/mobile browser journeys, typecheck/format/build and exact-source [application CI](https://github.com/Ntrakiyski/workflow-agents/actions/runs/41839008428) and [infrastructure CI](https://github.com/Ntrakiyski/workflow-agents/actions/runs/41839008737) passed. CI execution is mocked; the hosted check above used the actual model. [Final live readback](timeline-final-live-state.json) confirms the finished application deployment, unchanged infrastructure pins, private dependencies, authenticated HTTPS, healthy databases/storage and no temporary tasks. The previous backup/restore evidence above retains its original capture sources and scope.
