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

## Verification status

Implementation and qualification are in progress. Existing production pins remain those in `DELIVERY.md` until a finished scoped deployment is recorded. Direct Cloud feasibility has demonstrated two overlapping supervised commands, cancellation of a detached descendant without killing the sibling, and retained sandbox liveness. This is separate from service/API, browser and model qualification. The new runtime passed reproducible builds and concurrent binary/Unicode/OfficeCLI checks in the pinned slim image, with model calls mocked in that check.

Stable infrastructure readiness remains false. Broader network/escape/load testing, full Cloud guest-disk recovery and shared-host reboot remain open. Final exact commits, deployments, test evidence and PRs will be recorded here after integration.
