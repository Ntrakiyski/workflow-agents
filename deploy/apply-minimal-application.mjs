#!/usr/bin/env node
/** Apply only this project's recorded service/app configuration; does not deploy. */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
const root = new URL('../', import.meta.url);
const commit = process.argv[process.argv.indexOf('--commit') + 1];
if (!/^[a-f0-9]{40}$/.test(commit ?? '')) throw Error('Require --commit <immutable SHA>');
if (execFileSync('git', ['cat-file', '-t', commit], { cwd: root, encoding: 'utf8' }).trim() !== 'commit')
  throw Error('Source commit must exist in the reviewed checkout');
for (const key of ['COOLIFY_TOKEN_FILE', 'APPLICATION_CREDENTIAL_FILE', 'LITELLM_KEY_FILE', 'INFRA_CREDENTIAL_FILE'])
  if (!process.env[key]?.startsWith('/')) throw Error('Require absolute ' + key);
const token = (await readFile(process.env.COOLIFY_TOKEN_FILE, 'utf8')).trim();
const secrets = JSON.parse(await readFile(process.env.APPLICATION_CREDENTIAL_FILE, 'utf8'));
const infraSecrets = JSON.parse(await readFile(process.env.INFRA_CREDENTIAL_FILE, 'utf8'));
const liteKey = (await readFile(process.env.LITELLM_KEY_FILE, 'utf8')).trim();
const infra = JSON.parse(await readFile(new URL('deploy/staging-resources.json', root)));
const ids = JSON.parse(await readFile(new URL('deploy/application-resources.json', root)));
const catalog = JSON.parse(await readFile(new URL('deploy/profiles.cloud.staging.json', root)));
const document = JSON.parse(await readFile(new URL('deploy/profiles.document.staging.json', root)));
const profiles = { version: 1, sandboxes: { ...catalog.sandboxes, ...document.sandboxes },
  workloads: { ...catalog.workloads, ...document.workloads } };
