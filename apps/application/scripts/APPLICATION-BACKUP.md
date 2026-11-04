# Application checkpoint backup and isolated restore

`application-backup.mjs` runs inside the application image with its own PostgreSQL and S3 credentials. It does not import infrastructure services, query their databases, invoke BoxLite, alter Coolify backup destinations or access another application's storage.

Export includes all seven application tables (schema migrations 1 and 2, requests, files, audit, Runner events, user workspaces and user prompt settings), exact raw PostgreSQL JSON rows, column/constraint metadata, sequence state and every object referenced by `application.files`: originals, delivered files and exported Pi session checkpoints. Raw row strings preserve bigint audit identifiers without JavaScript number conversion. Per-table hashes verify all retained audit records and request identities.

The immutable runtime archive is excluded. Its object key/checksum are recorded from `RUNTIME_BUNDLE_OBJECT_KEY` and `RUNTIME_BUNDLE_SHA256`; reconstruct it from the approved published runtime release or independent-host immutable public runtime cache and verify that checksum separately before application use. The project puller retains that public bundle separately from this encrypted private checkpoint. Unreferenced orphan uploads are excluded. This checkpoint is not a full S3 inventory, guest disk image, Cloud clone or coordinated infrastructure registry restore.

## Runtime configuration

Required variables are the application's `DATABASE_URL`, `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, and a separate `APPLICATION_BACKUP_PASSWORD` of at least 32 characters. Keep the backup password in runtime-only secret configuration and retain a recovery copy separately from the encrypted archive. It is not the application login password and is never passed in command arguments or included in the envelope.

`APPLICATION_APP_ROOT` defaults to `/app`; it locates the installed application `pg` and AWS SDK dependencies. No extra npm package or schema migration is installed by the helper. Apply the same pinned application migrations to an isolated destination before restoration.

## Export

Run during a quiet window with `--quiescent`. The flag is an operator assertion; the helper also takes PostgreSQL SHARE locks on all application tables before reading the repeatable snapshot. Those locks prevent concurrent admission/worker metadata writes while row and immutable object bytes are collected. Pending/running requests, workspace provisioning/stopping, and retained sandboxes without confirmed stopping are rejected. Concurrent uncommitted S3 uploads without committed file rows are safely outside the checkpoint.

```sh
umask 077
node /app/scripts/application-backup.mjs --quiescent > /private/UNIQUE-APPLICATION-BACKUP.json
```

Use a unique destination and do not overwrite an existing backup. Successful stdout contains exactly one encrypted JSON envelope plus newline. Errors produce only a safe code on stderr and a nonzero exit; no plaintext or partial encrypted envelope is emitted. Copy the encrypted file off the GCC host, retain its SHA256 and record the pinned application commit separately. Protect both the file and recovery key under the operator's retention policy.

Bounds are 10 MiB per referenced object, 50 MiB total referenced object bytes, 1,000 objects, 20,000 rows per table and 8 MiB total row JSON. The encrypted stdout envelope is additionally limited to 64 MiB. An archive near the object ceiling may exceed that encoded bound and be rejected; no required file is silently omitted or truncated. Larger retained data requires a separately reviewed streaming/versioned backup format.

Database lock waits are limited to ten seconds and individual statements to fifteen seconds. Export has a 120-second collection budget, with S3 requests bounded to thirty seconds and aborted by the overall collection signal. A statement already running when the budget expires remains bounded by its fifteen-second server timeout. An idle transaction is terminated after 130 seconds. A failed operation rolls back and releases table locks.

## Envelope format version 1

The outer object has these exact fields:

```json
{
  "format": "workflow-agents-application-backup",
  "version": 1,
  "service": "application",
  "cipher": "aes-256-gcm",
  "kdf": "pbkdf2-hmac-sha256",
  "iterations": 600000,
  "compression": "gzip",
  "salt_b64": "BASE64-16-BYTES",
  "nonce_b64": "BASE64-12-BYTES",
  "tag_b64": "BASE64-16-BYTES",
  "ciphertext_b64": "BASE64-CIPHERTEXT"
}
```

A fresh salt and nonce are generated per archive. PBKDF2 derives the 32-byte AES key. GCM authenticates both the ciphertext and the JSON encoding of the ordered array `[format,version,service,cipher,kdf,iterations,compression,salt_b64,nonce_b64]` as associated data. Authentication succeeds before gzip decompression or snapshot interpretation. Parameters, base64 encodings, field set and expansion bounds are strict.

The decrypted gzip JSON snapshot uses format `workflow-agents-application-snapshot`, version 1, service `application`; it contains authenticated `application_version` from the exporting image's own package manifest, source database/bucket names, snapshot time, `tables`, `sequences`, `objects`, the excluded runtime descriptor and scope. Tables contain raw `rows` strings plus `row_count`/`rows_sha256`. Objects contain `object_key`, `size_bytes`, `sha256`, `media_type`, and `data_base64`. Never print or log this decrypted content. Earlier candidate envelopes without `application_version` are rejected; an exact source commit must still be recorded independently in the off-host manifest.

## Isolated restore

