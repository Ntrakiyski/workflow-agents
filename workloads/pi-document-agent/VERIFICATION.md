# Workload verification

Recorded 3 November 2026 for workload candidate 0.1.0-rc.2. This report is not Phase 1 or application readiness approval.

| Check | Executed scope | Result |
| --- | --- | --- |
| `npm ci --ignore-scripts` | Actual registry packages against npm integrity lock; no lifecycle scripts | Passed; dependencies unchanged for rc2 |
| `npm test` | Two Node boundary tests and ten Python tests; actual archive/path/checksum/ZIP/XML/process/fence behavior and synthetic Pi event fixtures | Passed; test model events are mocked |
| `python3 -m py_compile bootstrap.py build_runtime.py guest.py render_profile.py validation.py tests/runtime-smoke.py` | Python parsing | Passed |
| `python3 build_runtime.py --output output/rc2` | Actual checksum-verified Node and OfficeCLI downloads, pinned npm packaging, locked ICU extraction through Docker | Passed; emitted archive and metadata under ignored output |
| Independent second rc2 bundle build | Fresh downloads and staging, same pinned image for ICU | Identical archive SHA256 `08a6dda2a800958428a2089639c721b19bf866d83e55976c8cf2ef167772094a` (95,977,914 bytes; expanded 313,357,336 bytes) |
| Exact slim image actual-binary smoke | Read-only runtime/source mounts, no network, read-only root, dropped capabilities, no-new-privileges, 2 CPUs, 2 GiB RAM, 128 PID limit and writable bounded tmpfs | Passed Node 24.22.2, Pi 1.5.0 and OfficeCLI 1.0.160 |
| Unicode document and real constrained extension | Synthetic Bulgarian, German, Greek, Japanese and Arabic text; actual extension replaces `София` with `Пловдив`; independently reads persisted OOXML and checks actual OfficeCLI schema | Passed, including actual bundled `guest.office()` invocation; no model call in this smoke |
| One bounded no-tools Pi/LiteLLM preflight in exact slim image | Actual existing endpoint/model, private HOME/config, read-only secret file passed only through process environment, tools/extensions/skills/context disabled, thinking off, 256 output tokens, retries disabled, 90-second process bound | Passed exit 0, completed stop event, exact synthetic final text and retained session; literal-key scan passed |
| One bounded full guest DOCX preflight in exact slim image | Actual frozen `guest.py` → Pi/LiteLLM → constrained OfficeCLI; synthetic Unicode DOCX read, one paragraph appended, readback/issues/schema validation; retries disabled and guest timeout 600 seconds | Passed exit 0 and completed result; stdout pointer size/SHA verified, copied output independently validated, marker exactly once, original Unicode/input SHA preserved, session manifest checksums verified and literal-key scan passed |
| Invalid actual OfficeCLI document (earlier candidate) | Injected a synthetic invalid Word element; pinned OfficeCLI returned `success:false` with schema errors | Correctly rejected; not rerun for rc2 |
| Uninterrupted hosted browser → Runner → Provider → BoxLite Cloud → Pi/LiteLLM/OfficeCLI | Independent QA submitted one fresh synthetic DOCX through actual HTTPS/Chromium; implementation lead separately inspected service checkpoints and structured logs | Passed, Runner attempt 1; no operator export recovery; exact evidence and identities below |
| Hosted original/result/checkpoint export and safe stop | Owning application independently checked bytes and persisted original, output, request/result manifests and Pi session in application storage | Passed; `export_complete:true`, all five export roles verified, same sandbox stopped; correlated submission/dispatch/completion/stop audits retained |
| Hosted protected result and minimal UI | Actual browser downloaded DOCX, independently checked ZIP CRC/XML/relationships and exact synthetic markers; checked request list/reload/reopen and desktop/mobile views | Passed; original bytes unchanged, marker appended once; anonymous/foreign-owner reads and foreign Origin denied |
| Rendered document layout, pagination, translation/content accuracy | Not performed | Unverified |
| Application replacement and completed-capture restore | Separately tracked release operations | See release evidence; this workload qualification does not itself assert those checks passed for the fresh request |

