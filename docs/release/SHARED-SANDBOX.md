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

A button beside Instructions opens a textarea with the default system prompt. Changes save for that user and are snapshotted when a request is submitted; editing the default does not change an existing request. The request detail can show the exact saved value. Both this policy and the request instructions enter Pi's system prompt. Attachment text remains explicitly untrusted reference data in the user message.

The default tells Pi to complete the request, preserve originals, keep request resources in its assigned folder, use available tools and report checks and limitations honestly. The workload appends the actual UUID path. Prompt guidance is not an OS filesystem boundary. The existing constrained OfficeCLI tool still binds document operations to the assigned working copy, and controller export validation remains required. Arbitrary shell execution, package installation and arbitrary file-type creation are not added by this change.

## Infrastructure and recovery

The generic [rc.3 extension](../contracts/shared-execution-v1.md) keeps capacity one for old profiles. Shared execution uses a new immutable Cloud profile with capacity two, durable admission in both services, separate run identities and supervised descendant cancellation. Cancelling one run must not stop sibling runs or the VM. Unknown outcomes keep their identity and are reconciled without a fresh model execution.

The application schema adds workspace and user-setting tables. Matching-source backup/restore covers seven tables and immutable application objects; historical five-table archives require their historical source and then a separately reviewed forward migration. A database backup or exported application object set is not a full Cloud disk backup.

## Deployed candidate

The authenticated [application](https://workflow-agents.68.210.88.115.sslip.io) is live in the existing GCC Workflow Agents project/staging environment. Only that application is public; infrastructure APIs, three databases and RustFS remain private.

| Component | Exact deployed source | Finished deployment |
| --- | --- | --- |
| Provider | `0b816c4a127dd61a1704eac2bc8e7b1c9889adad` | `f3ynfn7t8mjedta8pmoesshw` |
| Runner | `0b816c4a127dd61a1704eac2bc8e7b1c9889adad` | `qxdmf2udt1aotfbtkvjbyphf` |
| Application | `73fc27fe8154dd14b7c74bdf1a726dee9c1266ac` | `jorlzdpk0c0ytxk3xnwuhque` |

The application's initial replacement could not bootstrap because the download allowlist omitted the new rc3 asset. The deployed application fix adds the exact reviewed asset/checksum/size; public readiness now passes. No existing request was replayed. Four pre-upgrade request statuses, results and downloadable checksums survived the additive migration and replacement.

The published [rc3 runtime](https://github.com/Ntrakiyski/workflow-agents/releases/tag/pi-document-runtime-v0.1.0-rc.3) is 95,978,009 bytes, SHA256 `2ce2c1ee993c9f8706e208c99ac98d884c349408f1546fadbb7093ba211a22cc`. Profiles are `pi-document-cloud:v3`, `pi-document-prepare:v3` and `pi-document-agent:v3`. It contains Node24.22.2, Pi1.5.0, OfficeCLI1.0.160 and ICU72; the guest has2CPU/2048MiB RAM/2048MiB disk and hostname-only LiteLLM outbound policy. This archive is a tool bundle, not a VM clone.

## Executed qualification

- [Independent source review](../qa/SHARED-SANDBOX-REVIEW.md) found and verified four corrections: preparation limit, same-disk recovery after an observed stop, deadline recheck after lock contention, and checksum-bound completion classification. Its final focused Provider suite passed29 cases and Runner integration passed18. Earlier full Provider96, Runner18 integration plus5 unit, contracts7 and scope guards2 passed separately.
- Application17 backend tests,2 desktop/mobile browser tests,2 encrypted backup/restore cases,5 runtime-cache tests and typecheck/format/build passed with real disposable PostgreSQL/RustFS and mocked execution. [Application CI](https://github.com/Ntrakiyski/workflow-agents/actions/runs/41826416700) and [infrastructure CI](https://github.com/Ntrakiyski/workflow-agents/actions/runs/41826416628) passed on the deployed application source; CI does not call Cloud or the model.
- Workload checks passed2 Node and15 Python cases, two reproducible builds and concurrent actual Node/Pi-version/OfficeCLI Unicode checks in the exact slim image. Model execution was mocked or absent in these local checks.
- [Clean actual-Cloud service qualification](../../services/sandbox-provider/evidence/shared-cloud-local-services-2026-11-04.json) at source `9a08319` passed eight checks: concurrent jobs, scoped transfer while active, detached-descendant cancellation without sibling interruption, Provider SIGKILL/journal recovery at attempt1, guest deadline while Provider was down, independent deadline with sibling completion, same-sandbox liveness and unchanged source/runtime hashes. Services/PostgreSQL ran locally and workloads were synthetic Python. All owned fixtures were cleaned. This does not substitute for the GCC/Pi application journey.

The hosted application journey is in progress. Both admitted requests are waiting for the same initial runtime upload. Final session overlap, exports, stop/resume and the fresh seven-table recovery set will be recorded after execution.

## Review and remaining limits

Generic infrastructure is [draft PR #4](https://github.com/Ntrakiyski/workflow-agents/pull/4), based on the previous application candidate; application/workload integration is [draft PR #5](https://github.com/Ntrakiyski/workflow-agents/pull/5), stacked on #4. No automatic merge is authorized. Later documentation commits do not change the deployed pins above.

Stable infrastructure readiness remains false. Broader network/escape/load testing, full Cloud guest-disk recovery, shared-host reboot and general exclusive active-output recovery remain open. The bounded shared journal recovery qualifies its recorded profile/scenarios. Structural DOCX and exact synthetic markers do not establish rendered layout, pagination or general semantic accuracy.
