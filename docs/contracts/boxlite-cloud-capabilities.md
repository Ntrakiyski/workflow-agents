# BoxLite Cloud adapter capability review

Reviewed 2026-11-03. This is a read-only architecture review for the user-authorized Cloud backend. Runner and Provider `/v1` request/response semantics remain unchanged; Cloud is a `SandboxRuntime` implementation, not another public service contract. No API key, credential-bearing request, existing Cloud box ID, or box mutation was used by this reviewer.

## Sources and executed checks

- Downloaded [canonical agent.md](https://boxlite.ai/agent.md), revision `2026-11-02.1`, which targets `boxlite==0.11.0`. It explicitly marks its production journeys unverified. It source-reviews commit `547b6d26404c6ac2166b5115950b2956e74a6b58`, which is not a deployed-server revision attestation.
- Downloaded actual CPython 3.12 x86-64 wheels for 0.10.8 and 0.11.0, extracted/imported each independently, and inspected native signatures. No local runtime or Cloud connection was created by importing them. Wheel SHA256: 0.10.8 `2061e6a0e725b73fed044decd4c57c3840457ffb1e919bd3e7d381f66f99b34e`; 0.11.0 `73fdac07222f96334bd79de8a88f6f657776ee59d4bf8c91e065168184279566`.
- Reviewed source `src/boxlite/src/rest/{runtime,client,options,exec,litebox,types}.rs`, `sdks/python/src/{runtime,options,exec,box_handle}.rs`, Cloud controller/DTO/mapper, entity and create service at the guide's commit. Compared relevant lifecycle fields at release tag 0.10.8 (`fc65419699906b41aa5e960a9e8495ade19a5395`). Release tag 0.11.0 resolves to `24cef4607416b4b75e4663f966f8315a5e4773bd`; a guide's later source review and a release tag are distinct evidence.
- Downloaded [source OpenAPI](https://github.com/boxlite-ai/boxlite/blob/547b6d26404c6ac2166b5115950b2956e74a6b58/openapi/box.openapi.yaml): OpenAPI 3.1.1, document version 0.1.0, route `/v1`. `https://api.boxlite.ai/openapi.json` returned 404 without credentials; no claim was made that this guessed location serves the deployed specification.
- Actual unauthenticated `GET` and `HEAD https://api.boxlite.ai/v1/config` returned 200. The observed response header is `x-boxlite-api-version: 0.0.1`; this is separate from route v1, source document version 0.1.0 and SDK version 0.11.0. Actual body only advertises capabilities: snapshots/clone/export/import false; inbound updates/private tunnels/exec user true. It advertises no CPU/RAM/disk defaults or account ceilings.
- Re-ran `contracts/tests/test_contracts.py` after optional operator profile additions: 5 tests passed. These are schema tests, not Cloud runtime tests.

The lead separately reported a real own-box SDK 0.11.0 create/write/stop/close/new-client reattach/read/delete preflight. That report belongs in the lead's executable Cloud evidence, not this reviewer's executed-test count. Existing account resources must remain untouched.

## Runtime and lifecycle map

Actual wheel native interfaces relevant to the adapter are the same in 0.10.8 and 0.11.0. This verifies interface availability, not all behavior or compatibility with every deployed Cloud revision. Pin 0.11.0 for the implementation, supported by the current canonical guide and the lead's real preflight.

| Needed behavior | SDK 0.11.0 interface | Qualification |
|---|---|---|
| Construct REST runtime | `Boxlite.rest(BoxliteRestOptions(url, credential=ApiKeyCredential(key), path_prefix=...))` | Always pass the REST runtime. Never fall back to `Boxlite.default()` on failure. |
| Create | `await rt.create(BoxOptions(...), name=stable_name)` | SDK returns low-level Box; Cloud source may already wait for startup although generic OpenAPI says configured. Inspect state instead of assuming create means complete. |
| Find stable identity | `await rt.get_info(id_or_name)` or `await rt.get(id_or_name)`; `await rt.list_info()` | Source Cloud supports name lookup and unique `(organizationId,name)`. Persist returned opaque ID; all retained operations should use ID. |
| Start | `await box.start()` | Source supports reattach/start same retained identity. Wait/inspect actual running state. |
| Stop | `await box.stop()` | Non-destructive only when `auto_delete=0`; Cloud stop response can precede final state. Poll inspected stopped state. |
| Inspect | `await box.info()` / `await rt.get_info(id)` | BoxInfo exposes identity/state/image/cpu/memory/network/lifecycle. Missing disk/digest metadata is not proof of enforcement. |
| Execute | `execution = await box.exec(command, args=..., env=[(key,value)], timeout_secs=..., cwd=...)` | Returns asynchronous handle. Persist dispatch intent before the call and `execution.id()` immediately after it returns. |
| Stream/collect | `execution.stdout()`, `execution.stderr()` asynchronous iterators, plus `await execution.wait()` | Drain both concurrently with byte limits. Low-level wait result contains exit_code/error_message, not collected stdout/stderr. SimpleBox's result interface differs. |
| Recover known execution | `await box.attach(execution_id=id, stdin=False)` | Reattach existing ID only. Another attachment may give 409; a reaped session may give 404. Original output may be lost across disconnect/restart. |
| Cancel known execution | `await execution.kill()`; or `await execution.signal(signal)` | REST kill deletes/evicts execution after SIGKILL. Acknowledgment plus reconciliation is needed before releasing the active-run slot. Never destroy the box to cancel a run. |
| Destroy explicitly | `await rt.remove(id, force=...)` | Only authorized destroy/disposable-test cleanup may call this. No stop/start/restart code path may invoke remove. |
| Close client | `rt.close()` (synchronous) | Native Python implementation is a no-op `Ok(())` in inspected versions. It does not stop boxes or free a remote account. No await. |

`rt.shutdown()` is a separate API whose local semantics stop all runtime boxes. Its reviewed REST implementation is a no-op, but the Provider should never call it because a backend/configuration change could make it destructive.

Use low-level Box/Execution interfaces consistently. SimpleBox convenience methods get-or-create and collect can hide identity/recovery decisions and swallow some stream/wait errors into `exit_code=-1`.

## Persistence and ambiguous effects

Set `auto_remove=False`, **`auto_delete=0`**, `auto_stop=0` and `auto_resume=False` explicitly. The deprecated auto_remove flag is not serialized to the Cloud REST lifecycle fields in either reviewed release; false alone is not retention proof. Modern lifecycle fields are serialized as requested. Verify returned lifecycle policy before accepting a new sandbox. A stopped VM does not preserve process memory; workload files must live on retained disk.

Use the existing fixture rootfs directory `/opt/workflow-fixture`, working directory `/`. `/tmp` may be a mount/tmpfs and must not serve as retained-disk proof. No public tunnel, port publication or inbound enable operation is needed for approved exec workloads.

Stock Python images may have an unsuitable short-lived image entrypoint/default command on some deployments. Optional trusted operator `entrypoint`/`cmd` configuration supports an explicit foreground keepalive; it does not add caller-selected commands to HTTP. `entrypoint` 1–32 bounded argv elements and optional `cmd` 0–32 are backward-compatible configuration additions. Use direct argv, no request interpolation.

Persist a stable Provider-generated unpredictable name before first create and a backend/account binding. Source enforces a DB uniqueness constraint on `(organizationId,name)`, and create converts a uniqueness violation to 409. Name recovery must only adopt an exact Provider-owned name matching expected configuration. Never select another box because it is the only one in the account. Once ID is known, do not switch back to name-based identity for retained operations.

The generic source OpenAPI advertises optional idempotency headers, but Python SDK create/exec signatures expose no idempotency-key argument and the reviewed Cloud controller does not itself provide proof of a server idempotency ledger. Do not rely on that header for exactly-once side effects. Durable Provider create-dispatched/execution-dispatched fences and reconciliation are required. After a create timeout, inspect the stable identity; a negative result while outcome is uncertain is not permission to allocate an unrelated box. After an execute timeout before a returned execution ID, fail closed for manual reconciliation; never submit a new execution to find out whether the old one exists.

The SDK execution transport can recover an exit code from status while losing unstreamed stdout/stderr. A 0 exit code does not prove complete result output after reconnect. Provider recovery must mark output uncertainty/truncation or return a safe failure requiring reconciliation rather than silently claiming complete results. Host restart recovery of the Cloud infrastructure is outside customer control; test client/Provider restart against the same Cloud box separately and record host-level persistence as vendor-dependent/unverified.

## Network and resource boundaries

Construct `NetworkSpec(outbound=OutboundNetworkSpec(mode="disabled"), inbound=InboundNetworkSpec(mode="disabled"))`. Outbound disabled at creation means no guest NIC according to the guide; exec/control remains available. `enabled` with `allow_net=[]` means unrestricted egress. Never describe it as deny-all.

The actual SDK deliberately serializes disabled inbound using the compatibility flat network shape, e.g. `{mode:"disabled"}`. Source `CreateBoxNetworkSpec::Legacy` and the Cloud mapper agree that omitted inbound remains disabled. Therefore flat serialization alone is not evidence that inbound was enabled, but acceptance still requires returned `BoxInfo.network` to show both effective directions and a real traffic negative test. Nonempty inbound allowlists are unsupported. For future outbound allowlists, hostname rules do not filter all DNS/UDP and existing flows may retain old policy; do not claim a complete network air gap.

Cloud CPU source DTO enforces 1–16 vCPUs. Its DTO accepts memory >=256 MiB, but the **Cloud mapper rounds memory up to whole GiB** (`Math.ceil(memory_mib/1024)`), and reports actual allocation multiplied by 1024. The lead independently observed a requested 256 becoming 1024. Require configured Cloud RAM >=1024 MiB in multiples of 1024 so claimed resources match actual allocation. Disk requests are positive whole-GiB integers (`disk_size_gb`); the generic Provider already restricts `disk_mib` to multiples of 1024. Account maxima, quotas and capacity are credential/organization specific and were not discoverable from the unauthenticated config response.

BoxInfo and the reviewed Cloud Box response omit effective disk capacity and resolved OCI digest. The image field echoes an approved/requested image string and is not signed image attestation. Do not silently substitute the Cloud `python` alias for a pinned image if a pinned image is refused. Guest `statvfs` or `df` on an owned disposable box can supply observed rootfs capacity, but sparse provisioning, overhead and vendor ceilings mean it is not exact quota attestation. Keep these limitations explicit unless an independently validated Cloud API supplies stronger evidence.

Backend migration must preserve old local identity/storage records and reject attempts to attach them under Cloud. Record the backend/account endpoint/prefix binding per sandbox; a key-hash binding may fail closed across credential rotation and requires a documented reviewed rebind. A new Cloud resource profile ID such as `cloud-minimal-linux:v1` avoids silently changing existing immutable local profile policy. Workload argv behavior can remain unchanged and configure the new sandbox profile allowlist.

## Timeouts, credentials and observability

`BoxliteRestOptions` has URL, credential and optional opaque path_prefix; there is no Python timeout argument. The reviewed native control HTTP client sets total and connect timeouts to 300 seconds. Wrap each awaited control operation with a smaller configurable `asyncio.timeout(...)`; cancellation of an await does not prove remote mutation was aborted. Persist and reconcile unknown outcomes. Keep remote execution timeout bounded independently of HTTP control timeouts and output collection.

SDK URL composition adds `/v1` itself. Supply base URL `https://api.boxlite.ai`, not one ending in `/v1`. Identity/capability endpoints are version-root `/v1/me` and `/v1/config`; they never include path_prefix. Box-scoped paths use opaque path_prefix, which may contain internal slashes; do not reinterpret it as a tenant name. Python currently has no exposed rt.auth/get_me binding, so a separate bounded authenticated HTTP identity read may be necessary if deployment routing requires discovery. Validate HTTPS URLs and reject userinfo/query/fragment to avoid credential-bearing endpoint logs.

Native credential/options repr redacts the key, but application logging must not depend solely on repr safety. Never print keys, full environment, authorization headers, API request bodies, remote output or arbitrary SDK exception strings. Catch classified SDK errors, including NetworkError, and emit safe local error codes. Disable verbose SDK transport tracing in deployment; source trace logging can include execution control text. Record correlation, actor/effective owner, sandbox/run IDs, action, duration, outcome and safe error class in service logs/audit, with no Cloud credential values.

## Remaining independent acceptance evidence

Before declaring Cloud-backed Provider ready, the lead and independent QA must capture actual service-through-HTTP create/execute/stop/same-ID start/read, new Provider client/process recovery, two-box filesystem isolation, effective network deny and traffic failure, exact memory allocation, bounded output/cancellation, create/execute ambiguity without duplicate side effects, API ownership/delegation, durable logs/audit and explicit cleanup of owned disposable boxes. Cloud backup/export is unavailable in the observed capabilities; retained Cloud disks are not an independent recoverable backup. No host-reboot test or real Cloud operation is claimed by this read-only review.
