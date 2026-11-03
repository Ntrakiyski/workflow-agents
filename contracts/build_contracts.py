"""Deterministic source for the reviewed Phase 1 wire contracts (no service imports)."""
import copy
import json
from pathlib import Path

ROOT = Path(__file__).parent

def ref(n): return {'$ref': '#/components/schemas/' + n}
def obj(properties, required=()): return {'type':'object','properties':properties,'required':list(required),'additionalProperties':False}
def string(maximum=128, **kw): return {'type':'string','minLength':1,'maxLength':maximum,**kw}
def enum(*values): return {'type':'string','enum':list(values)}
def integer(minimum, maximum): return {'type':'integer','minimum':minimum,'maximum':maximum}
def nullable(schema): return {'anyOf':[schema,{'type':'null'}]}
def array(schema, maximum=100): return {'type':'array','items':schema,'maxItems':maximum}
ID = string(128,pattern='^[A-Za-z0-9][A-Za-z0-9_.:-]*$')
TIME = {'type':'string','format':'date-time','maxLength':64}
PROFILE = string(128,pattern='^[A-Za-z0-9][A-Za-z0-9_.:-]*$')
ARGS = {'type':'object','maxProperties':32,'description':'Validated against the configured workload JSON Schema; canonical encoded arguments are limited to 16384 bytes. No command, shell, image or mount fields are accepted unless part of an approved workload schema.'}
ERROR = obj({'code':string(64),'message':string(512),'retryable':{'type':'boolean'},'correlation_id':ID},('code','message','retryable','correlation_id'))
ARTIFACT = obj({'ref':string(512),'sha256':string(64,pattern='^[a-f0-9]{64}$'),'size_bytes':integer(0,104857600),'media_type':string(128)},('ref','sha256','size_bytes'))
RESULT = obj({'exit_code':nullable({'type':'integer'}),'stdout':{'type':'string','maxLength':32768},'stderr':{'type':'string','maxLength':32768},'output_truncated':{'type':'boolean'},'artifacts':array(ref('Artifact'),32)},('exit_code','stdout','stderr','output_truncated','artifacts'))
EVENT = obj({'event_id':ID,'type':string(128),'status':string(64),'occurred_at':TIME,'correlation_id':ID,'actor_id':ID,'owner_id':ID,'target_id':ID,'job_id':nullable(ID),'sandbox_id':nullable(ID),'run_id':nullable(ID),'client_reference':nullable(string(256)),'detail':{'type':'object','maxProperties':16,'description':'Only allowlisted operational data: safe error code, attempt number, exit code, duration, identifiers. No arguments, output, credentials or sensitive payload.'}},('event_id','type','status','occurred_at','correlation_id','actor_id','owner_id','target_id','detail'))
HEALTH = obj({'status':enum('ok','degraded','unavailable'),'service':enum('job-runner','sandbox-provider'),'version':string(64),'checks':{'type':'object','additionalProperties':enum('ok','failed','unavailable','disabled')}},('status','service','version','checks'))
COMMON = {'Error':ERROR,'Artifact':ARTIFACT,'Result':RESULT,'Event':EVENT,'EventPage':obj({'events':array(ref('Event'),100),'next_cursor':nullable(string(256))},('events','next_cursor')),'Health':HEALTH,'Empty':obj({}),'CancelRequest':obj({'reason':string(256)}),'Workload':obj({'profile':PROFILE,'arguments':ARGS},('profile','arguments'))}

