#!/usr/bin/env python3
"""Opt-in actual Cloud transfer/checkpoint qualification on disposable resources.

Creates one isolated local PostgreSQL container and a private loopback Provider;
guests execute at BoxLite Cloud. Only exact session-owned sandbox IDs may be
stopped/destroyed. Registry restore is forensic only, never a second Provider
against the source guest binding. This is not GCC deployment or a VM clone.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import secrets
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[2]
CHUNK = 1048576
TERMINAL = {'completed', 'failed', 'cancelled', 'timed_out'}


def sha(value):
    return hashlib.sha256(value).hexdigest()


def free_port():
    with socket.socket() as connection:
        connection.bind(('127.0.0.1', 0))
        return connection.getsockname()[1]


def wait_for(read, predicate, seconds=100):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        try:
            value = read()
            if predicate(value):
                return value
        except (OSError, urllib.error.URLError):
            pass
        time.sleep(.2)
    raise RuntimeError('qualification_wait_timeout')


class Journey:
    def __init__(self, args):
        self.args, self.session = args, uuid.uuid4().hex
        files = sorted((ROOT/'services/sandbox-provider/provider').glob('*.py'))
        self.source = {'git_commit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),
                       'provider_files_sha256':{str(path.relative_to(ROOT)):sha(path.read_bytes()) for path in files},
                       'harness_sha256':sha(Path(__file__).read_bytes())}
        self.private = ROOT / 'private' / ('cloud-transfer-' + self.session)
        self.private.mkdir(parents=True, mode=0o700)
        self.owner = 'transfer-qa-' + self.session
        self.tokens = {key: secrets.token_urlsafe(32) for key in ('owner', 'other')}
        self.port = free_port()
        self.containers, self.boxes, self.logs, self.checks = [], [], [], []
        self.process, self.env = None, None
        self.save_manifest()

    def save_manifest(self):
        manifest = self.private / 'session.json'
        manifest.write_text(json.dumps({'session': self.session, 'owner': self.owner, 'tokens': self.tokens,
                                        'containers': self.containers, 'sandboxes': self.boxes}, indent=2))
        manifest.chmod(0o600)

    def request(self, method, path, body=None, key=None, expected=(200,202), token='owner'):
        headers = {'Authorization': 'Bearer ' + self.tokens[token], 'X-Correlation-ID': 'qa_' + self.session}
        if key:
            headers['Idempotency-Key'] = key
        data = None if body is None else json.dumps(body, separators=(',', ':')).encode()
        if data is not None:
            headers['Content-Type'] = 'application/json'
        request = urllib.request.Request(f'http://127.0.0.1:{self.port}' + path, data=data, headers=headers, method=method)
        try:
            response = urllib.request.urlopen(request, timeout=70)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            value = json.loads(response.read(2*1024*1024))
            if response.status not in expected:
                raise RuntimeError('unexpected_http_' + str(response.status) + '_' + str(value.get('code')))
            return value

    def database(self, label):
        port, password = free_port(), secrets.token_urlsafe(32)
        name = 'workflow-transfer-qa-' + label + '-' + self.session[:10]
        self.containers.append(name)
        self.save_manifest()
        env = dict(os.environ, POSTGRES_PASSWORD=password)
        subprocess.run(['docker','run','-d','--name',name,'--label','workflow-agents.qa='+self.session,
                        '--memory=256m','--cpus=.5','-p',f'127.0.0.1:{port}:5432',
                        '-e','POSTGRES_PASSWORD','postgres:16-alpine'], env=env, check=True, stdout=subprocess.DEVNULL)
        wait_for(lambda: subprocess.run(['docker','exec',name,'pg_isready','-U','postgres'],
                                       stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode,
                 lambda value:value == 0,30)
        return name, f'postgresql://postgres:{password}@127.0.0.1:{port}/postgres'

    def start(self):
        log = (self.private / 'provider.jsonl').open('ab')
        self.logs.append(log)
        self.process = subprocess.Popen([self.args.python,'-m','provider.app'], cwd=ROOT/'services/sandbox-provider',
                                        env=self.env, stdout=log,stderr=log,start_new_session=True)
        wait_for(lambda:self.request('GET','/health/ready'),lambda value:value['status']=='ok',80)

    def restart(self):
        os.killpg(self.process.pid, signal.SIGKILL)
        self.process.wait(timeout=10)
        self.start()

    def setup(self):
        name,self.database_url = self.database('registry')
        self.registry_container = name
        profiles = json.loads((ROOT/'deploy/profiles.cloud.staging.json').read_text())
        def workload(source, duration=40):
            compile(source,'<approved-qualification-fixture>','exec')
            return {'sandbox_profiles':['cloud-minimal-linux:v1'],'working_directory':'/',
                    'max_duration_seconds':duration,'max_output_bytes':4096,'environment':{},
                    'arguments_schema':{'type':'object','properties':{},'additionalProperties':False},
                    'argv':['/usr/local/bin/python3','-c',source]}
        profiles['workloads']['transfer-symlink-fixture:v1'] = workload(
            'import os,pathlib; p=pathlib.Path("/opt/workflow-transfer/outputs");p.mkdir(exist_ok=True);'
            'os.symlink("/etc/passwd",p/"symlink.txt");print("created")')
        delayed = 'import pathlib,time;time.sleep(8);pathlib.Path("/opt/workflow-transfer/sentinel/late.txt").write_text("unsafe descendant survived")'
        profiles['workloads']['transfer-delayed-descendant:v1'] = workload(
            'import pathlib,subprocess,sys,time; p=pathlib.Path("/opt/workflow-transfer/sentinel");p.mkdir(parents=True,exist_ok=True);'
            '(p/"ready.txt").write_text("ready");'
            'subprocess.Popen([sys.executable,"-c",' + repr(delayed) + ']);'
            'time.sleep(25);print("finished")',40)
        profiles['workloads']['transfer-sentinel-inspect:v1'] = workload(
            'import json,pathlib;p=pathlib.Path("/opt/workflow-transfer/sentinel");'
            'print(json.dumps({"ready":(p/"ready.txt").exists(),"late":(p/"late.txt").exists()}))')
        permissions = ['sandbox:'+v for v in ('read','create','start','stop','execute','cancel','destroy','file:read','file:write')]
        policy = {'actor_id':'transfer-qualification','owner_id':self.owner,'permissions':permissions,
                  'sandbox_profiles':['cloud-minimal-linux:v1'],'workload_profiles':list(profiles['workloads'])}
        auth = [{**policy,'token':self.tokens['owner']},{**policy,'owner_id':'other-'+self.session,'token':self.tokens['other']}]
        self.env = dict(os.environ,DATABASE_URL=self.database_url,PROVIDER_AUTH_JSON=json.dumps(auth),
                        PROVIDER_PROFILES_JSON=json.dumps(profiles),HOST='127.0.0.1',PORT=str(self.port),
                        SANDBOX_RUNTIME_MODE='cloud',BOXLITE_REST_URL='https://api.boxlite.ai',
                        BOXLITE_API_KEY=Path(self.args.key_file).read_text().strip(),
                        BOXLITE_ACCOUNT_SCOPE='workflow-transfer-'+self.session[:16],
                        BOX_ROOT=str(self.private/'boxlite'),RUN_POLL_SECONDS='.1',MAX_CONCURRENT_RUNS='1')
        self.start()

    def record(self, scenario, **values):
        value = {'scenario':scenario,'outcome':'passed',**values}
        self.checks.append(value)
        print(json.dumps(value),flush=True)

    def box(self, label):
        owner_ref = self.owner+':'+label
        try:
            box = self.request('POST','/v1/sandboxes',{'owner_ref':owner_ref,'profile':'cloud-minimal-linux:v1','persistent':True},
                               key=label+':'+self.session,expected=(201,))
        except Exception:
            import psycopg
            with psycopg.connect(self.database_url) as connection:
                row = connection.execute('SELECT sandbox_id FROM sandboxes WHERE owner_id=%s AND owner_ref=%s',(self.owner,owner_ref)).fetchone()
                if row:
                    self.boxes.append(row[0]);self.save_manifest()
            raise
        self.boxes.append(box['sandbox_id']);self.save_manifest()
        return box['sandbox_id']

    def events(self,sid):
        events,cursor=[],None
        for _ in range(50):
            page=self.request('GET',f'/v1/sandboxes/{sid}/events'+('?cursor='+cursor if cursor else ''))
            events.extend(page['events']);cursor=page['next_cursor']
            if not cursor:
                return events
        raise RuntimeError('audit_pagination_bound')

    def upload(self,sid,path,data,key,replay=False):
        base=f'/v1/sandboxes/{sid}/files/uploads'
        body={'path':path,'size_bytes':len(data),'sha256':sha(data)}
        value=self.request('POST',base,body,key,expected=(201,))
        if replay:
            assert self.request('POST',base,body,key,expected=(201,))==value
            conflict=self.request('POST',base,body|{'sha256':'0'*64},key,expected=(409,))
            assert conflict['code']=='idempotency_conflict'
        target=base+'/'+value['upload_id']
        for offset in range(0,len(data),CHUNK):
            part=data[offset:offset+CHUNK]
            chunk={'offset':offset,'data_base64':base64.b64encode(part).decode(),'sha256':sha(part)}
            value=self.request('PATCH',target,chunk)
            assert value['offset']==offset+len(part)
            if replay:
                assert self.request('PATCH',target,chunk)==value
        complete=self.request('POST',target+'/complete',{})
        assert complete['status']=='completed' and complete['sha256']==sha(data)
        if replay:
            assert self.request('POST',target+'/complete',{})==complete
            conflict=self.request('POST',base,body,key+'-other',expected=(409,))
            assert conflict['code']=='file_conflict'
        return complete

    def download(self,sid,path):
        data=bytearray();expected=None
        while True:
            value=self.request('POST',f'/v1/sandboxes/{sid}/files/read',{'path':path,'offset':len(data),'max_bytes':CHUNK})
            metadata=(value['size_bytes'],value['sha256'])
            if expected is None:
                expected=metadata
            assert expected==metadata and value['offset']==len(data)
            part=base64.b64decode(value['data_base64'],validate=True)
            assert len(part)<=CHUNK and (part or value['eof'])
            data.extend(part)
            if value['eof']:
                break
        assert len(data)==expected[0] and sha(data)==expected[1]
        return bytes(data)

    def execute(self,sid,profile,key):
        run=self.request('POST',f'/v1/sandboxes/{sid}/execute',
                         {'execution_ref':key,'profile':profile,'arguments':{},'timeout_seconds':35},key)
        return run['run_id']

    def run_state(self,sid,rid):
        return self.request('GET',f'/v1/sandboxes/{sid}/runs/{rid}')

    def wait_run(self,sid,rid):
        return wait_for(lambda:self.run_state(sid,rid),lambda value:value['status'] in TERMINAL,60)

    def run(self):
        a=self.box('source')
        path='inputs/original.bin'
        data=hashlib.sha256(self.session.encode()).digest()*65536+b'end-of-fixture'
        uploaded=self.upload(a,path,data,'original:'+self.session,replay=True)
        assert self.download(a,path)==data
        self.record('multichunk_upload_download_checksum_and_replay',sandbox_id=a,size_bytes=len(data),
                    chunks=3,sha256=sha(data),upload_id=uploaded['upload_id'])
        denied=self.request('POST',f'/v1/sandboxes/{a}/files/read',{'path':path,'offset':0,'max_bytes':10},expected=(404,),token='other')
        assert denied['code']=='not_found'
        for bad in ('../etc/passwd','/etc/passwd','inputs//original.bin','.uploads/private','https://invalid/file'):
            self.request('POST',f'/v1/sandboxes/{a}/files/read',{'path':bad,'offset':0,'max_bytes':10},expected=(422,))
        self.record('crossowner_and_path_negatives',sandbox_id=a,wrong_owner_http=404,rejected_paths=5)
        base=f'/v1/sandboxes/{a}'
        self.request('POST',base+'/stop',{})
        original_ids={event['event_id'] for event in self.events(a)}
        self.restart()
        self.request('POST',base+'/start',{})
        assert self.download(a,path)==data
        assert original_ids<={event['event_id'] for event in self.events(a)}
        self.record('stop_start_and_provider_process_replacement',sandbox_id=a,sha256=sha(data),retained_audit_event_ids=len(original_ids))
        rid=self.execute(a,'transfer-symlink-fixture:v1','symlink:'+self.session)
        assert self.wait_run(a,rid)['status']=='completed'
        refused=self.request('POST',base+'/files/read',{'path':'outputs/symlink.txt','offset':0,'max_bytes':100},expected=(409,))
        assert refused['code']=='file_transfer_rejected'
        self.request('POST',base+'/start',{})
        assert self.download(a,path)==data
        self.record('actual_guest_symlink_rejected',sandbox_id=a,http=409,code=refused['code'])
        # A supported file checkpoint is explicit exported bytes, never VM clone.
        checkpoint=self.private/'guest-data-checkpoint.bin'
        checkpoint.write_bytes(self.download(a,path));checkpoint.chmod(0o600)
        b=self.box('file-restore')
        absent=self.request('POST',f'/v1/sandboxes/{b}/files/read',{'path':path,'offset':0,'max_bytes':10},expected=(409,))
        assert absent['code']=='file_transfer_rejected'
        self.request('POST',f'/v1/sandboxes/{b}/start',{})
        self.upload(b,'restored/original.bin',checkpoint.read_bytes(),'restore:'+self.session)
        assert self.download(b,'restored/original.bin')==data
        self.record('crosssandbox_absence_and_file_checkpoint_restore',source_sandbox_id=a,restore_sandbox_id=b,
                    distinct_sandbox_identity=a!=b,size_bytes=len(data),sha256=sha(data),
                    strategy='explicit application-selected guest-file export/reupload, not snapshot/VM clone')
        self.destroy(b)
        self.cancellation(a)

    def cancellation(self,a):
        base=f'/v1/sandboxes/{a}'
        rid=self.execute(a,'transfer-delayed-descendant:v1','descendant:'+self.session)
        import psycopg
        def dispatched():
            with psycopg.connect(self.database_url) as connection:
                row=connection.execute('SELECT runtime_execution_id FROM runs WHERE run_id=%s',(rid,)).fetchone()
                return bool(row and row[0])
        wait_for(dispatched,bool,30)
        time.sleep(2)
        self.request('POST',base+'/runs/'+rid+'/cancel',{})
        cancelled=self.wait_run(a,rid)
        assert cancelled['status']=='cancelled'
        assert self.request('GET',base)['status']=='stopped'
        self.request('POST',base+'/start',{})
        time.sleep(10)  # Delayed descendant would have written by now if alive.
        inspect=self.execute(a,'transfer-sentinel-inspect:v1','inspect:'+self.session)
        result=self.wait_run(a,inspect)
        assert result['status']=='completed'
        observed=json.loads(result['result']['stdout'])
        assert observed=={'ready':True,'late':False}
        self.record('cancellation_stops_delayed_descendant',sandbox_id=a,run_id=rid,
                    status=cancelled['status'],ready_marker_present=True,delayed_marker_present=False,post_restart_wait_seconds=10)

    def destroy(self,sid):
        assert sid in self.boxes
        state=self.request('GET','/v1/sandboxes/'+sid)
        if state['status']=='destroyed':
            return
        self.request('POST','/v1/sandboxes/'+sid+'/stop',{})
        self.request('POST','/v1/sandboxes/'+sid+'/destroy',{'confirm':True,'reason':'Exact session-owned transfer qualification fixture cleanup'})

    def forensic_restore(self):
        import psycopg
        name,url=self.database('forensic')
        dump=self.private/'registry.dump'
        with dump.open('wb') as output:
            subprocess.run(['docker','exec',self.registry_container,'pg_dump','-Fc','-U','postgres','--no-owner','postgres'],
                           stdout=output,check=True)
        dump.chmod(0o600)
        with dump.open('rb') as source:
            subprocess.run(['docker','exec','-i',name,'pg_restore','-U','postgres','--no-owner','--no-acl','--dbname=postgres'],
                           stdin=source,check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        tables=('sandboxes','runs','file_uploads','idempotency','audit_events','cancellation_fences','schema_migrations')
        comparison={}
        for table in tables:
            from psycopg import sql
            query=sql.SQL('SELECT row_to_json(t)::text FROM {} AS t ORDER BY row_to_json(t)::text').format(sql.Identifier(table))
            values=[]
            for connection_url in (self.database_url,url):
                with psycopg.connect(connection_url) as connection:
                    connection.execute('SET TRANSACTION READ ONLY')
                    rows=[row[0] for row in connection.execute(query).fetchall()]
                    values.append((len(rows),sha('\n'.join(rows).encode())))
            assert values[0]==values[1]
            comparison[table]={'rows':values[0][0],'sha256':values[0][1]}
        self.record('isolated_forensic_registry_restore',tables=comparison,
                    dump_sha256=sha(dump.read_bytes()),audit_event_identities_retained=True,
                    restored_provider_started=False,scope='forensic registry restore only; does not establish guest recovery')

    def close(self):
        errors=[]
        if self.env and self.process and self.process.poll() is None:
            for sid in self.boxes:
                try:
                    self.destroy(sid)
                except Exception:
                    errors.append(sid)
            if not errors:
                try:
                    self.forensic_restore()
                except Exception:
                    errors.append('forensic_restore')
        elif self.boxes:
            errors.extend(self.boxes)
        if self.process and self.process.poll() is None:
            os.killpg(self.process.pid,signal.SIGTERM)
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(self.process.pid,signal.SIGKILL);self.process.wait(timeout=10)
        for log in self.logs:
            log.close()
        if not errors:
            for name in self.containers:
                value=json.loads(subprocess.check_output(['docker','inspect',name]))[0]
                assert value['Config']['Labels']['workflow-agents.qa']==self.session
                subprocess.run(['docker','rm','-f',name],check=True,stdout=subprocess.DEVNULL)
        return errors


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--key-file',required=True)
    parser.add_argument('--python',required=True)
    parser.add_argument('--evidence',required=True)
    args=parser.parse_args()
    os.umask(0o077)
    journey=Journey(args)
    outcome,error='passed',None
    try:
        journey.setup();journey.run()
    except Exception as failure:
        outcome,error='failed',type(failure).__name__
        import traceback
        (journey.private/'failure.txt').write_text(traceback.format_exc())
    finally:
        cleanup_errors=journey.close()
    evidence={'version':1,'session':journey.session,'outcome':outcome,'error_classification':error,
              'checks':journey.checks,'cleanup_pending':cleanup_errors,'runtime':'actual BoxLite Cloud',
              'source':journey.source,
              'provider':'local real source process, not GCC deployment proof','postgresql':'new isolated disposable PostgreSQL16',
              'host_reboot':'not performed','vm_snapshot_clone_export':'not claimed',
              'active_command_reattachment':'still nonretryable ambiguous_execution; no replay'}
    Path(args.evidence).parent.mkdir(parents=True,exist_ok=True)
    Path(args.evidence).write_text(json.dumps(evidence,indent=2)+'\n')
    print(json.dumps(evidence),flush=True)
    return 0 if outcome=='passed' and not cleanup_errors else 1


if __name__=='__main__':
    raise SystemExit(main())
