# Workload verification

Recorded 3 November 2026 for workload candidate 0.1.0. This report is not Phase 1 or application readiness approval.

| Check | Executed scope | Result |
| --- | --- | --- |
| `npm ci --ignore-scripts` | Actual registry packages against npm integrity lock; no lifecycle scripts | Passed; zero reported npm vulnerabilities at installation |
| `npm test` | Two Node boundary tests and ten Python tests; actual archive/path/checksum/ZIP/XML/process/fence behavior and synthetic Pi event fixtures | Passed; model events are mocked |
| `python3 -m py_compile bootstrap.py build_runtime.py guest.py render_profile.py validation.py` | Python parsing | Passed |
| `python3 build_runtime.py` | Actual checksum-verified Node and OfficeCLI downloads and pinned npm dependency packaging | Passed; emitted archive and metadata under ignored output |
| Second independent bundle build | Re-downloaded pinned dependencies and installed into a fresh staging directory | Identical archive SHA256 `9ffbbd3ed2856013192049986f1062396e46461aa81998f607eaeda9acb3d033` (81,639,210 bytes) |
| `python3 tests/runtime-smoke.py --runtime output/runtime` | Actual Node 24.22.2, Pi 1.5.0, OfficeCLI 1.0.160; creates a synthetic DOCX, persists paragraph bytes, schema-checks, independently reads OOXML, loads and executes the constrained Pi extension | Passed; no model call |
| Invalid actual OfficeCLI document | Injected a synthetic invalid Word element; actual pinned OfficeCLI returned `success:false` with schema errors | Correctly rejected |
| Pi/LiteLLM/OfficeCLI on BoxLite Cloud | Not run by this package's implementation agent | Requires deployed services, key reference, approved network policy and hosted evidence |
| Rendered document layout, pagination, translation/content accuracy | Not performed | Unverified; no rendered-layout pass claimed |
| Required checkpoint export, safe stop, application restart and browser journey | Application/integration responsibility | Requires separate executed evidence |

Observed OfficeCLI 1.0.160 JSON differs by resident mode: nonresident returns `{success:true,data:{count:0,errors:[]}}`; resident success may contain the exact string `Validation passed: no errors found.`. Both observed success shapes are accepted; nonzero errors, contradictory errors or `success:false` fail. Workload commands always set `OFFICECLI_NO_AUTO_RESIDENT=1` so independent filesystem validation observes saved bytes.

Prototype provenance reviewed, not executed or imported wholesale:

| Attachment | SHA256 |
| --- | --- |
| `pi_demo.py` | `a3a28ef5e113dbc3dc86be189d326be998e196c047cbd2f2c80eb5b2949af7f7` |
| `docx_support.py` | `b0360943991e3fff6315c780710b3b35a46e34d91a835e398c7e2cf76a85185c` |
| `officecli_tool.ts` | `f7c287e52556387f6f00911505cda64b08cafc6a7b11c5d28e81aeb38786e8dc` |

The missing prototype helpers and source assets are documented in README. No missing runtime, template, output document or successful original prototype test is inferred from source inspection.