SANDBOX_REQUEST = obj({'mode':enum('ensure','reuse'),'owner_ref':string(256),'profile':PROFILE,'persistent':{'type':'boolean','const':True},'sandbox_id':ID},('mode',))
SANDBOX_REQUEST['allOf']=[{'if':{'properties':{'mode':{'const':'ensure'}}},'then':{'required':['owner_ref','profile','persistent'],'not':{'required':['sandbox_id']}},'else':{'required':['sandbox_id'],'not':{'anyOf':[{'required':['owner_ref']},{'required':['profile']},{'required':['persistent']}]}}}]
LIMITS = obj({'max_duration_seconds':integer(1,86400),'max_attempts':integer(1,10),'retry_backoff_seconds':integer(1,3600),'deadline_at':TIME},('max_duration_seconds','max_attempts'))
JOB_REQUEST = obj({'client_reference':string(256),'workload':ref('Workload'),'sandbox':ref('SandboxSelection'),'limits':ref('JobLimits'),'priority':integer(-32768,32767),'run_at':TIME,'idle_stop_after_seconds':integer(1,604800)},('workload','sandbox','limits'))
JOB_STATUS = enum('queued','scheduled','dispatching','running','retry_wait','cancelling','completed','failed','cancelled','timed_out')
JOB = obj({'job_id':ID,'status':JOB_STATUS,'client_reference':nullable(string(256)),'correlation_id':ID,'sandbox_id':nullable(ID),'run_id':nullable(ID),'attempt_count':integer(0,10),'created_at':TIME,'updated_at':TIME,'started_at':nullable(TIME),'finished_at':nullable(TIME),'result':nullable(ref('Result')),'error':nullable(ref('Error'))},('job_id','status','correlation_id','sandbox_id','run_id','attempt_count','created_at','updated_at','result','error'))
RESUME = obj({'workload':ref('Workload'),'limits':ref('JobLimits'),'client_reference':string(256),'priority':integer(-32768,32767),'run_at':TIME,'idle_stop_after_seconds':integer(1,604800)},('workload','limits'))
SCHEDULE_REQUEST = obj({'run_at':TIME,'action':enum('submit_job','stop_sandbox','cancel_job'),'job':ref('JobSubmission'),'sandbox_id':ID,'job_id':ID},('run_at','action'))
SCHEDULE_REQUEST['oneOf']=[{'properties':{'action':{'const':'submit_job'}},'required':['job'],'not':{'anyOf':[{'required':['sandbox_id']},{'required':['job_id']}]}},{'properties':{'action':{'const':'stop_sandbox'}},'required':['sandbox_id'],'not':{'anyOf':[{'required':['job']},{'required':['job_id']}]}},{'properties':{'action':{'const':'cancel_job'}},'required':['job_id'],'not':{'anyOf':[{'required':['job']},{'required':['sandbox_id']}]}}]
SCHEDULE = obj({'schedule_id':ID,'status':enum('pending','fired','cancelled','skipped','failed'),'action':enum('submit_job','stop_sandbox','cancel_job'),'run_at':TIME,'created_at':TIME,'updated_at':TIME,'job_id':nullable(ID),'sandbox_id':nullable(ID),'correlation_id':ID,'error':nullable(ref('Error'))},('schedule_id','status','action','run_at','created_at','updated_at','job_id','sandbox_id','correlation_id','error'))

RESOURCES = obj({'cpus':integer(1,64),'memory_mib':integer(64,262144),'disk_mib':integer(64,1048576),'network':enum('denied','allowlist')},('cpus','memory_mib','disk_mib','network'))
SANDBOX = obj({'sandbox_id':ID,'owner_ref':string(256),'profile':PROFILE,'persistent':{'type':'boolean','const':True},'status':enum('creating','running','stopping','stopped','failed','destroying','destroyed'),'created_at':TIME,'updated_at':TIME,'active_run_id':nullable(ID),'resources':ref('Resources'),'error':nullable(ref('Error'))},('sandbox_id','owner_ref','profile','persistent','status','created_at','updated_at','active_run_id','resources','error'))
CREATE_SANDBOX = obj({'owner_ref':string(256),'profile':PROFILE,'persistent':{'type':'boolean','const':True}},('owner_ref','profile','persistent'))
EXECUTE = obj({'execution_ref':string(256),'profile':PROFILE,'arguments':ARGS,'timeout_seconds':integer(1,86400),'artifact_output_ref':string(512)},('execution_ref','profile','arguments','timeout_seconds'))
RUN = obj({'run_id':ID,'sandbox_id':ID,'execution_ref':string(256),'profile':PROFILE,'status':enum('queued','running','cancelling','completed','failed','cancelled','timed_out'),'created_at':TIME,'updated_at':TIME,'started_at':nullable(TIME),'finished_at':nullable(TIME),'result':nullable(ref('Result')),'error':nullable(ref('Error'))},('run_id','sandbox_id','execution_ref','profile','status','created_at','updated_at','result','error'))

PARAMETERS = {
 'CorrelationId': {'name':'X-Correlation-ID','in':'header','required':False,'schema':ID,'description':'Opaque trace ID; generated if absent. Echoed on every response. Rejected if malformed.'},
 'IdempotencyKey': {'name':'Idempotency-Key','in':'header','required':True,'schema':string(128,pattern='^[A-Za-z0-9][A-Za-z0-9_.:-]*$'),'description':'Durable deduplication scoped to effective owner + operation + target. Same canonical JSON replays current resource; changed JSON gives 409.'},
 'OwnerId': {'name':'X-Owner-ID','in':'header','required':False,'schema':ID,'description':'Only credentials explicitly configured as delegates may set this header; other credentials receive 403 when supplying it. Delegates must supply an owner from their configured allowlist. Effective owner is never inferred from body metadata.'},
 'Cursor': {'name':'cursor','in':'query','required':False,'schema':string(256),'description':'Opaque exclusive cursor. Stable durable ordering; repeat retrieval is supported.'},
 'Limit': {'name':'limit','in':'query','required':False,'schema':{'type':'integer','minimum':1,'maximum':100,'default':50}},
}
for n in ('job_id','schedule_id','sandbox_id','run_id'):
 PARAMETERS[n]={'name':n,'in':'path','required':True,'schema':ID}