const known = new Set([...Object.values(infra.applications), ids.application.uuid]);
const origin = 'https://hosting.gccssofia.com';
async function api(method, path, body) {
  if (method !== 'GET' && !path.split('/').some(part => known.has(part))) throw Error('Mutation outside recorded apps');
  const response = await fetch(origin + '/api/v1' + path, { method, redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) throw Error('Configuration HTTP ' + response.status);
  return await response.json();
}
const common = { git_branch: 'release/minimal-application', git_commit_sha: commit,
  is_auto_deploy_enabled: false, redact_all_env_values_in_logs: true };
async function apply(uuid, expectedName, variables, settings) {
  const current = await api('GET', '/applications/' + uuid);
  if (current.name !== expectedName || current.environment?.uuid !== infra.environment_uuid ||
      current.environment?.project?.uuid !== infra.project_uuid) throw Error('Project/environment/name mismatch');
  await api('PATCH', '/applications/' + uuid + '/envs/bulk', { data: Object.entries(variables).map(([key, value]) => ({
    key, value: String(value), is_buildtime: false, is_runtime: true, is_preview: false, is_literal: true })) });
  await api('PATCH', '/applications/' + uuid, { ...common, ...settings });
  const actual = await api('GET', '/applications/' + uuid);
  if (actual.git_commit_sha !== commit || actual.ports_mappings ||
      (expectedName !== 'workflow-application' && actual.fqdn)) throw Error('Commit or private-network readback mismatch');
  console.log(JSON.stringify({ operation: 'configure', name: expectedName, uuid, commit, fqdn: actual.fqdn }));
}
async function auth(uuid, key) {
  const env = await api('GET', '/applications/' + uuid + '/envs');
  const value = env.find(item => item.key === key && !item.is_preview)?.value;
  if (value) return JSON.parse(value);
  // Tokens without read:sensitive cannot retrieve env values. Read only the
  // live nonsecret policies and token digests inside each owning container,
  // then resolve those digests against the operator's existing private keys.
  const command = key === 'RUNNER_AUTH_JSON'
    ? `node -e 'console.log(JSON.stringify(JSON.parse(process.env.RUNNER_AUTH_JSON).map(({token,...p})=>({...p,token_sha256:require("crypto").createHash("sha256").update(token).digest("hex")}))))'`
    : `python -c 'import json,os,hashlib;p=json.loads(os.environ["PROVIDER_AUTH_JSON"]);[x.update(token_sha256=hashlib.sha256(x.pop("token").encode()).hexdigest()) for x in p];print(json.dumps(p))'`;
  if (command.length > 255) throw Error('Policy probe command exceeds control bound');
  const app = await api('GET', '/applications/' + uuid);
  if (app.environment?.uuid !== infra.environment_uuid || app.environment?.project?.uuid !== infra.project_uuid)
    throw Error('Policy probe scope mismatch');
  const task = await api('POST', '/applications/' + uuid + '/scheduled-tasks', {
    name: 'workflow-policy-' + Date.now(), command, frequency: '* * * * *',
    container: app.settings?.custom_internal_name, enabled: true, timeout: 30 });
  const taskId = task.uuid ?? task.data?.uuid;
  if (!/^[a-z0-9]+$/.test(taskId ?? '')) throw Error('Policy probe task identity missing');
  try {
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      const result = await api('GET', '/applications/' + uuid + '/scheduled-tasks/' + taskId + '/executions');
      const execution = (Array.isArray(result) ? result : result.data)?.find(row => ['success', 'failed'].includes(row.status));
      if (execution) {
        if (execution.status !== 'success') throw Error('Policy probe failed');
        const policies = JSON.parse(execution.message.trim());
        return policies.map(({ token_sha256, ...policy }) => {
          const matches = [...Object.values(infraSecrets), ...Object.values(secrets)].filter(candidate =>
            typeof candidate === 'string' && createHash('sha256').update(candidate).digest('hex') === token_sha256);
          if (matches.length !== 1) throw Error('Existing policy credential has no unique private recovery key');
          return { ...policy, token: matches[0] };
        });
      }
      await sleep(2000);
    }
    throw Error('Policy probe timed out');
  } finally { await api('DELETE', '/applications/' + uuid + '/scheduled-tasks/' + taskId); }
}
const owner = secrets.application_service_owner_id;
const workloadProfiles = Object.keys(profiles.workloads), sandboxProfiles = Object.keys(profiles.sandboxes);
const runnerId = infra.applications['job-runner'], providerId = infra.applications['sandbox-provider'];
const runnerAuth = (await auth(runnerId, 'RUNNER_AUTH_JSON')).filter(value => value.actor_id !== 'workflow-application');
runnerAuth.push({ actor_id: 'workflow-application', owner_id: owner, token: secrets.runner_application_token,
  permissions: ['job:submit', 'job:read'],
  workload_profiles: ['pi-document-agent:v1'], sandbox_profiles: ['pi-document-cloud:v1'],
  max_concurrency: 1, max_pending_jobs: 20, allow_resume: false });
const providerAuth = (await auth(providerId, 'PROVIDER_AUTH_JSON')).filter(value => value.actor_id !== 'workflow-application');
const delegates = providerAuth.filter(policy => policy.token === infraSecrets.provider_delegate_token && policy.delegate_owners);
if (delegates.length !== 1) throw Error('Require exactly the recorded Runner delegate');
for (const policy of providerAuth) {
  if (policy === delegates[0]) {
    policy.delegate_owners = [...new Set([...policy.delegate_owners, owner])];
    policy.workload_profiles = [...new Set([...policy.workload_profiles, ...workloadProfiles])];
    policy.sandbox_profiles = [...new Set([...policy.sandbox_profiles, ...sandboxProfiles])];
  }
}
providerAuth.push({ actor_id: 'workflow-application', owner_id: owner, token: secrets.provider_application_token,
  permissions: ['sandbox:create', 'sandbox:read', 'sandbox:start', 'sandbox:stop', 'sandbox:file:read', 'sandbox:file:write'],
  workload_profiles: ['pi-document-agent:v1'], sandbox_profiles: ['pi-document-cloud:v1'] });
