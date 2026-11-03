# Agent instructions — minimal request application

Read root `AGENTS.md`, the current readiness record, this README and local development/operations skills. The 3 November continuation authorizes application scaffolding while infrastructure gates remain incomplete and narrows the initial release to submission, authorized request list, and result retrieval. The broader Phase 2 document remains background; its extra screens and revision flows are deferred.

Own only `apps/application/**`. React/TypeScript + Fastify, its own PostgreSQL schema/credentials and application-owned S3 storage. Never import service source, BoxLite or infrastructure database credentials. Submit work through the published Runner API; Provider HTTP APIs prepare the retained sandbox and transfer bounded files. External clients never receive service credentials.

Use the local development skill for changes and operations skill before deployment/recovery. Root owns integration, generic contract review, release gating and GCC resource mutations. Current version is `0.1.0-rc.1`, not a stable Phase 2 release.

- Identity comes from server-configured authenticated accounts. Browser input never chooses the owner. Every request, attachment and result download is owner scoped; missing and foreign resources return 404.
- Mutations require the configured Origin to protect ambient Basic credentials. Expose only HTTPS application; keep APIs, databases and storage private.
- Request row, owner-scoped submission key, attachment assignment and audit commit together. The row is the durable dispatch outbox. Stable Runner/Provider keys survive ambiguous responses. Never blindly replay uncertain work with fresh execution identity.
- Originals, final artifacts and required session checkpoints use immutable object keys and conditional S3 writes. DB stores metadata, never file bodies. Output downloads remain hidden until validated export completes.
- Exit zero is insufficient. Verify transferred manifest request identity, bytes/checksums/types and actual ZIP/XML DOCX structure; require a saved session. Structural checks do not prove content accuracy or rendered layout.
- Stop only the same retained sandbox after all successful output/session exports are durable. A stop failure retries independently and cannot revoke a delivered result. No automatic destroy exists.
- Do not add dashboards, chat, approval/clarification screens, feedback/revision flows, account administration, skill management, editors or infrastructure controls.
- Logs/audits contain safe identifiers, action and outcome; never instructions, document text, secrets or native dependency errors.

Tests require a **dedicated disposable local database named `workflow_app_test`** and isolated object storage. `npm test` drops that database's `application` schema. Never target staging or a retained restore. `node scripts/test-services.mjs up` creates only labeled test containers and refuses replacement. No test fake can be enabled by production configuration.

Production Docker context is this directory alone. Exact npm dependencies are locked. Verified checks: `npm run typecheck`, `npm run format:check`, `npm test`, `npm run build`, `npm run test:browser`. Browser tests use real PostgreSQL/RustFS plus test-only execution services; they do not prove hosted BoxLite, LiteLLM or OfficeCLI.