def param(n): return {'$ref':'#/components/parameters/'+n}
def response(n,description='Current durable resource'):
 return {'description':description,'headers':{'X-Correlation-ID':{'schema':ID,'description':'Correlation identifier'}},'content':{'application/json':{'schema':ref(n)}}}
def base(title): return {'openapi':'3.1.0','info':{'title':title,'version':'1.0.0-rc.1','description':'Initial reviewed Phase 1 wire contract. Release candidate until all real-runtime gates pass. See docs/contracts/v1.md.'},'jsonSchemaDialect':'https://json-schema.org/draft/2020-12/schema','security':[{'BearerAuth':[]}],'paths':{},'components':{'securitySchemes':{'BearerAuth':{'type':'http','scheme':'bearer','description':'Server-configured opaque service/client token; TLS or private trusted transport is required.'}},'parameters':copy.deepcopy(PARAMETERS),'schemas':copy.deepcopy(COMMON)}}
def operation(doc,path,method,opid,result,code=200,body=None,ids=(),idempotency=False,owner=False,description=''):
 ps=[param('CorrelationId')]+[param(x) for x in ids]
 if idempotency: ps.append(param('IdempotencyKey'))
 if owner: ps.append(param('OwnerId'))
 if path.endswith('/events'): ps += [param('Cursor'),param('Limit')]
 op={'operationId':opid,'description':description,'parameters':ps,'responses':{str(code):response(result),**{str(c):response('Error',d) for c,d in ((400,'Malformed JSON, query or header'),(401,'Missing or invalid credentials'),(403,'Denied profile, permission or delegation'),(404,'Unknown or wrong-owner resource'),(409,'Idempotency conflict, busy resource or illegal transition'),(422,'Payload or approved workload schema invalid'),(429,'Configured quota exceeded'),(503,'Database, runtime or dependency unavailable'))}}}
 if body: op['requestBody']={'required':True,'content':{'application/json':{'schema':ref(body)}}}
 doc['paths'].setdefault(path,{})[method]=op

def health(doc):
 for kind in ('live','ready'):
  op={'operationId':kind,'security':[],'description':'Liveness checks only process. Readiness includes service-owned database, worker/runtime availability; unavailable real runtime never passes. No credentials or internal addresses returned.','responses':{'200':response('Health'),'503':response('Health','Unavailable dependency')}}
  doc['paths']['/health/'+kind]={'get':op}

