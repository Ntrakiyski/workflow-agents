#!/usr/bin/env node
/** Pull authenticated encrypted logical archives onto an independent host.
 * This uses each application's own DB credentials, inside its container.
 * No database is exposed, and no Coolify S3 backup destination is required.
 */
import { verifyApplicationScope } from './coolify-scope.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { unseal } from './migration-archive.mjs';
import { cacheApprovedRuntime } from './cache-approved-runtime.mjs';
import { unseal as unsealApplication } from '../apps/application/scripts/application-backup.mjs';

const origin = 'https://hosting.gccssofia.com';
const commit = process.env.BACKUP_SOURCE_COMMIT;
if (!/^[a-f0-9]{40}$/.test(commit ?? '')) throw Error('Require immutable BACKUP_SOURCE_COMMIT');
for (const key of ['COOLIFY_TOKEN_FILE', 'BACKUP_CREDENTIAL_FILE', 'BACKUP_DIRECTORY']) {
  if (!process.env[key]?.startsWith('/')) throw Error('Require absolute ' + key);
}
const token = (await readFile(process.env.COOLIFY_TOKEN_FILE, 'utf8')).trim();
const credentials = JSON.parse(await readFile(process.env.BACKUP_CREDENTIAL_FILE, 'utf8'));
if (!process.env.APPLICATION_CREDENTIAL_FILE?.startsWith('/')) throw Error('Require absolute APPLICATION_CREDENTIAL_FILE');
const applicationCredentials = JSON.parse(await readFile(process.env.APPLICATION_CREDENTIAL_FILE, 'utf8'));
const project = 'ptombcqslsfcmfufdui4vk1z';
const environment = 'tiiebld0vegfeegaapo3cdt3';
const resources = [
  { name: 'job-runner', uuid: 'yf0aaiivjr9k3qqaiawnlz8d', extension: 'mjs',
    executable: 'node --input-type=module', password: credentials.provider_delegate_token },
  { name: 'sandbox-provider', uuid: 'b4safsmcuzzqdmgn7jqt7m8d', extension: 'py',
    executable: 'python', password: credentials.provider_operator_token },
  { name: 'workflow-application', service: 'application', uuid: '7vdsilhnu96tifz7yosm61j1',
    password: applicationCredentials.application_backup_password,
    command: 'node /app/scripts/application-backup.mjs --quiescent',
    publicOrigin: 'https://workflow-agents.68.210.88.115.sslip.io' },
];
if (process.argv.includes('--infrastructure-only')) resources.pop();
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
  source_commit: commit, scope: 'service logical rows, sequences and audits; application referenced immutable input/result/session objects; includes separate approved public runtime cache/profile inventory; excludes schema DDL and Cloud guest disks',
  included_services: resources.map(resource => resource.service ?? resource.name),
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

async function runningDeployment(app, uuid) {
  const history = await api('GET', '/deployments/applications/' + uuid + '?per_page=3');
  const latest = history.deployments?.[0];
  if (app.status !== 'running:healthy' || latest?.status !== 'finished' ||
      !/^[a-f0-9]{40}$/.test(latest.commit ?? '') || latest.commit !== app.git_commit_sha)
    throw Error('backup_running_source_not_confirmed');
  return latest;
}

try {
  for (const resource of resources) {
    const app = await verifyApplicationScope(api, { project, environment, uuid: resource.uuid, name: resource.name });
    if ((resource.publicOrigin ? app.fqdn !== resource.publicOrigin : app.fqdn) || app.ports_mappings)
      throw Error('backup_source_scope_mismatch');
    const deployed = await runningDeployment(app, resource.uuid);
    const command = resource.command ?? ('curl -fsS --max-time 30 ' + source + '/deploy/migration-archive.' + resource.extension +
      ' | ' + resource.executable);
    if (command.length > 255) throw Error('backup_command_exceeds_bound');
    const task = await api('POST', '/applications/' + resource.uuid + '/scheduled-tasks', {
      name: 'workflow-offhost-' + randomUUID(), command, frequency: '* * * * *',
      container: app.settings?.custom_internal_name || resource.name,
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
      const snapshot = resource.service === 'application' ? unsealApplication(envelope, resource.password)
        : unseal(envelope, resource.password, resource.name);
      if (resource.service === 'application' && snapshot.excluded_runtime) {
        manifest.runtime_cache = { ...await cacheApprovedRuntime({ cacheDirectory: directory,
          sha256: snapshot.excluded_runtime.sha256 }), relative_to: 'parent of this session directory',
          contents: 'approved already-public runtime only; no user documents, sessions or secrets' };
        const catalog = JSON.parse(await readFile(new URL('./profiles.document.staging.json', import.meta.url), 'utf8'));
        const selected = Object.entries(catalog.workloads).filter(([, profile]) =>
          profile.argv.includes(snapshot.excluded_runtime.sha256));
        if (!selected.length) throw Error('backup_runtime_profile_mismatch');
        const sandboxNames = [...new Set(selected.flatMap(([, profile]) => profile.sandbox_profiles))];
        const inventory = { version: 1, workloads: Object.fromEntries(selected),
          sandboxes: Object.fromEntries(sandboxNames.map(name => [name, catalog.sandboxes[name]])) };
        if (Object.values(inventory.sandboxes).some(value => !value)) throw Error('backup_sandbox_profile_missing');
        const publicProfiles = JSON.stringify(inventory, null, 2) + '\n';
        await writeFile(join(destination, 'profiles.public.json'), publicProfiles, { mode: 0o600, flag: 'wx' });
        manifest.profile_inventory = { relative_path: 'profiles.public.json',
          sha256: createHash('sha256').update(publicProfiles).digest('hex'), operator_source_commit: commit,
          contents: 'approved public profiles and secret reference names; no secret values' };
      }
      // Configuration pins can change before a replacement completes. Require
      // an unchanged healthy finished deployment across the entire capture.
      const afterApp = await api('GET', '/applications/' + resource.uuid);
      const afterDeployment = await runningDeployment(afterApp, resource.uuid);
      if (afterDeployment.deployment_uuid !== deployed.deployment_uuid)
        throw Error('backup_source_changed_during_capture');
      const raw = JSON.stringify(envelope) + '\n';
      await writeFile(join(destination, (resource.service ?? resource.name) + '.encrypted.json'), raw, { mode: 0o600, flag: 'wx' });
      manifest.archives.push({ service: resource.service ?? resource.name, application_uuid: resource.uuid,
        deployed_commit: deployed.commit, source_deployment_uuid: deployed.deployment_uuid,
        source_attribution: 'unchanged healthy finished Coolify deployment before and after capture',
        task_uuid: taskId, execution_uuid: execution.uuid,
        sha256: createHash('sha256').update(raw).digest('hex'), authentication_verified: true,
        tables: snapshot.tables.map(table => ({ schema: table.schema, name: table.name,
          row_count: table.row_count, rows_sha256: table.rows_sha256 })),
        sequences: snapshot.sequences.length,
        ...(snapshot.objects ? { objects: snapshot.objects.map(object => ({ object_key: object.object_key,
          size_bytes: object.size_bytes, sha256: object.sha256 })), excluded_runtime: snapshot.excluded_runtime } : {}) });
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
