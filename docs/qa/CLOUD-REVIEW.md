# Independent BoxLite Cloud review

Status: implementation and remote qualification pending. No Cloud resource was provisioned, started, stopped or deleted by this reviewer. Existing local fake-runtime results and loopback wire tests do not qualify a hosted microVM. The frozen Provider and Runner v1 contracts remain the consumer boundary; no Phase2 application work is included.

## Independent source and installed SDK observations

The live canonical [Cloud guide](https://boxlite.ai/agent.md), fetched2026-11-03, identifies revision2026-11-02.1 and SDK0.11.0, with source review at `547b6d26404c6ac2166b5115950b2956e74a6b58`. Its production journeys explicitly remain unverified. It supersedes an earlier0.10.8 example; examples are not executed infrastructure evidence.

Pinned source reviewed independently: `src/boxlite/src/rest/{runtime,types,client,litebox,options}.rs` and Python `simplebox.py` at that commit. Installed QA wheel is actually0.11.0. Source and wire observations agree on the following boundaries:

- Explicit REST runtime selection prevents accidental local runtime initialization. URLs are versioned `/v1`, with any opaque account routing prefix separate from root identity/config endpoints.
- Modern retention fields must be explicit. Deprecated `auto_remove=False` alone sends no `auto_delete` policy. A persistent fixture needs `auto_delete=0`, deliberately selected auto-stop/resume, and detached ownership. SDK close is not box destruction.
- Stop uses POST to the returned box ID's `/stop` route; removal uses DELETE. Return identity is validated by an existing SDK handle. Recovery must preserve the actual external runtime ID and must not silently allocate another box after a failed lookup.
- Default SDK HTTP/connect bounds in reviewed source are300seconds. Basic mutation requests have no automatic replay. A shorter outer timeout can occur after allocation; reconcile identity before a new create. Execution creation similarly precedes streaming attachment, so transport failure does not prove a workload never ran.
- `allow_net=[]` with networking enabled is unrestricted. Disabled outbound means no guest NIC at creation. SDK wire uses a legacy outbound-only shape when inbound is disabled; that body alone is not independent inbound enforcement evidence. Hostname allowlists are not DNS filtering or complete egress isolation. Actual Cloud inspection and controlled traffic tests remain necessary.
- CPU/RAM/disk intent reaches the request body; the request is not physical enforcement proof. REST BoxInfo omits `resolved_image` digest. An image alias is not independently proven immutable solely because it appears in BoxInfo. Approved image identity requires the deployed catalog/configuration evidence and an honest policy limitation if the server cannot pin it.
- Cloud rootfs retention fixtures must avoid `/tmp` and other mounted paths. No transfer/export capability is inferred from successful command execution. Backups must outlive the external box; a local Provider volume cannot back up Cloud disks.
- A configured Cloud key must never appear in request URLs, API errors, structured logs, operator diagnostics or committed files. Existing local diagnostic redaction lists must be extended if Cloud operator diagnostics can run. Server error bodies may contain untrusted text; public API errors remain classified and safe.
- Backend identity must be explicit or mode changes prohibited when retained runtime IDs exist. Existing GCC historical registry data has no allocated VM identity, but that does not make arbitrary future backend migration safe. Names alone must not authorize adoption/deletion of a preexisting account box.

## Tests actually executed

QA added `tests/qa/test_cloud_sdk_wire.py`, which imports no Provider code. It connects the installed native SDK0.11.0 to an independent loopback HTTP stub using an inert test credential. Command:

```sh
PYTHONDONTWRITEBYTECODE=1 /tmp/workflow-provider-qa-venv/bin/python tests/qa/test_cloud_sdk_wire.py
```

**Five tests passed in2.746seconds**, no skips. They verify explicit retention/resource/network wire fields, stop/close without DELETE, the deprecated-retention omission, a503 create issuing exactly one POST, rejection of a changed handle identity, and an actual cancelled create request whose stub-side allocation remains discoverable without another POST. This last result demonstrates timeout ambiguity in the client protocol; the allocation and HTTP server are both test doubles. These tests are neither Cloud credentials validation nor real filesystem/VM results. They make no claim about live server capability, immutable images or resource/network enforcement.

QA externalized `QA_SANDBOX_PROFILE` in the HTTP probe (default remains `minimal-linux:v1`). The new Cloud profile is `cloud-minimal-linux:v1`; all phases must use the same explicit value. Principal selection, new submissions, live retained-record checks and invocation-cache identity use this setting. Retained-record format remains version1, and live owner/reference/profile/job anchors still gate lifecycle operations.

Executed Node syntax check and an ad-hoc local protocol harness `python3 /tmp/cloud-qa-protocol-smoke.py`, using fresh isolated local PostgreSQL databases, actual HTTP services and an **explicit healthy-labelled runtime test double solely to exercise the client**. Both concurrent prepare invocations passed nine groups and returned the same record with exactly one replay. Verify correctly rejected absent actual Provider recovery. Exact-fixture cleanup passed; cleanup with a different configured sandbox profile and a tampered owner-reference both failed before destruction. Owned processes/databases were cleaned. These are client-regression checks, not Cloud, microVM, real filesystem isolation or restart qualification.

## Deployed acceptance procedure

Use the existing independent HTTP-only `gcc_probe.mjs` as published-API acceptance with a separately verified real Cloud adapter and approved fixture profiles. It has no fake/unavailable-runtime success branch. Keep concurrency low and retain only two exact fixtures:

1. Prepare concurrently deduplicates a Runner marker-write submission, rejects changed-body reuse, verifies a real completed command, stops/starts the same public sandbox, and rereads its marker checksum. A second sandbox must execute a real nonzero read without seeing the first marker; setup failure does not satisfy isolation. Owner boundaries, cancellation fences and durable audit IDs are checked. Leave both stopped.
2. Save the retained record externally before container replacement. Separately capture actual Provider/Runner deployment IDs and old/new container identities. Capture each fixture's external Cloud runtime ID/name mapping, explicit retention policy and image/resource/network metadata through the operator, without credentials. A public sandbox ID alone cannot prove a stable external runtime.
3. Replace Provider and Runner independently; verify the retained record requires original jobs/events and Provider recovery audits, starts the original fixture and rereads the marker without uploading again. Compare external runtime identities and policy metadata before/after. Completed-record retention is distinct from recovery of an active execution.
4. Explicit cleanup must validate record owner/reference/job anchors and remove only the two exact fixture sandboxes through destroy authorization. Preserve tombstones/jobs/audits. No account-wide cleanup or deletion by guessed names.

Generic marker retention proves a specific rootfs journey; it does not prove every kernel/network escape boundary, enforced CPU/RAM/disk limits, arbitrary transient retries, active-run restart recovery, artifact export or a recoverable off-host VM backup. Those gates remain incomplete until their own actual evidence is captured.
