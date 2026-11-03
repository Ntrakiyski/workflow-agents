# Minimal application delivery candidate

The initial release contains instructions/attachments, an authorized persistent request list, and a request detail with status, text/downloads, validation or actionable failure. The [narrowed scope](MINIMAL-SCOPE.md) defers the broader Phase 2 screens. Infrastructure and document logic remain independently owned.

**Stable readiness remains false.** This candidate does not qualify active-command reattachment, full Cloud guest-disk restoration, shared/vendor host reboot, comprehensive escape/network testing or sustained multi-tenant load.

## Deployed components

Provider and Runner run `8387b5da2084e062e7409b1af5ce81ae57b45dfd`; the application runs `1d21e27a571388484774e401cc5d5a5a3cec0973`. All are healthy in GCC project `workflow-agents-phase1`, environment `staging`.

| Component | Candidate | Finished deployment |
| --- | --- | --- |
| Sandbox Provider | contract `1.0.0-rc.2`, BoxLite SDK `0.11.0` | `iaeiglup1n9zxypdzk2mglcr` |
| Job Runner | contract `1.0.0-rc.2`, Graphile Worker `0.18` | `wuvkf6x1owxobcarqjtd7wbk` |
| Request application | `0.1.0-rc.1` | `uqgpm525dt5gaulngxrjsagb` |

Application: <https://workflow-agents.68.210.88.115.sslip.io>. Trusted TLS, anonymous401 and primary authenticated200 were checked after replacement. Credentials remain in the private operator file, never this document. The temporary foreign QA account and Provider cleanup actor were removed; [runtime policy inspection](final-provider-policy.json) confirms ordinary application credentials have no destroy permission. Both [fresh](hosted-application-final-persistence.json) and [recovered](hosted-recovered-final-persistence.json) results retained exact IDs, bytes and checksums after final replacement, with removed-account401, primary-owner access and browser checks repeated. Infrastructure APIs, all databases and RustFS remain private without published host ports.

RustFS uses `docker.io/rustfs/rustfs@sha256:1cfa82fb394a7c6a4ffc24f5333b52afee608d258503f94b37fcce5cc965c896` (`1.0.0-alpha.83`) and persistent `/data`. It stores application files on GCC; it is not the independent backup copy. No Coolify S3 backup destination is configured.

