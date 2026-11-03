# GCC BoxLite Cloud validation — rc.2 continuation

**Acceptance remains incomplete: `stable_release=false`, `ready_for_phase2=false`.** Generic infrastructure qualification advanced, and the minimal application is deployed as a candidate. The rc.2 Pi document workload passed actual local execution in the exact pinned image. The hosted v2 document journey has not passed. [Readiness gates](readiness.json) and [independent review](../qa/MINIMAL-RELEASE-REVIEW.md) distinguish source, deployment and execution scope.

## Confirmed deployment

At **2026-11-03 19:03 UTC**, the integration lead confirmed all three applications finished healthy at **`8387b5da2084e062e7409b1af5ce81ae57b45dfd`**, with trusted application HTTPS, anonymous 401 and authenticated 200. This documentation update did not repeat live control-plane calls. Fresh hosted document QA is starting; process health is not proof of document delivery.

| Component | Candidate version | Finished deployment ID |
| --- | --- | --- |
| Job Runner | `1.0.0-rc.1` | `wuvkf6x1owxobcarqjtd7wbk` |
| Sandbox Provider | `1.0.0-rc.2` | `qmdjylvn3d3zou4r6mawp8al` |
| Minimal application | `0.1.0-rc.1` | `v7mt8odnad40fnxbgfdxnojy` |
| Pi document workload | `0.1.0-rc.2` | Hosted v2 qualification pending |

The contract candidate is `1.0.0-rc.2` under `/v1`; Runner retains its rc.1 service version and existing strict wire shapes. Provider's file endpoints are additive. The [original rc.1 report](CLOUD-VALIDATION-rc1-2026-11-03.md) is preserved unchanged, including its source, counts and historical fixture identities. Its old deployment/acceptance statements apply to that dated record. The infrastructure backup capture used `4bab06c`, and the application restore used `2f7820f`; neither restore claims the newer deployed source was captured.

## Runtime and private boundaries

