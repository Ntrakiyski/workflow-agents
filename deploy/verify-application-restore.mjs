#!/usr/bin/env node
/** Restore an authenticated downloaded application archive into owned local fixtures. */
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { restore, s3Objects, unseal } from '../apps/application/scripts/application-backup.mjs';

const MAX_ARCHIVE = 64 * 1024 * 1024;
const sha = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw new Error('application_restore_' + code); };
const safeCode = error => /^(application_restore|application_backup)_[a-z_]+$/.test(error?.message ?? '')
  ? error.message : 'application_restore_operation_failed';

async function boundedFile(path, maxBytes, privateFile = false) {
  if (typeof path !== 'string' || !isAbsolute(path)) fail('absolute_file_required');
  const info = await stat(path);
  if (!info.isFile() || info.size > maxBytes || (privateFile && (info.mode & 0o077))) fail('input_file_invalid');
  const data = await readFile(path);
  if (data.length > maxBytes) fail('input_file_invalid');
  return data;
}
function localConfig(value) {
  const database = new URL(value.databaseUrl), endpoint = new URL(value.s3Endpoint);
  const loopback = hostname => ['127.0.0.1', 'localhost', '[::1]'].includes(hostname);
  if (!['postgres:', 'postgresql:'].includes(database.protocol) || !loopback(database.hostname)
    || database.pathname !== '/workflow_app_test' || !['http:', 'https:'].includes(endpoint.protocol)
    || !loopback(endpoint.hostname) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || typeof value.s3AccessKey !== 'string' || !value.s3AccessKey.length
    || typeof value.s3SecretKey !== 'string' || !value.s3SecretKey.length) fail('disposable_local_configuration_required');
  return { database, endpoint };
}