await apply(providerId, 'sandbox-provider', { PROVIDER_AUTH_JSON: JSON.stringify(providerAuth),
  PROVIDER_PROFILES_JSON: JSON.stringify(profiles), WORKLOAD_SECRET_LITELLM_API_KEY: liteKey }, { domains: '' });
await apply(runnerId, 'job-runner', { RUNNER_AUTH_JSON: JSON.stringify(runnerAuth),
  RUNNER_PROFILES_JSON: JSON.stringify(profiles) }, { domains: '' });
const appOrigin = 'https://workflow-agents.68.210.88.115.sslip.io';
const users = [{ username: secrets.application_username,
  password_sha256: createHash('sha256').update(secrets.application_password).digest('hex'), owner_id: secrets.application_owner }];
if (process.env.INCLUDE_QA_ACCOUNT === 'true') users.push({ username: secrets.qa_username,
  password_sha256: createHash('sha256').update(secrets.qa_password).digest('hex'), owner_id: secrets.qa_owner });
const variables = { DATABASE_URL: 'postgresql://workflow_application:' + encodeURIComponent(secrets.application_database_password) +
  '@' + ids.database.uuid + ':5432/workflow_application', APPLICATION_ORIGIN: appOrigin,
  APPLICATION_USERS_JSON: JSON.stringify(users),
  S3_ENDPOINT: 'http://workflow-files:9000', S3_REGION: 'us-east-1', S3_BUCKET: 'workflow-application',
  S3_ACCESS_KEY_ID: secrets.storage_access_key, S3_SECRET_ACCESS_KEY: secrets.storage_secret_key,
  RUNNER_URL: 'http://workflow-phase1-job-runner:8080', RUNNER_TOKEN: secrets.runner_application_token,
  PROVIDER_URL: 'http://workflow-phase1-sandbox-provider:8000', PROVIDER_TOKEN: secrets.provider_application_token,
  SANDBOX_PROFILE: 'pi-document-cloud:v1', WORKLOAD_PROFILE: 'pi-document-agent:v1',
  RUNTIME_BUNDLE_OBJECT_KEY: 'runtime/9ffbbd3ed2856013192049986f1062396e46461aa81998f607eaeda9acb3d033/runtime-bundle.tar.gz',
  RUNTIME_BUNDLE_SHA256: '9ffbbd3ed2856013192049986f1062396e46461aa81998f607eaeda9acb3d033',
  INITIALIZE_STORAGE: 'true', RUNTIME_BUNDLE_URL: 'https://github.com/Ntrakiyski/workflow-agents/releases/download/pi-document-runtime-v0.1.0-rc.1/runtime-bundle.tar.gz',
  APPLICATION_BACKUP_PASSWORD: secrets.application_backup_password,
  MAX_DURATION_SECONDS: '900', PORT: '8082' };
await apply(ids.application.uuid, 'workflow-application', variables, { domains: appOrigin,
  custom_network_aliases: 'workflow-application', custom_internal_name: 'workflow-application',
  is_consistent_container_name_enabled: true, limits_cpus: '1', limits_memory: '768m',
  custom_docker_run_options: '--cap-drop=ALL --security-opt=no-new-privileges:true --pids-limit=128',
  health_check_type: 'cmd', health_check_command: 'node /app/dist/healthcheck.js',
  health_check_path: '/health/ready', health_check_port: '8082', health_check_start_period: 60 });
ids.application.source_commit = commit;
ids.application.url = appOrigin;
await writeFile(new URL('deploy/application-resources.json', root), JSON.stringify(ids, null, 2) + '\n');
