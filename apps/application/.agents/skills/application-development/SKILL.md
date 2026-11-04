---
name: application-development
description: Build and verify the minimal authenticated request, list and result application as an HTTP consumer of reusable infrastructure.
---

1. Read root/application AGENTS, README, readiness and versioned Runner/Provider contracts. The continuation authorizes this minimal application while Phase 1 remains incomplete; do not claim stable readiness.
2. Keep scope to instructions plus permitted files, persistent paginated authorized requests, and text/file results with concise validation or actionable errors. Broader Phase 2 features are deferred.
3. Use server-owned auth, independent PostgreSQL and S3. Never import infrastructure source or query its databases. Parse external JSON with Zod; keep uploaded bytes outside PostgreSQL.
4. Persist admission/idempotency/attachment assignment/audit atomically. Use request rows as the durable outbox. Preserve exact request/sandbox/job references through retries.
5. Test ownership at request, attachment and download boundaries; cross-origin mutation rejection; changed submission conflict; immutable objects; pagination without hidden older requests.
6. Require transferred result identity, checksum/size/type checks, actual DOCX ZIP/XML parsing and saved sessions with the canonical `application/x-ndjson` descriptor before delivery. Record content and actual rendered-layout checks separately.
7. Test a lost submission response, worker recreation, event deduplication, missing/corrupt results, export before stop, and safe stop retries.
8. Use disposable `workflow_app_test` PostgreSQL and isolated RustFS: `node scripts/test-services.mjs up`, `npm test`. Tests drop only the explicit local test schema. Never target retained environments.
9. Run `npm run typecheck`, `npm run format:check`, `npm run build`, `npm run test:browser`. Browser plugin is absent here; Playwright verifies desktop/mobile submission → list → result/download with real DB/storage and test-only execution mocks.
10. Inspect diffs/secrets, update README/VERIFICATION, commit verified changes and hand off exact evidence. Separate mocked execution from hosted acceptance.