export async function verifyApplicationRestore(options) {
  if (!isAbsolute(options.evidence ?? '')) fail('absolute_evidence_required');
  const evidence = { version: 1, operation: 'application-offhost-isolated-restore-verification',
    recorded_at: new Date().toISOString(), outcome: 'failed',
    scope: 'application logical rows and exported immutable objects in new local PostgreSQL/RustFS resources; no worker, Cloud guest or host recovery',
    checks: {}, cleanup: { database: false, bucket: false } };
  let control, target, storage, sdk, createdDatabase = false, createdBucket = false;
  let databaseName, bucketName, error;
  try {
    const appRoot = process.env.APPLICATION_APP_ROOT;
    if (!isAbsolute(appRoot ?? '')) fail('absolute_application_root_required');
    const require = createRequire(appRoot + '/package.json');
    const packageInfo = require('./package.json');
    if (packageInfo.name !== '@workflow-agents/application') fail('application_package_required');
    const archive = await boundedFile(options.archive, MAX_ARCHIVE);
    evidence.source_envelope_sha256 = sha(archive);
    evidence.source_envelope_bytes = archive.length;
    const credentials = JSON.parse((await boundedFile(options.credentials, 1024 * 1024, true)).toString('utf8'));
    const snapshot = unseal(JSON.parse(archive.toString('utf8')), credentials.application_backup_password);
    evidence.checks.envelope_authenticated = true;
    if (snapshot.application_version !== packageInfo.version) fail('application_version_mismatch');
    evidence.application_version = packageInfo.version;
    evidence.checks.application_package_version = true;
    const migration = snapshot.tables.find(table => table.name === 'schema_migrations');
    evidence.source_migration_versions = migration.rows.map(raw => JSON.parse(raw).version).sort();
    if (JSON.stringify(evidence.source_migration_versions) !== '[1]') fail('migration_version_mismatch');
    if (options.manifest) {
      const rawManifest = await boundedFile(options.manifest, 8 * 1024 * 1024);
      const manifest = JSON.parse(rawManifest.toString('utf8'));
      const entries = manifest.archives?.filter(item => item.service === 'application');
      if (manifest.version !== 1 || manifest.outcome !== 'passed' || entries?.length !== 1
        || entries[0].sha256 !== evidence.source_envelope_sha256
        || !/^[a-f0-9]{40}$/.test(entries[0].deployed_commit ?? '')) fail('source_manifest_mismatch');
      evidence.source_manifest_sha256 = sha(rawManifest);
      evidence.deployed_commit_from_manifest = entries[0].deployed_commit;
      evidence.checks.supplied_manifest_archive_hash = true;
    }
    const config = JSON.parse((await boundedFile(options.storageConfig, 1024 * 1024, true)).toString('utf8'));
    const local = localConfig(config);
    const suffix = randomBytes(10).toString('hex');
    databaseName = 'workflow_restore_app_' + suffix;
    bucketName = 'workflow-restore-app-' + suffix;
    if (databaseName === snapshot.database || bucketName === snapshot.bucket) fail('destination_identity_collision');
    const { Client } = require('pg'); sdk = require('@aws-sdk/client-s3');
    const { Database } = await import(pathToFileURL(appRoot + '/dist/database.js').href);
    control = new Client({ connectionString: config.databaseUrl, connectionTimeoutMillis: 10000, query_timeout: 30000 });
    await control.connect();
    // Both names are generated internally; no preexisting database/bucket is adopted.
    await control.query('CREATE DATABASE "' + databaseName + '"'); createdDatabase = true;
    local.database.pathname = '/' + databaseName;
    const migrated = new Database(local.database.href);
    try { await migrated.migrate(); } finally { await migrated.pool.end(); }
    target = new Client({ connectionString: local.database.href, connectionTimeoutMillis: 10000, query_timeout: 60000 });
    await target.connect();
    storage = new sdk.S3Client({ endpoint: local.endpoint.href, region: config.s3Region || 'us-east-1',
      forcePathStyle: true, credentials: { accessKeyId: config.s3AccessKey, secretAccessKey: config.s3SecretKey }, maxAttempts: 3 });
    await storage.send(new sdk.CreateBucketCommand({ Bucket: bucketName }), { abortSignal: AbortSignal.timeout(30000) });
    createdBucket = true;
    const objects = s3Objects(sdk, storage, bucketName);
    const restoreOptions = { bucket: bucketName, isolatedDestination: true };
    const first = await restore(target, objects, snapshot, restoreOptions);
    const second = await restore(target, objects, snapshot, restoreOptions);
    if (JSON.stringify(first) !== JSON.stringify(second)) fail('restore_replay_mismatch');
    evidence.checks = { ...evidence.checks, isolated_new_resources: true,
      matching_schema_and_migration: true, exact_row_digests: true,
      audit_identifiers_and_history: true, object_sizes_and_checksums: true,
      sequence_values: true, repeated_restore: true };
    evidence.tables = first.tables;
    evidence.objects = first.objects;
    evidence.object_bytes = first.object_bytes;
    evidence.audit_history_sha256 = first.audit_history_sha256;
    evidence.sequences = first.sequences;
  } catch (caught) { error = caught; evidence.error_classification = safeCode(caught); }
  finally {
    await target?.end().catch(caught => { error ??= caught; });
    if (createdBucket) {
      try {
        let token;
        do {
          const page = await storage.send(new sdk.ListObjectsV2Command({ Bucket: bucketName, ContinuationToken: token, MaxKeys: 1000 }),
            { abortSignal: AbortSignal.timeout(30000) });
          for (const object of page.Contents ?? []) {
            await storage.send(new sdk.DeleteObjectCommand({ Bucket: bucketName, Key: object.Key }),
              { abortSignal: AbortSignal.timeout(30000) });
          }
          token = page.IsTruncated ? page.NextContinuationToken : undefined;
          if (page.IsTruncated && !token) fail('cleanup_inventory_invalid');
        } while (token);
        await storage.send(new sdk.DeleteBucketCommand({ Bucket: bucketName }), { abortSignal: AbortSignal.timeout(30000) });
        evidence.cleanup.bucket = true;
      } catch (caught) { error ??= caught; evidence.cleanup_error_classification = 'application_restore_bucket_cleanup_failed'; }
    }
    if (createdDatabase) {
      try {
        await control.query('DROP DATABASE "' + databaseName + '"'); evidence.cleanup.database = true;
      } catch (caught) { error ??= caught; evidence.cleanup_error_classification = 'application_restore_database_cleanup_failed'; }
    }
    await control?.end().catch(caught => { error ??= caught; }); storage?.destroy();
    if (!error && evidence.cleanup.database && evidence.cleanup.bucket) evidence.outcome = 'passed';
    else evidence.error_classification ??= safeCode(error);
    await writeFile(options.evidence, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o644, flag: 'wx' });
  }
  return evidence;
}

function argumentsFrom(argv) {
  const map = new Map(), allowed = new Set(['--archive', '--credentials', '--storage-config', '--evidence', '--manifest']);
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index], value = argv[index + 1];
    if (!allowed.has(name) || map.has(name) || !value || !isAbsolute(value)) fail('arguments_invalid');
    map.set(name, value);
  }
  for (const name of ['--archive', '--credentials', '--storage-config', '--evidence']) if (!map.has(name)) fail('arguments_invalid');
  return { archive: map.get('--archive'), credentials: map.get('--credentials'),
    storageConfig: map.get('--storage-config'), evidence: map.get('--evidence'), manifest: map.get('--manifest') };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await verifyApplicationRestore(argumentsFrom(process.argv.slice(2)));
    process.stdout.write(JSON.stringify({ operation: result.operation, outcome: result.outcome,
      source_envelope_sha256: result.source_envelope_sha256, objects: result.objects,
      error_classification: result.error_classification }) + '\n');
    if (result.outcome !== 'passed') process.exitCode = 1;
  } catch (error) {
    process.stderr.write(JSON.stringify({ operation: 'application-offhost-isolated-restore-verification',
      outcome: 'failed', error_classification: safeCode(error) }) + '\n');
    process.exitCode = 1;
  }
}
