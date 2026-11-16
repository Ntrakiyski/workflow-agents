#!/usr/bin/env node
/** Application-owned logical rows + referenced object checkpoint, never VM disks. */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createCipheriv, createDecipheriv, createHash, pbkdf2Sync, randomBytes } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';

const FORMAT = 'workflow-agents-application-backup';
const ITERATIONS = 600000;
const MiB = 1024 * 1024;
const MAX_ENVELOPE = 64 * MiB;
const MAX_PLAINTEXT = 96 * MiB;
const MAX_FILE = 10 * MiB;
const MAX_OBJECTS = 50 * MiB;
const MAX_ROWS_BYTES = 8 * MiB;
const TABLES = ['audit', 'files', 'requests', 'runner_events', 'schema_migrations'];
const INSERT_ORDER = ['schema_migrations', 'requests', 'files', 'audit', 'runner_events'];
const q = value => '"' + value.replaceAll('"', '""') + '"';
const fail = code => { throw new Error('application_backup_' + code); };
const sha = value => createHash('sha256').update(value).digest('hex');
const rowsDigest = rows => sha(rows.join('\n'));
const header = envelope => JSON.stringify([envelope.format, envelope.version, envelope.service,
  envelope.cipher, envelope.kdf, envelope.iterations, envelope.compression,
  envelope.salt_b64, envelope.nonce_b64]);

function passwordCheck(password) {
  if (typeof password !== 'string' || password.length < 32 || password.length > 4096) fail('password_invalid');
}
function decode(value, max) {
  if (typeof value !== 'string' || value.length > Math.ceil(max / 3) * 4) fail('envelope_invalid');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > max || bytes.toString('base64') !== value) fail('envelope_invalid');
  return bytes;
}

export function seal(snapshot, password) {
  passwordCheck(password);
  const plain = Buffer.from(JSON.stringify(snapshot));
  if (plain.length > MAX_PLAINTEXT) fail('plaintext_too_large');
  const salt = randomBytes(16), nonce = randomBytes(12);
  const envelope = { format: FORMAT, version: 1, service: 'application', cipher: 'aes-256-gcm',
    kdf: 'pbkdf2-hmac-sha256', iterations: ITERATIONS, compression: 'gzip',
    salt_b64: salt.toString('base64'), nonce_b64: nonce.toString('base64') };
  const key = pbkdf2Sync(password, salt, ITERATIONS, 32, 'sha256');
  try {
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(header(envelope)));
    const ciphertext = Buffer.concat([cipher.update(gzipSync(plain)), cipher.final()]);
    envelope.tag_b64 = cipher.getAuthTag().toString('base64');
    envelope.ciphertext_b64 = ciphertext.toString('base64');
    if (Buffer.byteLength(JSON.stringify(envelope)) + 1 > MAX_ENVELOPE) fail('envelope_too_large');
    return envelope;
  } finally { key.fill(0); }
}

export function unseal(envelope, password) {
  passwordCheck(password);
  if (!envelope || envelope.format !== FORMAT || envelope.version !== 1 || envelope.service !== 'application'
    || envelope.cipher !== 'aes-256-gcm' || envelope.kdf !== 'pbkdf2-hmac-sha256'
    || envelope.iterations !== ITERATIONS || envelope.compression !== 'gzip'
    || Object.keys(envelope).sort().join(',') !== 'cipher,ciphertext_b64,compression,format,iterations,kdf,nonce_b64,salt_b64,service,tag_b64,version'
    || Buffer.byteLength(JSON.stringify(envelope)) + 1 > MAX_ENVELOPE) fail('envelope_invalid');
  const salt = decode(envelope.salt_b64, 16), nonce = decode(envelope.nonce_b64, 12);
  const tag = decode(envelope.tag_b64, 16), ciphertext = decode(envelope.ciphertext_b64, 48 * MiB);
  if (salt.length !== 16 || nonce.length !== 12 || tag.length !== 16 || !ciphertext.length) fail('envelope_invalid');
  const key = pbkdf2Sync(password, salt, ITERATIONS, 32, 'sha256');
  try {
    const cipher = createDecipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(header(envelope))); cipher.setAuthTag(tag);
    const compressed = Buffer.concat([cipher.update(ciphertext), cipher.final()]);
    const snapshot = JSON.parse(gunzipSync(compressed, { maxOutputLength: MAX_PLAINTEXT }).toString('utf8'));
    validateSnapshot(snapshot);
    return snapshot;
  } catch { fail('authentication_or_payload_invalid'); }
  finally { key.fill(0); }
}

