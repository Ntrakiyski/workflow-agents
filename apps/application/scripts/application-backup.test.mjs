import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { collect, restore, s3Objects, seal, unseal } from './application-backup.mjs';
import { verifyApplicationRestore } from '../../../deploy/verify-application-restore.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const empty = () => ({ format: 'workflow-agents-application-snapshot', version: 1, service: 'application',
  application_version: '0.1.0-rc.1',
  database: 'source', bucket: 'source', tables: ['audit', 'files', 'requests', 'runner_events', 'schema_migrations']
    .map(name => ({ name, columns: [], constraints: [], rows: [], row_count: 0, rows_sha256: sha('') })),
  objects: [], sequences: [] });

test('authenticated encrypted archives reject tampering, wrong passwords and changed metadata', () => {
  const password = randomBytes(32).toString('hex');
  const snapshot = empty();
  const envelope = seal(snapshot, password);
  assert.deepEqual(unseal(envelope, password), snapshot);
  assert.notEqual(seal(snapshot, password).ciphertext_b64, envelope.ciphertext_b64);
  assert.throws(() => unseal(envelope, randomBytes(32).toString('hex')));
  assert.throws(() => seal(snapshot, 'short'));
  assert.throws(() => unseal({ ...envelope, iterations: 1 }, password));
  const data = Buffer.from(envelope.ciphertext_b64, 'base64'); data[0] ^= 1;
  assert.throws(() => unseal({ ...envelope, ciphertext_b64: data.toString('base64') }, password));
  assert.throws(() => unseal({ ...envelope, extra: true }, password));
});