Provision a new isolated PostgreSQL database and isolated S3 bucket within the authorized project. Initialize the database with the same application migration version, then point this process's own database/storage variables to those resources. Both destination database name and bucket name must differ from the source checkpoint. Keep the destination application/worker quiescent throughout restoration and verification.

```sh
node /app/scripts/application-backup.mjs \
  --restore --isolated-destination --quiescent < /private/ENCRYPTED-APPLICATION-BACKUP.json
```

Restore requires matching table columns, constraints, migration versions and sequence names. It accepts an empty migrated destination or identical rows from an interrupted/replayed restore. The migration's bootstrap timestamp is reconciled to the source timestamp; audit triggers remain enabled. Extra/conflicting destination rows or unrelated object keys are rejected. A separately reconstructed exact runtime key may already exist in the target bucket; the application must independently verify its published checksum.

Objects use conditional `If-None-Match: *` publication. Existing identical bytes permit replay; conflicting bytes are never overwritten. Every restored object is read back and checksummed. Rows are inserted in foreign-key order with original identifiers and raw JSON precision. Every row count/hash, audit-history hash and sequence value is then verified.

PostgreSQL and object storage do not share a transaction. A failed restore can leave immutable objects in the isolated bucket while its database transaction rolls back. Retry the same authenticated archive; identical bytes and rows reconcile safely. PostgreSQL `setval` is not transactional, so keep the destination quiescent until successful return and replay after interruption. Never repoint live traffic based on a partial restore or assume this operation recreates a missing Cloud guest identity.

## Executed verification

Run the crypto negative test alone with:

```sh
node --test scripts/application-backup.test.mjs
```

For the real disposable drill, set `APPLICATION_APP_ROOT` to a built application checkout and `APPLICATION_BACKUP_TEST_CONFIG` to its private test-service configuration, then run that command. The drill creates uniquely named databases and RustFS buckets on the existing local disposable application test services. It never truncates the shared test database and removes only its newly created resources.

Executed on 3 November 2026: real PostgreSQL 16 plus RustFS restored synthetic input, result and session objects; verified row hashes, audit ID `9007199254740993`, sequence state and object checksums; replayed the same restore; rejected conflicting existing object bytes and a running source request; and proved a concurrent application metadata UPDATE times out while the export holds its table locks. Crypto tests rejected wrong passwords, ciphertext/header changes, weak passwords and extra envelope fields. This is local real database/object evidence, not proof of the deployed off-host schedule, disaster recovery or Cloud guest restoration.

## Verify a downloaded off-host archive

From a built release checkout, run the standalone verifier against an actual downloaded encrypted file. `APPLICATION_APP_ROOT` selects that checkout's application package, installed dependencies and compiled `dist/database.js`; no application worker is started.

```sh
APPLICATION_APP_ROOT=/ABSOLUTE/RELEASE/apps/application \
  node deploy/verify-application-restore.mjs \
  --archive /PRIVATE/BACKUP/application.encrypted.json \
  --credentials /PRIVATE/release-secrets.json \
  --storage-config /PRIVATE/LOCAL-TEST/config.json \
  --evidence /ABSOLUTE/NEW-EVIDENCE.json \
  --manifest /PRIVATE/BACKUP/manifest.json
```

The optional off-host manifest must contain exactly one application archive entry with the matching file SHA256 and a recorded 40-character deployed commit. Evidence labels that commit as coming from the supplied manifest; package version alone does not attest an exact source commit.

Credential and local test configuration files must be private mode 600 (or stricter). The verifier only permits loopback PostgreSQL configuration naming `workflow_app_test` and a loopback S3 endpoint. It creates a new random database and bucket, applies the release's own migrations, checks the authenticated source package version against the local package, restores twice and verifies the helper's exact row/object/audit/sequence evidence. It deletes only those newly created resources. Evidence is created with exclusive file creation and contains sanitized hashes/counts, package/migration versions, optional manifest source commit and cleanup outcome. It never writes decrypted rows, object bytes or passwords.

The verifier was exercised with a synthetic encrypted snapshot containing three real local RustFS objects and real PostgreSQL rows, including a bigint audit ID. It passed restore/replay/cleanup, rejected a different authenticated source package version before resource creation, and checked that evidence excludes fixture text, owners and secrets. Actual downloaded deployed archives require a separate executed report; this synthetic check does not claim that journey.

When a recovery set includes the independent-host public runtime cache, add `--runtime-cache /ABSOLUTE/CACHE/runtime-bundle.tar.gz`. The verifier checks the authenticated excluded-runtime SHA256, conditionally publishes those exact bytes into the newly created isolated bucket and hashes a fresh download. A supplied manifest also verifies its public profile inventory when present. This remains file reconstruction with the saved identities; it does not start a worker, resume Pi or recreate a Cloud VM.


## Shared-workspace schema compatibility

Application `0.2.0-rc.1` adds migration 2 without rewriting retained requests. The checkpoint now contains seven exact tables, including `user_workspaces` and `user_settings`, request system-prompt snapshots and workspace identities. The authenticated envelope format remains version 1, but exact source package, table shape and migration versions must match for restore. Historical five-table checkpoints are deliberately rejected by this helper. Restore those with the matching historical source/helper into isolation, then apply a separately reviewed forward migration. Do not describe a five-table restore as proof of the new workspace schema.
