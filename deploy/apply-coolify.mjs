#!/usr/bin/env node
// Applies only Git-defined configuration to the four recorded staging resources.
// Node's supported API transport is used because the instance rejects Python's
// urllib user agent. The token source is the existing authorized connector token.
import {readFile} from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('deploy/coolify.phase1.json',root)));
const ids = JSON.parse(await readFile(new URL('deploy/staging-resources.json',root)));
const base = process.env.COOLIFY_URL;
const tokenFile = process.env.COOLIFY_TOKEN_FILE;
const commit = process.argv[process.argv.indexOf('--commit')+1];
if (!base || !tokenFile || !/^[a-f0-9]{40}$/.test(commit??''))
  throw new Error('Require COOLIFY_URL, COOLIFY_TOKEN_FILE, --commit <full immutable SHA>');
if (new URL(base).origin !== manifest.coolify_url || ids.coolify_url !== manifest.coolify_url)
  throw new Error('Coolify origin does not match the recorded deployment target');
if (manifest.project.name !== 'workflow-agents-phase1') throw new Error('Unexpected project name');
const token = (await readFile(tokenFile,'utf8')).trim();
async function api(method,path,body) {
  const response = await fetch(base.replace(/\/$/,'')+'/api/v1'+path, {
    method, redirect:'error', signal:AbortSignal.timeout(30000),
    headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},
    body:body===undefined?undefined:JSON.stringify(body)
  });
  const value = await response.json();
  if (!response.ok) throw new Error(`Coolify ${method} ${path}: HTTP ${response.status}: ${value.message??'request refused'}`);
  return value;
}
const project = await api('GET','/projects/'+ids.project_uuid);
const environment = project.environments.find(e=>e.uuid===ids.environment_uuid&&e.name==='staging');
if (project.name !== manifest.project.name || !environment) throw new Error('Staging project identity mismatch');
for (const [name,uuid] of Object.entries(ids.applications)) {
  const current = await api('GET','/applications/'+uuid);
  if (current.environment_id !== environment.id || current.name !== name) throw new Error('Application scope mismatch');
  if (current.destination?.server?.uuid !== ids.server_uuid) throw new Error('Application execution server mismatch');
  const {storage,qualification,autogenerate_domain,...settings} = manifest.applications[name];
  const body = {...settings,git_commit_sha:commit,git_branch:manifest.branch,is_auto_deploy_enabled:false,domains:''};
  if (process.argv.includes('--kvm-probe')) throw new Error('Set reviewed KVM access in the target manifest; legacy probe flag is disabled');
  if (process.argv.includes('--dry-run')) {
    console.log(JSON.stringify({name,uuid,commit,target:manifest.coolify_url,configuration:'verified-dry-run'}));
    continue;
  }
  await api('PATCH','/applications/'+uuid,body);
  const actual = await api('GET','/applications/'+uuid);
  if (actual.git_commit_sha !== commit || actual.fqdn || actual.ports_mappings)
    throw new Error('Immutable commit/private exposure verification failed');
  if (actual.custom_docker_run_options !== body.custom_docker_run_options || actual.limits_memory !== body.limits_memory)
    throw new Error('Runtime restrictions or capacity read-back mismatch');
  console.log(JSON.stringify({name,uuid,commit,target:manifest.coolify_url,public_domain:false,host_port_mapping:false,configuration:'applied'}));
}
