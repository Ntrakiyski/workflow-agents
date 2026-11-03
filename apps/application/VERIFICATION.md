# Application verification — 3 November 2026

Version `0.1.0-rc.1`; branch `app/minimal-requests`, based on merged main `3f550ba95ca684aeea29a630675d33040724a961`. The application is a candidate. Phase 1 gates remain open; this report does not establish stable Phase 2 readiness.

| Executed check | Result and boundary |
| --- | --- |
| `npm run typecheck` | Passed strict server/React checks |
| `npm run format:check` | Passed source/frontend/tests |
| `npm run build` | Passed TypeScript/Vite production build |
| `npm audit --omit=dev` | Zero known dependency vulnerabilities |
| `npm test` | 10 passes, zero skips; actual independent PostgreSQL16 and RustFS S3 |
| S3 conditional write | Exact replay accepted; changed content refused; original bytes unchanged |
| Authentication/ownership | Missing Basic and cross-origin mutations denied; foreign request/attachment/output hidden; protected downloads verified |
| Durable admissions | Same submission returns same UUID; changed payload conflicts; cursor pagination preserves older requests |
| Dispatch recovery | Simulated Runner side effect then lost response; new worker uses durable keys and yields one logical execution |
| Safe delivery | Actual manifest/checksum/size verification; zero exit with missing output and corrupt checksum fail; required session saved to real S3 |
| Persistence/audit/stop | New API instance reads result; event deduplication/append-only audits; export precedes stop; stop failure cannot revoke delivery |
| DOCX structure | Actual ZIP/XML document accepted; duplicate parts, CRC corruption, malformed extra XML, wrong Word namespace/body, symlink and external/escaping relationships refused; no renderer executed |
| HTTP compatibility | Loopback mock validates Runner request against published schema, bearer/correlation/idempotency headers and bounded checksummed multichunk transfer |
| `npm run test:browser` | 2 passes: Chromium desktop1366×900 and mobile390×844; submit attachment → confirmation → result/download → list/reload → reopen |
| Browser console/layout | No JavaScript/console errors, framework overlay or horizontal overflow; screenshots inspected |

Browser plugin was absent. Playwright followed the frontend testing skill. Scratch screenshots outside Git: `/tmp/workflow-application-desktop.png`, `/tmp/workflow-application-mobile.png`; each shows the built result view. Inspection covered heading/status placement, typography, whitespace, readable validation copy, input/output links and mobile wrapping. Form/list interactions were exercised before screenshot capture. No concept/reference design was requested; the deliberate plain surface adds no dashboards or extra screens.

Runner, Provider and workload execution were mocked, including browser tests. PostgreSQL, S3 conditional writes/object bytes/checksums, HTTP transport and the browser build were real. Tests do **not** establish BoxLite Cloud transfer, hosted failure injection, Pi/LiteLLM/OfficeCLI success, actual rendered layout, application process/container replacement, off-host application restore, host reboot persistence or resource/load enforcement. Integration records those separately against exact deployed commits.

Independent QA additionally generated a synthetic DOCX with actual OfficeCLI 1.0.160 and `officecli validate` reported success with zero findings. The application controller accepted those same bytes after compatibility checks for internal OPC package-root relationships and effective Default/Override content-type declarations. This proves structural tool interoperability, not rendered layout or content accuracy.

The release integration additionally fixes PostgreSQL microsecond precision loss in request-list cursors. Eleven backend checks now pass, including same-millisecond requests, an exact timestamp tie, full pagination order and a foreign-owner row. Typecheck, format and build passed again. Before the fix, independent QA reproduced silently skipped older rows in a new disposable PostgreSQL16. The cursor now uses full-precision UTC text while the SQL tuple comparison remains timestamp/UUID based.

[GitHub application CI](https://github.com/Ntrakiyski/workflow-agents/actions/runs/41701442123) passed at `80d876e`:10backend,2checkpoint,5runtime-cache and2desktop/mobile browser tests, with actual PostgreSQL/RustFS and mocked execution. That run precedes the pagination correction; its source and scope remain distinct from the later regression run.
