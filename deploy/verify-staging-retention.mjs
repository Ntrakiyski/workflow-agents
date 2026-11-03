import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire('/app/package.json');
const {Client}=require('pg');
const owners=JSON.parse(process.env.RUNNER_AUTH_JSON);
const owner=owners[0], other=owners.find(p=>p.owner_id!==owner.owner_id);
const gitBase=process.argv[2];
const report=await (await fetch(gitBase+'/docs/phase1/DEPLOYED-QA-EVIDENCE.json')).json();
const recorded=await (await fetch(gitBase+'/deploy/staging-resources.json')).json();
const prior={...report.resources,sandbox_id:report.provider_failed_sandbox_id,correlation_id:report.correlation_id};
const urls={runner:'http://127.0.0.1:'+process.env.PORT,provider:process.env.SANDBOX_PROVIDER_URL};
async function get(service,path,identity=owner,expected=200){
  const headers={Authorization:'Bearer '+(service==='runner'?identity.token:process.env.SANDBOX_PROVIDER_TOKEN),'X-Correlation-ID':'phase1-retention-check'};
  if(service==='provider')headers['X-Owner-ID']=identity.owner_id;
  const r=await fetch(urls[service]+path,{headers,signal:AbortSignal.timeout(10000)});
  assert.equal(r.status,expected);return r.json();
}
const a=await get('runner','/v1/jobs/'+prior.delayed_job_id);
const b=await get('runner','/v1/jobs/'+prior.runtime_job_id);
assert.equal(a.status,'cancelled');assert.equal(b.status,'timed_out');assert.equal(b.error.code,'deadline_exceeded');
const je=await get('runner','/v1/jobs/'+b.job_id+'/events');
assert(je.events.some(e=>e.type==='job.timed_out'));
const sandbox=await get('provider','/v1/sandboxes/'+prior.sandbox_id);
assert.equal(sandbox.status,'failed');
const events=await get('provider','/v1/sandboxes/'+prior.sandbox_id+'/events');
assert(events.events.some(e=>e.type==='sandbox.failed'));
assert(events.events.every(e=>e.actor_id==='job-runner'&&e.owner_id===owner.owner_id&&e.correlation_id===prior.correlation_id));
await get('provider','/v1/sandboxes/'+prior.sandbox_id,other,404);
const candidate=new URL(process.env.DATABASE_URL);candidate.hostname=recorded.databases['sandbox-provider-db'];candidate.pathname='/sandbox_provider';
const client=new Client({connectionString:candidate.toString(),connectionTimeoutMillis:5000});
let denied=false;
try{await client.connect();}catch(e){denied=['28P01','28000'].includes(e.code);}finally{await client.end().catch(()=>{});}
assert(denied,'Runner credentials unexpectedly accepted by Provider PostgreSQL');
console.log(JSON.stringify({probe:'staging-retention-and-database-isolation',outcome:'passed',
  runner_jobs_retained:[a.job_id,b.job_id],runner_audit_events:je.events.length,
  provider_sandbox_retained:sandbox.sandbox_id,provider_audit_events:events.events.length,
  first_provider_audit_id:events.events[0].event_id,provider_wrong_owner_http:404,
  cross_database_credentials:'rejected',vm_disk_retention:'blocked-unverified'}));