runner=base('Workflow Agents Job Runner API')
runner['components']['schemas'].update({'SandboxSelection':SANDBOX_REQUEST,'JobLimits':LIMITS,'JobSubmission':JOB_REQUEST,'Job':JOB,'ResumeRequest':RESUME,'ScheduleSubmission':SCHEDULE_REQUEST,'Schedule':SCHEDULE})
operation(runner,'/v1/jobs','post','submitJob','Job',202,'JobSubmission',idempotency=True,description='Durably submit a generic job. Enqueue and submission audit commit atomically. Past run_at executes as soon as possible. Deadline expiry prevents dispatch.')
operation(runner,'/v1/jobs/{job_id}','get','getJob','Job',ids=('job_id',))
operation(runner,'/v1/jobs/{job_id}/events','get','getJobEvents','EventPage',ids=('job_id',))
operation(runner,'/v1/jobs/{job_id}/cancel','post','cancelJob','Job',202,'CancelRequest',ids=('job_id',),description='Idempotent cancellation intent; terminal states remain terminal. Active Provider execution is reconciled/cancelled before reporting cancelled. No destroy.')
operation(runner,'/v1/jobs/{job_id}/resume','post','resumeJob','Job',202,'ResumeRequest',ids=('job_id',),idempotency=True,description='Create a new job against the retained sandbox of a terminal job; prior job stays immutable. Requires owner, retained sandbox and configured allow_resume policy; otherwise 409/403.')
operation(runner,'/v1/schedules','post','createSchedule','Schedule',201,'ScheduleSubmission',idempotency=True,description='Durable delayed action. submit_job queues at fire time; stop_sandbox skips busy sandbox and never destroys it; cancel_job provides generic deadline cancellation. Authorize referenced resources at admission and execution.')
operation(runner,'/v1/schedules/{schedule_id}','get','getSchedule','Schedule',ids=('schedule_id',))
operation(runner,'/v1/schedules/{schedule_id}','delete','cancelSchedule','Schedule',ids=('schedule_id',),description='Cancel pending schedule; already cancelled is unchanged, already fired/skipped/failed returns 409. No job/sandbox deletion.')
health(runner)
provider=base('Workflow Agents Sandbox Provider API')
provider['components']['schemas'].update({'Resources':RESOURCES,'Sandbox':SANDBOX,'CreateSandbox':CREATE_SANDBOX,'ExecuteRequest':EXECUTE,'Run':RUN,'DestroyRequest':obj({'confirm':{'type':'boolean','const':True},'reason':string(256)},('confirm','reason'))})
provider['components']['schemas'].update({
 'CancelByReferenceRequest':obj({'execution_ref':string(256),'reason':string(256)},('execution_ref',)),
 'CancellationFence':obj({'execution_ref':string(256),'run_id':nullable(ID),'status':enum('fenced','queued','running','cancelling','completed','failed','cancelled','timed_out')},('execution_ref','run_id','status'))
})
operation(provider,'/v1/sandboxes','post','createSandbox','Sandbox',201,'CreateSandbox',idempotency=True,owner=True,description='Ensure one retained sandbox per effective owner + owner_ref. Profile is immutable: mismatched profile gives 409. Stable runtime identity must be persisted before side effects so ambiguous create is recovered, not recreated. Return current resource on replay.')
operation(provider,'/v1/sandboxes/{sandbox_id}','get','getSandbox','Sandbox',ids=('sandbox_id',),owner=True)
operation(provider,'/v1/sandboxes/{sandbox_id}/events','get','getSandboxEvents','EventPage',ids=('sandbox_id',),owner=True)
for action in ('start','stop'):
 operation(provider,'/v1/sandboxes/{sandbox_id}/'+action,'post',action+'Sandbox','Sandbox',200,'Empty',ids=('sandbox_id',),owner=True,description=('Idempotently reattach/start the same retained runtime identity. Never replace missing disk with new data.' if action=='start' else 'Idempotently stop without deletion. Busy/cancelling runs give 409. Stop preserves writable disks across process/container restart.'))
operation(provider,'/v1/sandboxes/{sandbox_id}/execute','post','executeWorkload','Run',202,'ExecuteRequest',ids=('sandbox_id',),idempotency=True,owner=True,description='Start only an approved configured workload; sandbox must be running. Atomically claim one active run per sandbox. Durable idempotency and execution_ref allow recovery after unknown HTTP outcome. No shell is built from caller input. Unsupported artifact transfer gives 422 before execution.')
operation(provider,'/v1/sandboxes/{sandbox_id}/runs/cancel-by-reference','post','cancelExecutionByReference','CancellationFence',202,'CancelByReferenceRequest',ids=('sandbox_id',),owner=True,description='Durably fence execution_ref under the same sandbox serialization lock as execute. If no run exists, return run_id:null,status:fenced and reject future new execute for this reference with 409 execution_cancelled. If a run exists, return its ID/status and reconcile cancellation; completed terminal runs remain terminal. Repeated fences are idempotent. Never create a workload while cancelling an ambiguous execute request.')
operation(provider,'/v1/sandboxes/{sandbox_id}/runs/{run_id}','get','getRun','Run',ids=('sandbox_id','run_id'),owner=True)
operation(provider,'/v1/sandboxes/{sandbox_id}/runs/{run_id}/cancel','post','cancelRun','Run',202,'CancelRequest',ids=('sandbox_id','run_id'),owner=True,description='Idempotent cancellation intent. Cancel and reconcile actual execution before final cancelled state; preserve sandbox storage. Completed terminal runs remain terminal.')
operation(provider,'/v1/sandboxes/{sandbox_id}/destroy','post','destroySandbox','Sandbox',200,'DestroyRequest',ids=('sandbox_id',),owner=True,description='Requires owner plus sandbox:destroy permission, confirm=true and bounded reason. Refuse active runs. Only this operation may permanently remove disk; repeated destruction returns destroyed tombstone.')
health(provider)
for name,doc in [('runner',runner),('provider',provider)]:
 (ROOT/'v1'/f'{name}-v1.openapi.json').write_text(json.dumps(doc,indent=2)+'\n')