async function catalog(client) {
  const names = (await client.query("SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='application' AND c.relkind IN ('r','p') AND NOT c.relispartition ORDER BY c.relname")).rows.map(row => row.name);
  if (JSON.stringify(names) !== JSON.stringify(TABLES)) fail('schema_mismatch');
  const tables = [];
  for (const name of names) {
    const columns = (await client.query("SELECT a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS not_null,a.attidentity AS identity,a.attgenerated AS generated FROM pg_attribute a WHERE a.attrelid=$1::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum", ['application.' + name])).rows;
    const constraints = (await client.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=$1::regclass ORDER BY conname", ['application.' + name])).rows;
    tables.push({ name, columns, constraints });
  }
  const sequences = (await client.query("SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='application' AND c.relkind='S' ORDER BY c.relname")).rows;
  return { tables, sequences };
}
async function readSequences(client, names) {
  const result = [];
  for (const { name } of names) {
    const row = (await client.query(`SELECT last_value::text AS last_value,is_called FROM application.${q(name)}`)).rows[0];
    result.push({ name, ...row });
  }
  return result;
}
async function rows(client, name) {
  const capacity = (await client.query(`SELECT count(*)::text AS count,coalesce(sum(octet_length(to_jsonb(t)::text)),0)::text AS bytes FROM application.${q(name)} t`)).rows[0];
  if (BigInt(capacity.count) > 20000n || BigInt(capacity.bytes) > BigInt(MAX_ROWS_BYTES)) fail('row_limit_exceeded');
  return (await client.query(`SELECT to_jsonb(t)::text AS row_json FROM application.${q(name)} t ORDER BY to_jsonb(t)::text COLLATE "C"`)).rows.map(row => row.row_json);
}
function assertQuiescent(requests) {
  for (const raw of requests) {
    const row = JSON.parse(raw);
    if (!['completed', 'failed'].includes(row.status) || (row.sandbox_id && !row.sandbox_stopped)) fail('source_not_quiescent');
  }
}
function referencedFiles(tables) {
  const result = new Map(); let total = 0;
  for (const raw of tables.find(table => table.name === 'files').rows) {
    const file = JSON.parse(raw);
    if (!['input', 'output', 'checkpoint'].includes(file.kind) || typeof file.object_key !== 'string'
      || !file.object_key.length || file.object_key.length > 1024 || file.object_key.includes('\0')
      || !Number.isSafeInteger(file.size_bytes) || file.size_bytes < 0 || file.size_bytes > MAX_FILE
      || !/^[a-f0-9]{64}$/.test(file.sha256) || typeof file.media_type !== 'string') fail('file_manifest_invalid');
    if (result.has(file.object_key)) fail('duplicate_object_reference');
    result.set(file.object_key, { object_key: file.object_key, size_bytes: file.size_bytes,
      sha256: file.sha256, media_type: file.media_type });
    total += file.size_bytes;
    if (total > MAX_OBJECTS || result.size > 1000) fail('object_limit_exceeded');
  }
  return result;
}
function validateSnapshot(snapshot) {
  if (!snapshot || snapshot.format !== 'workflow-agents-application-snapshot' || snapshot.version !== 1 || snapshot.service !== 'application'
    || typeof snapshot.application_version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(snapshot.application_version)
    || typeof snapshot.database !== 'string' || typeof snapshot.bucket !== 'string'
    || !Array.isArray(snapshot.tables) || snapshot.tables.length !== TABLES.length
    || !Array.isArray(snapshot.sequences) || !Array.isArray(snapshot.objects)
    || JSON.stringify(snapshot.tables.map(table => table.name)) !== JSON.stringify(TABLES)) fail('snapshot_invalid');
  let totalRowsBytes = 0;
  for (const table of snapshot.tables) {
    if (!Array.isArray(table.columns) || !Array.isArray(table.constraints) || !Array.isArray(table.rows)
      || table.rows.some(raw => typeof raw !== 'string') || table.row_count !== table.rows.length
      || rowsDigest(table.rows) !== table.rows_sha256) fail('snapshot_rows_invalid');
    totalRowsBytes += table.rows.reduce((sum, raw) => sum + Buffer.byteLength(raw), 0);
    if (totalRowsBytes > MAX_ROWS_BYTES) fail('row_limit_exceeded');
  }
  assertQuiescent(snapshot.tables.find(table => table.name === 'requests').rows);
  const files = referencedFiles(snapshot.tables);
  if (snapshot.objects.length !== files.size) fail('snapshot_objects_invalid');
  const seen = new Set();
  for (const object of snapshot.objects) {
    const expected = files.get(object.object_key);
    if (!expected || seen.has(object.object_key) || object.sha256 !== expected.sha256
      || object.size_bytes !== expected.size_bytes || object.media_type !== expected.media_type) fail('snapshot_objects_invalid');
    seen.add(object.object_key);
    const data = decode(object.data_base64, MAX_FILE);
    if (data.length !== object.size_bytes || sha(data) !== object.sha256) fail('object_checksum_mismatch');
  }
  for (const sequence of snapshot.sequences) {
    if (typeof sequence.name !== 'string' || !/^[a-z_][a-z0-9_]*$/.test(sequence.name)
      || typeof sequence.last_value !== 'string' || !/^\d+$/.test(sequence.last_value)
      || typeof sequence.is_called !== 'boolean') fail('sequence_invalid');
  }
}

export async function collect(client, objects, { bucket, runtimeKey, runtimeSha256, applicationVersion } = {}) {
  if (typeof bucket !== 'string' || !bucket.length) fail('bucket_required');
  if (typeof applicationVersion !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(applicationVersion)) fail('application_version_required');
  if (runtimeKey && (typeof runtimeSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(runtimeSha256))) fail('runtime_checksum_required');
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  const signal = AbortSignal.timeout(120000);
  try {
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    await client.query("SET LOCAL lock_timeout='10s'");
    await client.query("SET LOCAL statement_timeout='15s'");
    await client.query("SET LOCAL idle_in_transaction_session_timeout='130s'");
    await client.query('LOCK TABLE ' + TABLES.map(name => 'application.' + q(name)).join(',') + ' IN SHARE MODE');
    const info = await catalog(client);
    const before = await readSequences(client, info.sequences), tables = []; let rowsBytes = 0;
    for (const table of info.tables) {
      signal.throwIfAborted();
      const data = await rows(client, table.name);
      rowsBytes += data.reduce((sum, raw) => sum + Buffer.byteLength(raw), 0);
      if (rowsBytes > MAX_ROWS_BYTES) fail('row_limit_exceeded');
      tables.push({ ...table, row_count: data.length, rows_sha256: rowsDigest(data), rows: data });
    }
    assertQuiescent(tables.find(table => table.name === 'requests').rows);
    const files = referencedFiles(tables), data = [];
    for (const file of files.values()) {
      signal.throwIfAborted();
      if (runtimeKey && file.object_key === runtimeKey) fail('runtime_reference_in_user_files');
      const bytes = await objects.get(file.object_key, file.size_bytes, { signal });
      if (bytes.length !== file.size_bytes || sha(bytes) !== file.sha256) fail('source_object_checksum_mismatch');
      data.push({ ...file, data_base64: bytes.toString('base64') });
    }
    const after = await readSequences(client, info.sequences);
    signal.throwIfAborted();
    if (JSON.stringify(before) !== JSON.stringify(after)) fail('sequence_activity');
    const meta = (await client.query('SELECT current_database() AS database,transaction_timestamp()::text AS snapshot_at')).rows[0];
    await client.query('COMMIT');
    const snapshot = { format: 'workflow-agents-application-snapshot', version: 1, service: 'application',
      application_version: applicationVersion, ...meta, bucket, tables, sequences: after, objects: data,
      excluded_runtime: runtimeKey ? { object_key: runtimeKey, sha256: runtimeSha256,
        strategy: 'reconstruct from approved published checksum-verified runtime release' } : null,
      scope: 'application rows, immutable referenced objects and exported session files; no Cloud guest disk or infrastructure database' };
    validateSnapshot(snapshot);
    return snapshot;
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
}

export async function restore(client, objects, snapshot, { bucket, isolatedDestination = false } = {}) {
  validateSnapshot(snapshot);
  if (!isolatedDestination || typeof bucket !== 'string' || !bucket.length || bucket === snapshot.bucket) fail('isolated_destination_required');
  const database = (await client.query('SELECT current_database() AS database')).rows[0].database;
  if (database === snapshot.database) fail('isolated_destination_required');
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  try {
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    await client.query("SET LOCAL lock_timeout='10s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('application-backup-restore',0))");
    const info = await catalog(client);
    if (JSON.stringify(info.tables) !== JSON.stringify(snapshot.tables.map(({ name, columns, constraints }) => ({ name, columns, constraints })))
      || JSON.stringify(info.sequences.map(sequence => sequence.name)) !== JSON.stringify(snapshot.sequences.map(sequence => sequence.name))) fail('destination_schema_mismatch');
    await client.query('LOCK TABLE ' + TABLES.map(name => 'application.' + q(name)).join(',') + ' IN ACCESS EXCLUSIVE MODE');
    for (const table of snapshot.tables) {
      const current = await rows(client, table.name);
      if (table.name === 'schema_migrations') {
        const source = table.rows.map(raw => JSON.parse(raw).version).sort();
        const target = current.map(raw => JSON.parse(raw).version).sort();
        if (JSON.stringify(source) !== JSON.stringify(target)) fail('destination_migration_mismatch');
      } else {
        const allowed = new Set(table.rows);
        if (current.some(raw => !allowed.has(raw))) fail('destination_rows_conflict');
      }
    }
    if (typeof objects.assertOnlyKeys !== 'function') fail('destination_inventory_required');
    await objects.assertOnlyKeys(new Set([...snapshot.objects.map(object => object.object_key),
      ...(snapshot.excluded_runtime?.object_key ? [snapshot.excluded_runtime.object_key] : [])]));
    // Objects are immutable conditional writes. Partial object uploads survive a rollback;
    // replay verifies identical bytes and never overwrites a conflicting key.
    for (const object of snapshot.objects) {
      const data = decode(object.data_base64, MAX_FILE);
      await objects.put(object.object_key, data, object.media_type, object.sha256);
      const restored = await objects.get(object.object_key, object.size_bytes);
      if (restored.length !== object.size_bytes || sha(restored) !== object.sha256) fail('restored_object_checksum_mismatch');
    }
    for (const name of INSERT_ORDER) {
      const table = snapshot.tables.find(table => table.name === name), relation = 'application.' + q(name);
      for (const raw of table.rows) {
        if (name === 'schema_migrations') {
          await client.query(`UPDATE ${relation} t SET applied_at=s.applied_at FROM json_populate_record(NULL::${relation},$1::json) s WHERE t.version=s.version`, [raw]);
        } else {
          const columns = table.columns.filter(column => !column.generated).map(column => q(column.name)).join(',');
          await client.query(`INSERT INTO ${relation}(${columns}) OVERRIDING SYSTEM VALUE SELECT ${columns} FROM json_populate_record(NULL::${relation},$1::json) ON CONFLICT DO NOTHING`, [raw]);
        }
      }
    }
    const evidence = [];
    for (const table of snapshot.tables) {
      const data = await rows(client, table.name);
      if (data.length !== table.row_count || rowsDigest(data) !== table.rows_sha256) fail('restored_rows_mismatch');
      evidence.push({ table: 'application.' + table.name, rows: data.length, rows_sha256: table.rows_sha256 });
    }
    // setval is not transactional: keep destination quiescent until successful return.
    for (const sequence of snapshot.sequences) {
      await client.query('SELECT setval($1::regclass,$2::bigint,$3)', ['application.' + q(sequence.name), sequence.last_value, sequence.is_called]);
    }
    if (JSON.stringify(await readSequences(client, info.sequences)) !== JSON.stringify(snapshot.sequences)) fail('restored_sequence_mismatch');
    await client.query('COMMIT');
    return { operation: 'application-isolated-restore', outcome: 'passed', tables: evidence,
      objects: snapshot.objects.length, object_bytes: snapshot.objects.reduce((sum, object) => sum + object.size_bytes, 0),
      audit_history_sha256: snapshot.tables.find(table => table.name === 'audit').rows_sha256,
      sequences: snapshot.sequences.length, scope: snapshot.scope };
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
}

export function s3Objects(sdk, client, bucket) {
  const { GetObjectCommand, PutObjectCommand, ListObjectsV2Command } = sdk;
  return {
    async assertOnlyKeys(allowed) {
      let ContinuationToken, count = 0;
      do {
        const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1000, ContinuationToken }),
          { abortSignal: AbortSignal.timeout(30000) });
        for (const object of page.Contents ?? []) {
          if (!allowed.has(object.Key) || ++count > 1001) fail('destination_objects_conflict');
        }
        ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
        if (page.IsTruncated && !ContinuationToken) fail('destination_inventory_invalid');
      } while (ContinuationToken);
    },
    async get(key, maxBytes, { signal } = {}) {
      const abortSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000);
      const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal });
      if (!response.Body || !Number.isSafeInteger(response.ContentLength) || response.ContentLength > maxBytes) {
        response.Body?.destroy?.(); fail('object_size_invalid');
      }
      const chunks = []; let size = 0;
      const abort = () => response.Body.destroy?.(new Error('application_backup_object_deadline'));
      abortSignal.addEventListener('abort', abort, { once: true });
      try {
        abortSignal.throwIfAborted();
        for await (const chunk of response.Body) {
          const bytes = Buffer.from(chunk); size += bytes.length;
          if (size > maxBytes) { response.Body.destroy?.(); fail('object_size_invalid'); }
          chunks.push(bytes);
        }
      } finally { abortSignal.removeEventListener('abort', abort); }
      return Buffer.concat(chunks);
    },
    async put(key, data, mediaType, digest) {
      try {
        await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: data,
          ContentType: mediaType, ContentLength: data.length, Metadata: { sha256: digest }, IfNoneMatch: '*' }),
        { abortSignal: AbortSignal.timeout(30000) });
      } catch (error) {
        if (!['PreconditionFailed', 'ConditionalRequestConflict'].includes(error?.name)) throw error;
        const existing = await this.get(key, data.length);
        if (sha(existing) !== digest) fail('destination_object_conflict');
      }
    },
  };
}