Document profiles are `pi-document-cloud:v2` and `pi-document-agent:v2`. The uploaded runtime is [rc2](https://github.com/Ntrakiyski/workflow-agents/releases/tag/pi-document-runtime-v0.1.0-rc.2), SHA256 `08a6dda2a800958428a2089639c721b19bf866d83e55976c8cf2ef167772094a`, 95,977,914bytes. It contains Node24.22.2, Pi1.5.0, OfficeCLI1.0.160 and ICU72.1-3+deb12u1. The guest uses the pinned Python slim digest,2CPU/2048MiB RAM/2048MiB disk and the exact LiteLLM hostname policy. Runtime archives are transferred files, not VM clones.

## Executed evidence

| Check | Result and limit |
| --- | --- |
| Generic scoped file transfer | [Seven actual Cloud scenarios](cloud-transfer-journey.json) passed against isolated real source processes and PostgreSQL. Exact source/harness hashes recorded; this fixture suite alone is not GCC deployment proof. |
| Hosted failures | [Seven actual Cloud scenarios](cloud-failure-journey-final.json) passed with controlled proxy timeouts and owned process SIGKILL: duplicate, transient before effect, timeout before/after effect, Runner crash, Provider crash and cancellation. Ambiguous active Provider work failed without replay. |
| Bounded resources | [CPU/rootfs/network](cloud-resource-journey.json) passed within stated short bounds. Memory child kill is consistent with OOM; kernel cause is not attested. No sustained load/escape proof. |
| Approved HTTPS policy | [Actual Cloud hostname probe](cloud-hostname-network.json): LiteLLM responded401; two unlisted destinations failed before HTTP. Raw TCP acceptance, DNS/UDP and per-port restriction are not qualified. |
| Runtime reproducibility | Two byte-identical builds; [independent archive/profile/ICU review](../qa/independent-provider-2026-11-03/workload-rc2-independent-review.json). |
| Local actual document | Full Pi→LiteLLM→OfficeCLI→controller preflight passed in the exact slim image, including a Unicode edit, original preservation and session checksums. [Workload verification](../../workloads/pi-document-agent/VERIFICATION.md). No rendered page layout or semantic accuracy claim. |
| Published runtime bootstrap | [Actual RustFS and GitHub asset](storage-initialize-rc2.json): new bucket, checksum and idempotent second initialization passed. |
| First hosted browser admission | [Failure evidence](hosted-application-attempt-1.json) and [ownership review](hosted-application-failure-review.json) passed bounded admission/authentication/list/original preservation checks. Old invalid hostname:port failed before Cloud dispatch. [Exact absent-runtime admission cleanup](failed-document-admission-cleanup.json) preserved the failed application row/audits. |
| Hosted execution and export recovery | Request `598c30fa-e0d0-4d36-96d7-16d75bd675e7` completed actual Pi/OfficeCLI on Runner attempt1. The old application rejected canonical session media_type; [fixed-target export-only recovery](hosted-completed-export-recovery.json) retained the same execution and failure audits without replay. [Independent protected browser download](hosted-application-recovered-journey.json) verified DOCX structure, exact marker and unchanged original; [same-source application replacement](hosted-application-replacement.json) retained exact request/output IDs and checksum. |
| Fresh automatic rc2 journey | [Fresh request](hosted-application-journey.json) `6f3085e0-7d6f-4b9e-8ad5-7ba76f587189` completed automatically at application `1d21e27`, without operator recovery. Runner attempt1, independent DOCX/marker/original checks, protected download, owner/Origin checks and desktop/mobile UI passed. [Checkpoints](hosted-automatic-checkpoints.json) verify all files/session, export complete, same sandbox stopped and correlated audits; [logs](hosted-automatic-logs.json) retain the execution path. |
| Local application | [Verification](../../apps/application/VERIFICATION.md):11backend passes,2desktop/mobile browser passes with real PostgreSQL/RustFS and mocked execution; build/typecheck/format passed. Encrypted checkpoint tests additionally passed2real DB/storage cases with negative subchecks. [Exact application-source CI](https://github.com/Ntrakiyski/workflow-agents/actions/runs/41703356921) passed those checks plus5runtime-cache and2browser cases. |
| Provider/contracts | Local77Provider tests passed,1local-KVM test deselected. [GitHub CI](https://github.com/Ntrakiyski/workflow-agents/actions/runs/41703357570) passed6contract checks,21Runner tests and75Provider tests, with2hardware-conditional skips and1KVM deselection. Actual PostgreSQL; fake runtimes or actual SDK loopback, without Cloud execution. |
| Off-host backup and restore | Actual hardened capture authenticated all3services. [Infrastructure restore/replay](offhost-restore-final-infrastructure.json) and [application restore/replay](application-restore-attempt-1.json) passed with exact rows/audits/sequences/object checksums in isolated resources. This capture contains the first failed input; a completed-result/session recovery set is still pending. |

## Recovery and operational limits

The existing independent host pulls encrypted service-owned logical snapshots and application referenced input/result/session objects. Its enabled systemd timer runs daily at02:40UTC with up to5minutes jitter. Archives are mode600 in a mode700 directory; keys are separate protected files. The hardened service selects immutable installed operator modules. There is no automatic backup pruning.

Capture rejects active application work/unstopped retained sandboxes and verifies unchanged healthy finished deployments around each export. A failed/incomplete set is not successful backup. The bounded format rejects oversized data instead of omitting objects. Recovery applies matching migrations, restores into new database/bucket resources, preserves audit and external identities, and reads back object checksums without starting a worker or Cloud client.

Full Cloud snapshots/export/import/clone remain unavailable in observed vendor capabilities. Explicit file checkpoints can be uploaded to a separately authorized new sandbox with new identity; they do not restore an entire VM or authorize replay of uncertain side effects. Existing retained sandboxes are never silently recreated.

Cloud file transfer is currently slow: observed upload about11.5seconds/MiB and read about20.8seconds/MiB through bounded SDK commands. Each fresh sandbox uploads its runtime. The application serializes its worker and exposes simple request status; a healthy API does not prove a document has finished. Rendered layout and translation/content accuracy require separate review.

The independent-host cache now retains the exact public rc2 runtime and passes offline checksum replay; [cache evidence](public-runtime-cache.json) and five filesystem/download boundary tests cover this separate artifact. [Actual prior recovery set](application-runtime-restore-rc1.json) also reconstructed the pinned rc1 runtime in a fresh isolated RustFS bucket and verified a fresh download. Final rc2 completed-result/session capture remains pending.