The exact local qualification image is `docker.io/library/python@sha256:e697c81897302a4c4333bade000d98038fbb21eb064f8ee1fd42d02ebcd9d337`. It is the cached slim guest image. The earlier host-only rc1 smoke did not detect missing ICU in that image; OfficeCLI startup subsequently failed there. rc2 packages ICU instead of enabling invariant globalization or changing to an uncached image. The two authorized local model preflight runs used Docker bridge networking and do not qualify the Cloud hostname policy, port restrictions or browser journey.

The bounded hosted qualification records the fresh automatic request `6f3085e0-7d6f-4b9e-8ad5-7ba76f587189`, Runner job `job_c28141c3-1008-4539-a041-6141b01ee45b`, sandbox `sbx_e48b86cf6f5644bdbbb7f2c5d94faf86` and run `run_08ef722652fc4acb8b4ceb5d3e7904bb`. Browser completion was captured at 19:50:27 UTC on 3 November 2026. Application source was `1d21e27a571388484774e401cc5d5a5a3cec0973`; Runner/Provider source was `8387b5da2084e062e7409b1af5ce81ae57b45dfd`, with the rc2 archive SHA above and immutable v2 profiles. This qualifies one synthetic document path, not a stable release or broader infrastructure acceptance.

Independent QA's [actual browser journey](../../docs/release/hosted-application-journey.json) verifies the 5,281-byte delivered output, SHA256 `9011e87907218c2d988827ca019c90cbb93abf2c2171c8b23fb1ecb990663260`, with exactly one appended marker and the original marker preserved. The 5,205-byte original retained SHA256 `8ea713e66ba55ac0ed017c48be1b54f72b72b5690bb9960f0c251171c42fffc9`. Owning-service [checkpoint/audit inspection](../../docs/release/hosted-automatic-checkpoints.json) separately verifies input, output, both manifests and the 11,189-byte Pi session, completed Runner attempt 1, durable export and same-box stop. [Bounded structured-log inspection](../../docs/release/hosted-automatic-logs.json) correlates application, Runner and Provider records; it is not an exhaustive logging or secrecy guarantee.

Earlier request `598c30fa-e0d0-4d36-96d7-16d75bd675e7` required explicit audited export recovery after the application rejected the guest's checkpoint `media_type` field. That recovered result and its [replacement check](../../docs/release/hosted-application-replacement.json) remain separate historical evidence. The fresh request above completed automatically with the contract-correct strict checkpoint schema (`application/x-ndjson`) and no operator recovery. No fenced guest execution was replayed to repair export.

ICU provenance is pinned in `runtime-lock.json` and copied into the archive under `lib/icu-provenance.json`: Debian package `libicu72=72.1-3+deb12u1` (amd64), extracted only from `docker.io/library/python@sha256:a5bab0ff300f91231c2e68bf73a8a8d60762ac39ce1c50eaf6803e4c38a9062b`. The three regular SONAME libraries and Debian copyright are individually checksum-verified. Both the constrained tool and guest validator set a fixed bundled library path. No host ICU bytes enter the archive.

The renderer accepts only HTTPS endpoints configured on port 443 and emits v2 immutable profiles. The Cloud network rule uses a hostname without a port because `hostname:443` does not match hostname access in the observed implementation. Hostname matching is not proof of port enforcement; documented DNS/UDP limitations also remain. Hosted allowed/denied traffic evidence belongs in the infrastructure/integration report.

Observed OfficeCLI 1.0.160 JSON differs by resident mode: nonresident returns `{success:true,data:{count:0,errors:[]}}`; resident success may contain the exact string `Validation passed: no errors found.`. Both observed success shapes are accepted; nonzero errors, contradictory errors or `success:false` fail. Workload commands always set `OFFICECLI_NO_AUTO_RESIDENT=1` so independent filesystem validation observes saved bytes.

Prototype provenance reviewed, not executed or imported wholesale:

| Attachment | SHA256 |
| --- | --- |
| `pi_demo.py` | `a3a28ef5e113dbc3dc86be189d326be998e196c047cbd2f2c80eb5b2949af7f7` |
| `docx_support.py` | `b0360943991e3fff6315c780710b3b35a46e34d91a835e398c7e2cf76a85185c` |
| `officecli_tool.ts` | `f7c287e52556387f6f00911505cda64b08cafc6a7b11c5d28e81aeb38786e8dc` |

The missing prototype helpers and source assets are documented in README. No missing runtime, template, output document or successful original prototype test is inferred from source inspection.