async function main() {
  let database, storage;
  try {
    const password = process.env.APPLICATION_BACKUP_PASSWORD;
    passwordCheck(password);
    if (!process.argv.includes('--quiescent')) fail('quiescent_assertion_required');
    const require = createRequire((process.env.APPLICATION_APP_ROOT || '/app') + '/package.json');
    const { Client } = require('pg'), sdk = require('@aws-sdk/client-s3');
    const endpoint = new URL(process.env.S3_ENDPOINT);
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) fail('endpoint_invalid');
    database = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10000,
      query_timeout: 60000 });
    await database.connect();
    storage = new sdk.S3Client({ endpoint: endpoint.href, region: process.env.S3_REGION || 'us-east-1',
      forcePathStyle: true, credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY }, maxAttempts: 3 });
    const bucket = process.env.S3_BUCKET;
    await storage.send(new sdk.HeadBucketCommand({ Bucket: bucket }));
    const objects = s3Objects(sdk, storage, bucket);
    if (process.argv.includes('--restore')) {
      const chunks = []; let size = 0;
      for await (const chunk of process.stdin) {
        size += chunk.length; if (size > MAX_ENVELOPE) fail('envelope_too_large'); chunks.push(chunk);
      }
      const snapshot = unseal(JSON.parse(Buffer.concat(chunks).toString('utf8')), password);
      const result = await restore(database, objects, snapshot, { bucket,
        isolatedDestination: process.argv.includes('--isolated-destination') });
      process.stdout.write(JSON.stringify(result) + '\n');
    } else {
      const snapshot = await collect(database, objects, { bucket,
        runtimeKey: process.env.RUNTIME_BUNDLE_OBJECT_KEY, runtimeSha256: process.env.RUNTIME_BUNDLE_SHA256,
        applicationVersion: require('./package.json').version });
      process.stdout.write(JSON.stringify(seal(snapshot, password)) + '\n');
    }
  } catch (error) {
    const code = /^application_backup_[a-z_]+$/.test(error?.message ?? '') ? error.message : 'application_backup_operation_failed';
    process.stderr.write(JSON.stringify({ operation: 'application-backup', outcome: 'failed', code }) + '\n');
    process.exitCode = 1;
  } finally { await database?.end().catch(() => {}); storage?.destroy(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
