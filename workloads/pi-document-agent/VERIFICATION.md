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
| Invalid actual OfficeCLI document (earlier candidate) | Injected a synthetic invalid Word element; pinned OfficeCLI returned `success:false` with schema errors | Correctly rejected; not rerun for rc2 |
| Pi/LiteLLM/OfficeCLI on BoxLite Cloud | Not run by this package's implementation agent | Requires deployed services, approved network policy and separately recorded hosted evidence |
| Rendered document layout, pagination, translation/content accuracy | Not performed | Unverified |
| Required checkpoint export, safe stop, application restart and browser journey | Application/integration responsibility | Requires separate executed evidence |

The exact local qualification image is `docker.io/library/python@sha256:e697c81897302a4c4333bade000d98038fbb21eb064f8ee1fd42d02ebcd9d337`. It is the cached slim guest image. The earlier host-only rc1 smoke did not detect missing ICU in that image; OfficeCLI startup subsequently failed there. rc2 packages ICU instead of enabling invariant globalization or changing to an uncached image. The successful local model preflight used Docker bridge networking and does not qualify the Cloud hostname policy, port restrictions or browser journey.

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