The GCC Coolify project remains `workflow-agents-phase1` / `staging`, project `ptombcqslsfcmfufdui4vk1z`, environment `tiiebld0vegfeegaapo3cdt3`. [Infrastructure IDs](../../deploy/staging-resources.json) and [application IDs](../../deploy/application-resources.json) are separate. Runner, Provider, each database and application object storage remain private. Only the authenticated application is public at [the candidate HTTPS origin](https://workflow-agents.68.210.88.115.sslip.io).

Provider runs on GCC, while guest execution and writable disks run at BoxLite Cloud through pinned SDK `0.11.0`. Runtime credentials remain external secrets. No KVM mapping, privileged container, Docker socket, host security change or shared-host reboot was introduced. The GCC Provider volume contains no Cloud guest disks. Local BoxLite on GCC remains blocked at its bubblewrap namespace boundary; Cloud qualification does not qualify local mode.

Generic denied-network fixtures and the document hostname policy are different profiles. Actual document-policy probes used the cached immutable Python image `docker.io/library/python@sha256:e697c81897302a4c4333bade000d98038fbb21eb064f8ee1fd42d02ebcd9d337`, 2 CPUs, 2048 MiB RAM and a requested 2 GiB disk. Returned metadata confirmed the image string, CPU/RAM, disabled inbound, exact `litellm.gccssofia.com` outbound rule and retained lifecycle settings. Metadata does not attest a resolved image signature, disk backing quota or sustained enforcement.

## Executed evidence

| Check | Result and precise scope | Evidence |
| --- | --- | --- |
| Contract and Provider regression | Six contract checks; developer Provider suite 77 passed with one local-KVM test deselected. Independent full regression: 75 passed at `909980b`; two new preflight checks passed independently at `72c2738`. Actual PostgreSQL, fake runtime/actual SDK loopback; no Cloud claim from these tests | [Provider verification](../../services/sandbox-provider/VERIFICATION.md), [independent review](../qa/MINIMAL-RELEASE-REVIEW.md) |
| Historical deployed GCC journey | Generic Runner→Provider→Cloud execution, duplicate admission, same-box marker retention through stop/start and independent service replacements, durable audits and exact-fixture cleanup | [unchanged rc.1 report](CLOUD-VALIDATION-rc1-2026-11-03.md) |
| Scoped transfer, file checkpoint and cancellation | Actual Cloud/private local Provider at exact source `909980b`: 2,097,166-byte multichunk checksum/replay, owner/path/symlink negatives, Provider process replacement, reconstruction into a distinct sandbox, delayed-descendant absence after cancellation/restart, separate forensic registry restore. All owned fixtures cleaned | [transfer journey](../release/cloud-transfer-journey.json) |
| Controlled failures | Seven scenarios against actual Cloud, isolated local real services/PostgreSQL and a controlled HTTP proxy/SIGKILL: duplicate, transient before effect, timeout before/after effect, worker crash, Provider crash and cancellation race. One admitted run and one observed effect per scenario; Provider crash truthfully failed without replay. Not GCC container fault injection | [final failure journey](../release/cloud-failure-journey-final.json) |
| Bounded resources | Two CPU workers for two seconds on a one-vCPU guest; rootfs ENOSPC at observed capacity; bounded memory-pressure child SIGKILL consistent with OOM, without kernel-counter attestation; denied-profile fixed TCP probes. Direct SDK fixtures, not GCC/API stress qualification | [resource journey](../release/cloud-resource-journey.json) |
| Hostname HTTPS policy | Actual cached-image guest: approved LiteLLM HTTPS `/v1/models` returned 401; `https://example.com/` and `https://1.1.1.1/` ended TLS with EOF before HTTP. Raw TCP connects were accepted. Both owned network fixtures were deleted with exact-ID absence confirmed | [hostname evidence](../release/cloud-hostname-network.json) |
| Encrypted off-host infrastructure restore | Deployed `4bab06c` Runner/Provider logical archives restored twice into isolated resources; exact row/audit identities and sequences matched. No runtime client started and no Cloud guest restored | [infrastructure restore](../release/offhost-restore-final-infrastructure.json), [backup procedures](../../deploy/README.md) |
| Application row/object restore | Actual deployed `2f7820f` checkpoint restored twice into new local PostgreSQL/RustFS resources; five tables, audit/sequence identities and one 5,205-byte original attachment matched. The failed request has no completed result/session objects | [application restore](../release/application-restore-attempt-1.json) |
| Application implementation/browser checks | Ten backend checks use real PostgreSQL/RustFS; two browser checks use mocked execution. Hosted browser admission, replay, list/reopen, retained failure and original-download ownership checks passed at `2f7820f`; successful hosted document/output download remains pending | [application verification](../../apps/application/VERIFICATION.md), [hosted attempt](../release/hosted-application-attempt-1.json), [failure review](../release/hosted-application-failure-review.json) |
| Local Pi document rc.2 | Two identical builds; actual Node/Pi/OfficeCLI binaries and full Pi→existing LiteLLM→constrained OfficeCLI DOCX execution in the exact slim image with bundled pinned ICU. Independent structure, synthetic marker, checksum, original-input and session checks passed. Docker bridge networking; no Cloud/browser/layout/semantic-accuracy claim | [workload verification](../../workloads/pi-document-agent/VERIFICATION.md), [version/provenance](../../workloads/pi-document-agent/release.json) |

Each hosted diagnostic record retains its own fixture and cleanup authority; these records authorize no mutation of unrelated resources. Earlier account-wide continuity uncertainty remains unverified. Local service processes against real Cloud are actual hosted-runtime evidence, while GCC deployment behavior is a separate scope.

## Policy and image findings

BoxLite allowlist entries accept hostname/wildcard-hostname or IPv4/CIDR rules, without schemes or port suffixes. The actual SDK rejects `hostname:443` before any HTTP request; Provider now rejects it before registry/idempotency/audit insertion. Policies are never silently rewritten. Exact-hostname rules do not provide per-port controls. Pinned upstream code describes hostname routing through SNI/Host inspection; raw TCP acceptance is insufficient to establish HTTPS egress. DNS/UDP, blanket TCP denial, rebinding, airgap and comprehensive isolation remain unqualified.

The pinned full Python image failed in Cloud during Docker Hub registry-token transport to `index.docker.io`, after allocating a retained box despite no returned create ID. Only that journaled fixture was reconciled and deleted. A native error class is not proof of no side effect. [The rejection record](../release/cloud-policy-rejection.json) separates the local rule rejection from the later image-start failure.

The rc.2 runtime bundles checksum-verified ICU from the reviewed full image, then executes in the already qualified pinned slim image. It does not enable invariant globalization, use an unpinned alias or change host security. Its archive is 95,977,914 bytes with SHA256 `08a6dda2a800958428a2089639c721b19bf866d83e55976c8cf2ef167772094a`. Scoped upload previously observed roughly 11.5 seconds/MiB; staging this larger archive may take about 17.5 minutes at that rate. This is an estimate, not a measured hosted rc.2 upload or vendor guarantee.

## Remaining gates and readiness decision

1. **Hosted v2 delivery:** execute browser submission→Runner→Provider→Cloud→Pi/LiteLLM/OfficeCLI→independently validated downloadable result. Prove protected output access, durable correlated audits, safe export-before-stop and request/result persistence through application replacement. The earlier failed request remains retained; a local preflight does not close this gate.
2. **Active-command recovered output:** fresh execution requires a nonce/checksummed completion envelope even for silent children. Active attachment remains nonretryable `ambiguous_execution`; preserve the same environment and never replay uncertain side effects. Complete output/journal reattachment remains unqualified.
3. **Coordinated required-data recovery:** encrypted infrastructure restore, an originals-only application restore and selected guest-file reconstruction passed separately. Capture completed result/session objects and restore the corresponding application/registry/required-file set in isolation before claiming coordinated recovery. Restore drills must not start another Provider/worker against existing Cloud bindings. Full VM snapshot/export/import/clone remain unavailable.
4. **Deployed failure recovery:** controlled local-service faults against real Cloud passed. They do not prove fault injection through GCC application/container replacements or every fresh-stream disconnection path.
5. **Broader runtime/security:** resource probes are bounded. Sustained/multitenant quotas, exact memory-kill attribution, vendor backing-store quota, comprehensive escape/network boundaries and shared/vendor-host restart remain unverified. No host reboot is part of ordinary acceptance.
6. **Document validation limits:** OOXML/schema/marker checks are distinct from rendered layout, pagination, translation or semantic accuracy; the latter were not established.

The minimal UI scope remains submission, an authorized persistent list and results. Broader Phase 2 features are deferred in [the narrowed scope](../release/MINIMAL-SCOPE.md). Infrastructure and application remain candidates with stable readiness false. Current work is reviewable through [infrastructure PR #2](https://github.com/Ntrakiyski/workflow-agents/pull/2); merged PR #1 is historical delivery, not a current deployment claim.
