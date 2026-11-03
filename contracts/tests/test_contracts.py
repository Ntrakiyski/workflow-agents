#!/usr/bin/env python3
"""Validate schemas/fixtures, without claiming service/runtime execution."""
import copy
import json
from pathlib import Path
import unittest
from jsonschema import Draft202012Validator, FormatChecker
from openapi_spec_validator import validate

ROOT=Path(__file__).resolve().parents[1]

def load(name): return json.loads((ROOT/'v1'/name).read_text())
def validator(doc,name):
 return Draft202012Validator({'$ref':'#/components/schemas/'+name,'components':doc['components']},format_checker=FormatChecker())

def valid(v,data): v.validate(data)
def invalid(v,data):
 if not list(v.iter_errors(data)): raise AssertionError('Expected invalid fixture: '+repr(data))

class Contracts(unittest.TestCase):
 def test_openapi_documents(self):
  for service in ('runner','provider'):
   doc=load(service+'-v1.openapi.json')
   validate(doc)
   for schema in doc['components']['schemas'].values(): Draft202012Validator.check_schema(schema)
   operations=[op['operationId'] for path in doc['paths'].values() for op in path.values()]
   self.assertEqual(len(operations),len(set(operations)))
   for path,methods in doc['paths'].items():
    for op in methods.values():
     self.assertTrue(path.startswith('/health/') or doc['security'])
     self.assertTrue(all('content' in value for value in op['responses'].values()))
 def test_runner_payloads(self):
  doc=load('runner-v1.openapi.json')
  submission={'workload':{'profile':'fixture-write-file:v1','arguments':{'file':'hello-world.txt','text':'hello'}},'sandbox':{'mode':'ensure','owner_ref':'fixture-a','profile':'minimal-linux:v1','persistent':True},'limits':{'max_duration_seconds':120,'max_attempts':2}}
  v=validator(doc,'JobSubmission');valid(v,submission)
  bad=copy.deepcopy(submission);bad['sandbox']['mode']='reuse';invalid(v,bad)
  bad=copy.deepcopy(submission);bad['sandbox']['sandbox_id']='sbx_existing';invalid(v,bad)
  reuse=copy.deepcopy(submission);reuse['sandbox']={'mode':'reuse','sandbox_id':'sbx_existing'};valid(v,reuse)
  bad=copy.deepcopy(submission);bad['command']='sh -c whoami';invalid(v,bad)
  bad=copy.deepcopy(submission);bad['limits']['max_attempts']=11;invalid(v,bad)
  s=validator(doc,'ScheduleSubmission')
  valid(s,{'action':'submit_job','run_at':'2026-11-03T12:00:00Z','job':submission})
  valid(s,{'action':'stop_sandbox','run_at':'2026-11-03T12:00:00Z','sandbox_id':'sbx_a'})
  valid(s,{'action':'cancel_job','run_at':'2026-11-03T12:00:00Z','job_id':'job_a'})
  invalid(s,{'action':'stop_sandbox','run_at':'2026-11-03T12:00:00Z','sandbox_id':'sbx_a','job_id':'job_b'})
  invalid(s,{'action':'cancel_job','run_at':'invalid','job_id':'job_a'})
 def test_provider_payloads(self):
  doc=load('provider-v1.openapi.json')
  valid(validator(doc,'CreateSandbox'),{'owner_ref':'fixture-a','profile':'minimal-linux:v1','persistent':True})
  invalid(validator(doc,'CreateSandbox'),{'owner_ref':'fixture-a','profile':'minimal-linux:v1','persistent':False})
  valid(validator(doc,'ExecuteRequest'),{'execution_ref':'job_a.attempt_1','profile':'fixture-write-file:v1','arguments':{'file':'a.txt','text':'hello'},'timeout_seconds':120})
  invalid(validator(doc,'ExecuteRequest'),{'execution_ref':'a','profile':'fixture-write-file:v1','arguments':{},'timeout_seconds':0})
  invalid(validator(doc,'ExecuteRequest'),{'execution_ref':'a','profile':'fixture-write-file:v1','arguments':{},'timeout_seconds':120,'shell':'whoami'})
  valid(validator(doc,'CancelByReferenceRequest'),{'execution_ref':'attempt-a','reason':'Cancelled after unknown HTTP outcome'})
  invalid(validator(doc,'CancelByReferenceRequest'),{'execution_ref':'attempt-a','shell':'ignored'})
  valid(validator(doc,'CancellationFence'),{'execution_ref':'attempt-a','run_id':None,'status':'fenced'})
  invalid(validator(doc,'CancellationFence'),{'execution_ref':'attempt-a','status':'fenced'})
  invalid(validator(doc,'DestroyRequest'),{'confirm':False,'reason':'test cleanup'})
  valid(validator(doc,'DestroyRequest'),{'confirm':True,'reason':'test cleanup'})
 def test_profile_configuration(self):
  schema=load('profiles.schema.json');Draft202012Validator.check_schema(schema)
  v=Draft202012Validator(schema)
  template=load('profiles.template.json');invalid(v,template)
  # Synthetic schema fixture only: never a deployable image digest/pin.
  template['sandboxes']['minimal-linux:v1']['image']='example.invalid/test-fixture@sha256:'+'0'*64
  valid(v,template)
  configured=copy.deepcopy(template)
  configured['sandboxes']['minimal-linux:v1']['entrypoint']=['/usr/local/bin/python3','-c','import time; time.sleep(3600)']
  configured['sandboxes']['minimal-linux:v1']['cmd']=[]
  valid(v,configured)
  configured['sandboxes']['minimal-linux:v1']['entrypoint']=[]
  invalid(v,configured)
  workloads=template['workloads']
  for value in workloads.values():Draft202012Validator.check_schema(value['arguments_schema'])
  write=Draft202012Validator(workloads['fixture-write-file:v1']['arguments_schema'])
  valid(write,{'file':'hello-world.txt','text':'hello'})
  for path in ('../secret','/etc/passwd','x/y','..','$(touch pwned)'):
   invalid(write,{'file':path,'text':'hello'})
  invalid(write,{'file':'file.txt','text':'hello','command':'evil'})
  invalid(write,{'file':'file.txt','text':'x'*4097})
 def test_scoped_transfer_addition_preserves_existing_wire_shapes(self):
  doc=load('provider-v1.openapi.json')
  valid(validator(doc,'FileUploadRequest'),{'path':'requests/request-1/inputs/a.txt','size_bytes':1,'sha256':'a'*64})
  valid(validator(doc,'FileChunkRequest'),{'offset':0,'data_base64':'YQ==','sha256':'a'*64})
  valid(validator(doc,'FileReadRequest'),{'path':'outputs/a.docx','offset':0,'max_bytes':1048576})
  for path in ('../secret','/etc/passwd','x//y','.uploads/private','https://host/file'):
   invalid(validator(doc,'FileUploadRequest'),{'path':path,'size_bytes':1,'sha256':'a'*64})
  invalid(validator(doc,'FileUploadRequest'),{'path':'a','size_bytes':268435457,'sha256':'a'*64})
  invalid(validator(doc,'FileReadRequest'),{'path':'a','offset':0,'max_bytes':1048577})
  # Existing strict Result remains consumable unchanged by Runner/application.
  self.assertEqual(set(doc['components']['schemas']['Result']['properties']),{'exit_code','stdout','stderr','output_truncated','artifacts'})
  schema=load('profiles.schema.json');template=load('profiles.template.json')
  template['sandboxes']['minimal-linux:v1']['image']='example.invalid/test-fixture@sha256:'+'0'*64
  template['workloads']['fixture-read-file:v1']['secret_environment']={'MODEL_KEY':'WORKLOAD_SECRET_MODEL_KEY'}
  valid(Draft202012Validator(schema),template)
  template['workloads']['fixture-read-file:v1']['secret_environment']['MODEL_KEY']='DATABASE_URL'
  invalid(Draft202012Validator(schema),template)
 def test_response_and_error_fixtures(self):
  doc=load('provider-v1.openapi.json')
  valid(validator(doc,'Error'),{'code':'sandbox_busy','message':'Sandbox has an active run','retryable':True,'correlation_id':'corr_a'})
  valid(validator(doc,'EventPage'),{'events':[{'event_id':'evt_a','type':'sandbox.created','status':'running','occurred_at':'2026-11-03T12:00:00Z','correlation_id':'corr_a','actor_id':'runner','owner_id':'client-a','target_id':'sbx_a','sandbox_id':'sbx_a','detail':{}}],'next_cursor':None})
  valid(validator(doc,'Run'),{'run_id':'run_a','sandbox_id':'sbx_a','execution_ref':'job_a.attempt_1','profile':'fixture-write-file:v1','status':'completed','created_at':'2026-11-03T12:00:00Z','updated_at':'2026-11-03T12:00:01Z','result':{'exit_code':0,'stdout':'written\n','stderr':'','output_truncated':False,'artifacts':[]},'error':None})

if __name__=='__main__':unittest.main(verbosity=2)
