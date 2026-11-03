# Hosted application browser qualification

This opt-in helper submits one synthetic document request through the real UI. It uses the application's installed `@playwright/test`/Chromium because the Browser plugin is absent. It does not configure Coolify, inspect service databases, install execution mocks or stop/destroy sandboxes. Confirm the application is deployed before running it; the operator separately records deployed commits, server audits and sandbox stop/export evidence.

The flow is authenticated entry → synthetic DOCX upload/submission → confirmation → persistent paginated request list/reload/reopen → actual completed result/download → independent Python ZIP/CRC/XML/relationship and exact-marker checks. It also checks immutable original bytes, same-key submission replay/changed-payload conflict, unauthorized/foreign-owner request and download denial, cross-origin rejection, console health and desktop/mobile wrapping. Exact marker preservation is a content check; it does not prove broad semantic accuracy or rendered document pagination.

## Credentials and fixture

Use a mode-600 private JSON file with either `primary: {username,password}` and `foreign: {username,password}` or the integration secret names `application_username`, `application_password`, `qa_username`, `qa_password`. Both accounts must already be configured on the application with different owners. The helper authenticates the foreign account before using it for negative checks; an absent account cannot produce a false ownership pass. Credentials never enter command-line arguments, reports, screenshots or saved browser state.

Create the fixture using the workload's already built, pinned OfficeCLI 1.0.160 binary. This uses synthetic text only and bypasses resident mode so saved bytes are observed directly:

```bash
qa_officecli=/absolute/path/to/workloads/pi-document-agent/output/runtime-final/officecli
qa_fixture_directory=$(mktemp -d /tmp/workflow-hosted-fixture-XXXXXX)
OFFICECLI_NO_AUTO_RESIDENT=1 "$qa_officecli" --version
OFFICECLI_NO_AUTO_RESIDENT=1 "$qa_officecli" create "$qa_fixture_directory/input.docx"
OFFICECLI_NO_AUTO_RESIDENT=1 "$qa_officecli" add "$qa_fixture_directory/input.docx" /body --type paragraph --prop 'text=Independent QA synthetic OfficeCLI fixture.'
OFFICECLI_NO_AUTO_RESIDENT=1 "$qa_officecli" validate "$qa_fixture_directory/input.docx" --json
```

Require the exact pinned version and a schema response with `success:true`, `count:0`, `errors:[]` before using that fixture. Do not substitute private documents or unreviewed templates.

## Run and resume

From the repository containing this helper, with application dependencies and its Playwright browser already installed:

```bash
node tests/qa/hosted_application_journey.mjs \
  --origin https://application.example.test \
  --credentials /absolute/private/release-secrets.json \
  --application-dir /absolute/path/to/apps/application \
  --input-docx "$qa_fixture_directory/input.docx" \
  --deployed-commit EXACT_APPLICATION_SOURCE_COMMIT \
  --timeout-seconds 1800
```

Only HTTPS origins are accepted except explicit loopback development addresses. The helper writes an ignored mode-600 `private/hosted-browser-<UUID>/state.json` before submission, records the request identity when acknowledged, and prints its path. A large runtime-bundle transfer can remain pending for many minutes; progress prints only safe request IDs/status. A failed or timed-out journey preserves state and never automatically submits another request. Retain the state even if the test fails.

Continue an acknowledged pending request with that same identity:

```bash
node tests/qa/hosted_application_journey.mjs \
  --origin https://application.example.test \
  --credentials /absolute/private/release-secrets.json \
  --application-dir /absolute/path/to/apps/application \
  --recheck-state /absolute/path/to/private/hosted-browser-UUID/state.json \
  --deployed-commit EXACT_APPLICATION_SOURCE_COMMIT \
  --timeout-seconds 1800
```

When a completed baseline exists, the same command after an operator-performed application replacement opens a fresh browser context, finds the existing request, and verifies unchanged output file ID, size and SHA256/downloaded bytes. It creates no request in this mode. Record the external replacement separately; a browser refresh alone is not replacement proof. If submission was dispatched but no request ID was captured, reconcile the private journal with the authorized request list before any further admission.

The default initial report is `docs/release/hosted-application-journey.json`; resume/replacement uses `docs/release/hosted-application-replacement.json`. `--report` selects another path to retain failed attempts. Screenshots are saved under `/tmp/workflow-hosted-<UUID>-*.png` and show only the controlled synthetic detail or its individual list row. Review generated JSON before committing evidence; keep state, credentials and binary downloads private.