test('real isolated PostgreSQL and RustFS restore retains bytes, bigint audits and replay safety',
  { skip: !process.env.APPLICATION_BACKUP_TEST_CONFIG, timeout: 120000 }, async () => {
    const root = process.env.APPLICATION_APP_ROOT;
    assert.ok(root, 'APPLICATION_APP_ROOT required for real drill');
    const config = JSON.parse(await readFile(process.env.APPLICATION_BACKUP_TEST_CONFIG, 'utf8'));
    const require = createRequire(root + '/package.json');
    const { Client } = require('pg'), sdk = require('@aws-sdk/client-s3');
    const applicationVersion = require('./package.json').version;
    const { Database } = await import(pathToFileURL(root + '/dist/database.js').href);
    const suffix = randomBytes(6).toString('hex');
    const databases = ['source', 'restore', 'conflict'].map(stage => `workflow_backup_${stage}_${suffix}`);
    const buckets = ['source', 'restore', 'conflict'].map(stage => `workflow-backup-${stage}-${suffix}`);
    const control = new Client({ connectionString: config.databaseUrl });
    const storage = new sdk.S3Client({ endpoint: config.s3Endpoint, region: config.s3Region,
      forcePathStyle: true, credentials: { accessKeyId: config.s3AccessKey, secretAccessKey: config.s3SecretKey } });
    const clients = [], createdDbs = [], createdBuckets = [];
    try {
      await control.connect();
      for (let index = 0; index < databases.length; index++) {
        await control.query('CREATE DATABASE "' + databases[index] + '"'); createdDbs.push(databases[index]);
        const url = new URL(config.databaseUrl); url.pathname = '/' + databases[index];
        const db = new Database(url.href); await db.migrate(); await db.pool.end();
        const client = new Client({ connectionString: url.href }); await client.connect(); clients.push(client);
        await storage.send(new sdk.CreateBucketCommand({ Bucket: buckets[index] })); createdBuckets.push(buckets[index]);
      }
      const [source, target, conflict] = clients;
      const requestId = randomUUID();
      await source.query(`INSERT INTO application.requests(id,owner_id,title,instructions,status,submission_key,fingerprint,correlation_id,sandbox_id,export_complete,sandbox_stopped) VALUES($1,'backup-owner','Synthetic backup fixture','Synthetic instructions','completed','backup-submission','fingerprint','correlation','sbx_fixture',true,true)`, [requestId]);
      const files = [
        { kind: 'input', name: 'source.txt', media: 'text/plain', data: Buffer.from('Original input remains unchanged.') },
        { kind: 'output', name: 'result.md', media: 'text/markdown', data: Buffer.from('# Synthetic result\n') },
        { kind: 'checkpoint', name: 'session.jsonl', media: 'application/x-ndjson', data: Buffer.from('{"synthetic_session":true}\n') },
      ];
      const sourceObjects = s3Objects(sdk, storage, buckets[0]);
      for (const file of files) {
        file.key = requestId + '/' + file.kind + '/' + file.name;
        await sourceObjects.put(file.key, file.data, file.media, sha(file.data));
        await source.query('INSERT INTO application.files(id,owner_id,request_id,kind,name,media_type,size_bytes,sha256,object_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
          [randomUUID(), 'backup-owner', requestId, file.kind, file.name, file.media, file.data.length, sha(file.data), file.key]);
      }
      await source.query(`INSERT INTO application.audit(event_id,request_id,owner_id,actor_id,action,correlation_id) VALUES(9007199254740993,$1,'backup-owner','test-actor','request.exported','correlation')`, [requestId]);
      await source.query("SELECT setval('application.audit_event_id_seq',9007199254740993,true)");
      await source.query("INSERT INTO application.runner_events(request_id,event_id,event_type) VALUES($1,'evt_fixture','job.completed')", [requestId]);
      const snapshot = await collect(source, sourceObjects, { bucket: buckets[0], runtimeKey: 'runtime/approved.tar.gz', runtimeSha256: 'a'.repeat(64), applicationVersion });
      assert.equal(snapshot.objects.length, 3);
      assert.equal(snapshot.sequences[0].last_value, '9007199254740993');
      const password = randomBytes(32).toString('hex');
      const decrypted = unseal(seal(snapshot, password), password);
      const fixture = await mkdtemp(join(tmpdir(), 'workflow-restore-verifier-'));
      try {
        const archive = join(fixture, 'application.encrypted.json');
        const credentials = join(fixture, 'credentials.json');
        const evidence = join(fixture, 'evidence.json');
        const manifest = join(fixture, 'manifest.json');
        const raw = JSON.stringify(seal(snapshot, password)) + '\n';
        await writeFile(archive, raw, { mode: 0o600 });
        await writeFile(credentials, JSON.stringify({ application_backup_password: password }), { mode: 0o600 });
        await writeFile(manifest, JSON.stringify({ version: 1, outcome: 'passed', archives: [
          { service: 'application', sha256: sha(raw), deployed_commit: 'a'.repeat(40) } ] }), { mode: 0o600 });
        const checked = await verifyApplicationRestore({ archive, credentials, evidence, manifest,
          storageConfig: process.env.APPLICATION_BACKUP_TEST_CONFIG });
        assert.equal(checked.outcome, 'passed'); assert.equal(checked.objects, 3);
        assert.equal(checked.source_envelope_sha256, sha(raw));
        assert.deepEqual(checked.cleanup, { database: true, bucket: true });
        const publicEvidence = await readFile(evidence, 'utf8');
        for (const secret of [password, 'Original input remains unchanged.', 'backup-owner', config.s3SecretKey])
          assert.equal(publicEvidence.includes(secret), false);
        await writeFile(archive, JSON.stringify(seal({ ...snapshot, application_version: '999.0.0' }, password)), { mode: 0o600 });
        const mismatch = await verifyApplicationRestore({ archive, credentials,
          evidence: join(fixture, 'mismatch.json'), storageConfig: process.env.APPLICATION_BACKUP_TEST_CONFIG });
        assert.equal(mismatch.outcome, 'failed');
        assert.equal(mismatch.error_classification, 'application_restore_application_version_mismatch');
        assert.deepEqual(mismatch.cleanup, { database: false, bucket: false });
      } finally { await rm(fixture, { recursive: true, force: true }); }
      const targetObjects = s3Objects(sdk, storage, buckets[1]);
      await assert.rejects(restore(target, targetObjects, decrypted, { bucket: buckets[1] }), /isolated_destination/);
      const options = { bucket: buckets[1], isolatedDestination: true };
      const report = await restore(target, targetObjects, decrypted, options);
      assert.equal(report.outcome, 'passed'); assert.equal(report.objects, 3);
      assert.equal((await target.query('SELECT event_id::text FROM application.audit')).rows[0].event_id, '9007199254740993');
      assert.deepEqual(await restore(target, targetObjects, decrypted, options), report);
      for (const file of files) assert.deepEqual(await targetObjects.get(file.key, file.data.length), file.data);
      const conflictingObjects = s3Objects(sdk, storage, buckets[2]);
      await conflictingObjects.put(files[0].key, Buffer.from('bad'), 'text/plain', sha('bad'));
      await assert.rejects(restore(conflict, conflictingObjects, decrypted, { bucket: buckets[2], isolatedDestination: true }));
      assert.equal((await conflict.query('SELECT count(*)::int AS count FROM application.requests')).rows[0].count, 0);
      await source.query("UPDATE application.requests SET status='running' WHERE id=$1", [requestId]);
      await assert.rejects(collect(source, sourceObjects, { bucket: buckets[0], applicationVersion }), /source_not_quiescent/);
      await source.query("UPDATE application.requests SET status='completed' WHERE id=$1", [requestId]);
      // The export holds table locks while object bytes are read: concurrent admission is refused.
      const url = new URL(config.databaseUrl); url.pathname = '/' + databases[0];
      const competing = new Client({ connectionString: url.href }); await competing.connect();
      try {
        await competing.query("SET lock_timeout='100ms'");
        let attempted = false;
        const observed = { ...sourceObjects, async get(...args) {
          if (!attempted) {
            attempted = true;
            await assert.rejects(competing.query('UPDATE application.requests SET title=title WHERE id=$1', [requestId]), error => error.code === '55P03');
          }
          return sourceObjects.get(...args);
        } };
        await collect(source, observed, { bucket: buckets[0], applicationVersion }); assert.equal(attempted, true);
      } finally { await competing.end(); }
      process.stdout.write(JSON.stringify({ operation: 'application-backup-real-drill', outcome: 'passed',
        resources: 'independent disposable PostgreSQL databases and RustFS buckets', objects: 3,
        checks: ['encrypted_roundtrip', 'row_digests', 'bigint_audit_identity', 'object_checksums', 'sequence_state', 'idempotent_restore', 'no_overwrite_conflict', 'quiescent_denial', 'concurrent_write_fence'] }) + '\n');
    } finally {
      for (const client of clients) await client.end().catch(() => {});
      for (const bucket of createdBuckets) {
        const listed = await storage.send(new sdk.ListObjectsV2Command({ Bucket: bucket }));
        for (const object of listed.Contents ?? []) await storage.send(new sdk.DeleteObjectCommand({ Bucket: bucket, Key: object.Key }));
        await storage.send(new sdk.DeleteBucketCommand({ Bucket: bucket }));
      }
      for (const name of createdDbs) await control.query('DROP DATABASE "' + name + '"');
      await control.end(); storage.destroy();
    }
  });
