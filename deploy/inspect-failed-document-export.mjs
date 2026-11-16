/** Fixed-target read-only application inspection, with same-box start/read/stop. */
(async () => {
 const {createRequire}=await import('node:module');const{pathToFileURL}=await import('node:url');const{createHash}=await import('node:crypto');
 const require=createRequire(process.cwd()+'/package.json');const{Client}=require('pg');
 const {configuration}=await import(pathToFileURL(process.cwd()+'/dist/config.js'));
 const {HttpExecutionServices}=await import(pathToFileURL(process.cwd()+'/dist/remote.js'));
 const {manifest}=await import(pathToFileURL(process.cwd()+'/dist/model.js'));
 const config=configuration(),remote=new HttpExecutionServices(config);
 const id='598c30fa-e0d0-4d36-96d7-16d75bd675e7',sid='sbx_ed9a6d3c16a7432aa5d0f06236fa0c5f',jobId='job_127d48d9-eb51-44d1-8213-9e99f12e6a28';
 const db=new Client({connectionString:config.databaseUrl,options:'-c default_transaction_read_only=on'});let started=false;
 async function provider(path,method='GET',body){const r=await fetch(new URL(path,config.providerUrl),{method,signal:AbortSignal.timeout(60000),headers:{authorization:'Bearer '+config.providerToken,'content-type':'application/json','x-correlation-id':id},body:body===undefined?undefined:JSON.stringify(body)});if(!r.ok)throw Error('provider_http_'+r.status);return r.json();}
 try {
  await db.connect();const row=(await db.query('SELECT id,status,sandbox_id,job_id,sandbox_stopped,terminal_error FROM application.requests WHERE id=$1 AND owner_id=$2',[id,config.users[0].owner_id])).rows[0];
  if(!row||row.status!=='failed'||!row.terminal_error||!row.sandbox_stopped||row.sandbox_id!==sid||row.job_id!==jobId)throw Error('failed_row_guard');
  const job=await remote.job(jobId,id);if(job.status!=='completed'||job.sandbox_id!==sid||job.result?.exit_code!==0)throw Error('completed_job_guard');
  const box=await provider('/v1/sandboxes/'+sid);if(box.owner_ref!=='application:'+id||box.status!=='stopped')throw Error('stopped_identity_guard');
  started=true;await provider('/v1/sandboxes/'+sid+'/start','POST',{});
  const data=await remote.download(sid,'requests/'+id+'/outputs/result.json',1024*1024,id);const value=JSON.parse(data.toString('utf8')),parsed=manifest.safeParse(value);
  console.log(JSON.stringify({operation:'inspect-failed-completed-export',outcome:'passed_diagnostic',request_id:id,job_id:jobId,sandbox_id:sid,runner_status:job.status,runner_exit_code:job.result.exit_code,
    manifest_sha256:createHash('sha256').update(data).digest('hex'),manifest_bytes:data.length,manifest_outcome:value.outcome,
    manifest_keys:Object.keys(value),artifact_keys:value.artifacts?.map(x=>Object.keys(x)),session_keys:value.session_files?.map(x=>Object.keys(x)),
    controller_schema_valid:parsed.success,schema_issues:parsed.success?[]:parsed.error.issues.map(({path,code,keys})=>({path,code,keys})),
    original_failed_row_and_audits:'unchanged',workload_reexecuted:false}));
 } finally {try {if(started)await remote.stop(sid,id);} finally {await db.end();}}
})().catch(error=>{console.log(JSON.stringify({operation:'inspect-failed-completed-export',outcome:'failed',error_classification:/^[a-z_0-9]+$/.test(error.message)?error.message:error.name}));process.exitCode=1;});
