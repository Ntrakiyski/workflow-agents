/** Explicit export-only recovery of one inspected completed job. No job submit/execute exists here. */
(async () => {
 const {createRequire}=await import('node:module');const{pathToFileURL}=await import('node:url');const{createHash}=await import('node:crypto');
 const require=createRequire(process.cwd()+'/package.json');const{Client}=require('pg');
 const {configuration}=await import(pathToFileURL(process.cwd()+'/dist/config.js'));
 const {HttpExecutionServices}=await import(pathToFileURL(process.cwd()+'/dist/remote.js'));
 const {manifest}=await import(pathToFileURL(process.cwd()+'/dist/model.js'));
 const {validateDelivery}=await import(pathToFileURL(process.cwd()+'/dist/validate.js'));
 const {S3Objects}=await import(pathToFileURL(process.cwd()+'/dist/storage.js'));
 const config=configuration(),remote=new HttpExecutionServices(config),objects=new S3Objects(config);
 const id='598c30fa-e0d0-4d36-96d7-16d75bd675e7',sid='sbx_ed9a6d3c16a7432aa5d0f06236fa0c5f',jobId='job_127d48d9-eb51-44d1-8213-9e99f12e6a28';
 const expected='adbac251cf3c241a276c3303530f646977bf0c3bff67164d1e855222b728cdbb';
 const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
 const db=new Client({connectionString:config.databaseUrl,statement_timeout:15000,connectionTimeoutMillis:10000});let locked=false,started=false,authorized=false;
 async function provider(path,method='GET',body){const r=await fetch(new URL(path,config.providerUrl),{method,signal:AbortSignal.timeout(60000),headers:{authorization:'Bearer '+config.providerToken,'content-type':'application/json','x-correlation-id':id},body:body===undefined?undefined:JSON.stringify(body)});if(!r.ok)throw Error('provider_http_'+r.status);return r.json();}
 try {
  await db.connect();locked=(await db.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',[id])).rows[0].locked;
  if(!locked)throw Error('request_busy');
  const row=(await db.query('SELECT * FROM application.requests WHERE id=$1 AND owner_id=$2',[id,config.users[0].owner_id])).rows[0];
  if(!row||row.sandbox_id!==sid||row.job_id!==jobId)throw Error('recorded_identity_guard');
  if(row.status==='completed'&&row.export_complete){console.log(JSON.stringify({operation:'authorize-completed-export-recovery',outcome:'already_completed',request_id:id,workload_reexecuted:false}));return;}
  if(row.status!=='failed'||!row.terminal_error||!row.sandbox_stopped||row.export_complete)throw Error('failed_row_guard');
  const job=await remote.job(jobId,id);if(job.status!=='completed'||job.sandbox_id!==sid||job.result?.exit_code!==0)throw Error('completed_job_guard');
  const box=await provider('/v1/sandboxes/'+sid);if(box.owner_ref!=='application:'+id||box.status!=='stopped')throw Error('stopped_identity_guard');
  started=true;await provider('/v1/sandboxes/'+sid+'/start','POST',{});
  const bytes=await remote.download(sid,'requests/'+id+'/outputs/result.json',1024*1024,id);
  if(hash(bytes)!==expected)throw Error('recorded_manifest_checksum');
  const result=manifest.parse(JSON.parse(bytes.toString('utf8')));
  if(result.request_id!==id||result.outcome!=='completed'||!result.session_files.length)throw Error('manifest_identity_outcome');
  const outputs=new Map(),sessionChecks=[];
  for(const artifact of result.artifacts)outputs.set(artifact.path,await remote.download(sid,'requests/'+id+'/outputs/'+artifact.path,10*1024*1024,id));
  await validateDelivery(result,outputs);
  for(const file of result.session_files){const data=await remote.download(sid,'requests/'+id+'/session/'+file.path,10*1024*1024,id);if(data.length!==file.size_bytes||hash(data)!==file.sha256)throw Error('session_integrity');sessionChecks.push({sha256:file.sha256,bytes:data.length});}
  const originals=(await db.query("SELECT object_key,size_bytes,sha256 FROM application.files WHERE request_id=$1 AND kind='input'",[id])).rows;
  for(const file of originals){const data=await objects.get(file.object_key,10*1024*1024);if(data.length!==file.size_bytes||hash(data)!==file.sha256)throw Error('original_integrity');}
  await db.query('BEGIN');
  try {
   const changed=await db.query("UPDATE application.requests SET status='running',failure_message=NULL,terminal_error=false,sandbox_stopped=false,attempts=0,next_attempt_at=now(),updated_at=now() WHERE id=$1 AND status='failed' AND terminal_error=true AND job_id=$2 AND sandbox_id=$3 AND export_complete=false",[id,jobId,sid]);
   if(changed.rowCount!==1)throw Error('recovery_state_changed');
   await db.query("INSERT INTO application.audit(request_id,owner_id,actor_id,action,correlation_id,detail) VALUES($1::uuid,$2,'release-operator','request.output_recovery_authorized',$1::text,$3)",[id,row.owner_id,JSON.stringify({reason:'corrected_session_manifest_v1_compatibility',result_manifest_sha256:expected,completed_job_verified:true,workload_reexecuted:false})]);
   await db.query('COMMIT');authorized=true;
  } catch(error){await db.query('ROLLBACK');throw error;}
  console.log(JSON.stringify({operation:'authorize-completed-export-recovery',outcome:'authorized_export_only',request_id:id,job_id:jobId,sandbox_id:sid,manifest_sha256:expected,artifacts_checked:result.artifacts.length,sessions_checked:sessionChecks,originals_verified:originals.length,failed_audit_preserved:true,identities_unchanged:true,workload_reexecuted:false,next_step:'existing worker revalidates and exports the same completed job, then stops the same sandbox'}));
 } finally {
  try { if(started&&!authorized)await remote.stop(sid,id); }
  finally {
   try { if(locked)await db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[id]); }
   finally { try { await db.end(); } finally { objects.close(); } }
  }
 }
})().catch(error=>{console.log(JSON.stringify({operation:'authorize-completed-export-recovery',outcome:'failed',error_classification:/^[a-z_0-9]+$/.test(error.message)?error.message:error.name}));process.exitCode=1;});
