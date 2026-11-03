#!/usr/bin/env node
/** Pull authenticated encrypted logical archives onto an independent host.
 * This uses each application's own DB credentials, inside its container.
 * No database is exposed, and no Coolify S3 backup destination is required.
 */
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { unseal } from './migration-archive.mjs';

const origin = 'https://hosting.gccssofia.com';
const commit = process.env.BACKUP_SOURCE_COMMIT;
if (!/^[a-f0-9]{40}$/.test(commit ?? '')) throw Error('Require immutable BACKUP_SOURCE_COMMIT');
for (const key of ['COOLIFY_TOKEN_FILE', 'BACKUP_CREDENTIAL_FILE', 'BACKUP_DIRECTORY']) {
  if (!process.env[key]?.startsWith('/')) throw Error('Require absolute ' + key);
}
const token = (await readFile(process.env.COOLIFY_TOKEN_FILE, 'utf8')).trim();
const credentials = JSON.parse(await readFile(process.env.BACKUP_CREDENTIAL_FILE, 'utf8'));
const project = 'ptombcqslsfcmfufdui4vk1z';
const environment = 'tiiebld0vegfeegaapo3cdt3';
const resources = [
  { name: 'job-runner', uuid: 'yf0aaiivjr9k3qqaiawnlz8d', extension: 'mjs',
    executable: 'node --input-type=module', password: credentials.provider_delegate_token },
  { name: 'sandbox-provider', uuid: 'b4safsmcuzzqdmgn7jqt7m8d', extension: 'py',
    executable: 'python', password: credentials.provider_operator_token },
];
const source = 'https://raw.githubusercontent.com/Ntrakiyski/workflow-agents/' + commit;
const directory = resolve(process.env.BACKUP_DIRECTORY);
await mkdir(directory, { recursive: true, mode: 0o700 });
const lock = join(directory, '.pull.lock');
// Concurrent invocations cannot create multiple cron tasks. A stale lock is
// retained for investigation if the process is killed mid-export.
await mkdir(lock, { mode: 0o700 });
const session = new Date().toISOString().replaceAll(/[-:.]/g, '') + '-' + randomUUID();
const destination = join(directory, session);
await mkdir(destination, { mode: 0o700 });
const manifest = { version: 1, session, source_origin: origin, destination_host: hostname(),
  source_commit: commit, scope: 'logical rows, sequences and audits; excludes schema DDL, application objects and Cloud guest disks',
  outcome: 'incomplete', archives: [] };

async function api(method, path, body) {
  const response = await fetch(origin + '/api/v1' + path, {
    method, redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw Error('backup_control_http_' + response.status);
  return await response.json();
}

try {
  for (const resource of resources) {
    const app = await api('GET', '/applications/' + resource.uuid);
    if (app.name !== resource.name || app.environment?.uuid !== environment ||
        app.environment?.project?.uuid !== project || app.fqdn || app.ports_mappings)
      throw Error('backup_source_scope_mismatch');
    const command = 'curl -fsS --max-time 30 ' + source + '/deploy/migration-archive.' + resource.extension +
      ' | ' + resource.executable;
    if (command.length > 255) throw Error('backup_command_exceeds_bound');
    const task = await api('POST', '/applications/' + resource.uuid + '/scheduled-tasks', {
      name: 'workflow-offhost-' + randomUUID(), command, frequency: '* * * * *',
      enabled: true, timeout: 120,
    });
    const taskId = task.uuid ?? task.data?.uuid;
    if (typeof taskId !== 'string' || !/^[a-z0-9]+$/.test(taskId)) throw Error('backup_task_identity_missing');
    let execution;
    try {
      const deadline = Date.now() + 180000;
      while (Date.now() < deadline) {
        const values = await api('GET', '/applications/' + resource.uuid + '/scheduled-tasks/' + taskId + '/executions');
        const rows = Array.isArray(values) ? values : values.data;
        execution = rows?.find(value => ['success', 'failed'].includes(value.status));
        if (execution) break;
        await sleep(2000);
      }
      if (execution?.status !== 'success') throw Error('backup_export_not_successful');
      const envelope = JSON.parse(execution.message.trim());
      // Check authentication and service identity before declaring this a backup.
      const snapshot = unseal(envelope, resource.password, resource.name);
      const raw = JSON.stringify(envelope) + '\n';
      await writeFile(join(destination, resource.name + '.encrypted.json'), raw, { mode: 0o600, flag: 'wx' });
      manifest.archives.push({ service: resource.name, application_uuid: resource.uuid,
        deployed_commit: app.git_commit_sha, task_uuid: taskId, execution_uuid: execution.uuid,
        sha256: createHash('sha256').update(raw).digest('hex'), authentication_verified: true,
        tables: snapshot.tables.map(table => ({ schema: table.schema, name: table.name,
          row_count: table.row_count, rows_sha256: table.rows_sha256 })),
        sequences: snapshot.sequences.length });
    } finally {
      await api('DELETE', '/applications/' + resource.uuid + '/scheduled-tasks/' + taskId);
    }
  }
  manifest.outcome = 'passed';
} catch (error) {
  manifest.outcome = 'failed';
  // Neither remote errors nor decrypted payloads enter logs.
  manifest.error_classification = error instanceof SyntaxError ? 'invalid_export_json' : 'backup_pull_failed';
  process.exitCode = 1;
} finally {
  await writeFile(join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  await rm(lock, { recursive: true });
}
console.log(JSON.stringify({ operation: 'workflow-agents-offhost-logical-backup', outcome: manifest.outcome,
  directory: destination, archives: manifest.archives.length, error_classification: manifest.error_classification }));
