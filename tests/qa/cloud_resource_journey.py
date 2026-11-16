#!/usr/bin/env python3
"""Opt-in bounded Cloud-only resource probes on one disposable retained VM.

Uses SDK0.11.0 and the Provider's verified completion adapter directly. This
does not qualify the HTTP APIs, PostgreSQL, GCC deployment or vendor hosts.
Only the exact newly fenced fixture name/server ID can be stopped or removed.
"""
import argparse
import asyncio
import json
import os
from pathlib import Path
import sys
import time
from types import SimpleNamespace
import uuid

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'services/sandbox-provider'))
import boxlite
from provider.cloud_runtime import BoxLiteCloudRuntime


NETWORK_CPU = r'''
import errno,json,os,pathlib,socket,subprocess,sys,time
attempts=[]
for host in ('1.1.1.1','8.8.8.8'):
    try:
        connection=socket.create_connection((host,443),timeout=1)
        connection.close()
        attempts.append({'host':host,'connected':True,'errno':0})
    except OSError as error:
        attempts.append({'host':host,'connected':False,'errno':error.errno})
worker="import json,time;t=time.monotonic();c=time.process_time();x=1\nwhile time.monotonic()-t<2.0:x=(x*1664525+1013904223)%4294967296\nprint(json.dumps({'cpu_seconds':time.process_time()-c,'wall_seconds':time.monotonic()-t}))"
start=time.monotonic()
children=[subprocess.Popen([sys.executable,'-c',worker],stdout=subprocess.PIPE,stderr=subprocess.PIPE) for _ in range(2)]
samples=[]
for child in children:
    out,err=child.communicate(timeout=8)
    if child.returncode or err:raise RuntimeError('cpu_probe_child_failed')
    samples.append(json.loads(out))
wall=time.monotonic()-start
memory={line.split(':')[0]:int(line.split()[1])*1024 for line in pathlib.Path('/proc/meminfo').read_text().splitlines() if line.startswith(('MemTotal:','MemAvailable:','SwapTotal:'))}
fs=os.statvfs('/')
routes=[line.split() for line in pathlib.Path('/proc/net/route').read_text().splitlines()[1:] if line.strip()]
interfaces=[{'name':p.name,'operstate':(p/'operstate').read_text().strip(),'flags':(p/'flags').read_text().strip()} for p in pathlib.Path('/sys/class/net').iterdir()]
print(json.dumps({'cpu_count':os.cpu_count(),'workers':2,'worker_samples':samples,'elapsed_wall_seconds':wall,'aggregate_cpu_seconds':sum(s['cpu_seconds'] for s in samples),'cpu_to_wall_ratio':sum(s['cpu_seconds'] for s in samples)/wall,'memory':memory,'rootfs_capacity_bytes':fs.f_blocks*fs.f_frsize,'rootfs_available_bytes':fs.f_bavail*fs.f_frsize,'interfaces':interfaces,'ipv4_routes':routes,'external_tcp_attempts':attempts}))
'''

DISK = r'''
import errno,json,os,pathlib,time
root=pathlib.Path('/opt/workflow-resource-probe');root.mkdir(exist_ok=True)
target=root/'bounded-fill.bin'
before=os.statvfs(root)
written=0;reason='upper_bound_reached';error_number=None;start=time.monotonic()
maximum=1228*1024*1024
chunk=os.urandom(1024*1024)
try:
    with target.open('xb',buffering=0) as output:
        while written<maximum:
            if time.monotonic()-start>18:
                reason='probe_deadline';break
            try:
                count=output.write(chunk)
                written+=count
                if written%(32*1024*1024)==0:os.fsync(output.fileno())
            except OSError as error:
                error_number=error.errno
                reason='enospc' if error.errno==errno.ENOSPC else 'io_error'
                break
finally:
    if target.exists():target.unlink()
after=os.statvfs(root)
print(json.dumps({'written_bytes':written,'maximum_probe_bytes':maximum,'reason':reason,'errno':error_number,'elapsed_seconds':time.monotonic()-start,'filesystem_capacity_bytes':before.f_blocks*before.f_frsize,'available_before_bytes':before.f_bavail*before.f_frsize,'available_after_bytes':after.f_bavail*after.f_frsize,'temporary_fill_removed':not target.exists()}))
'''

MEMORY = r'''
import json,pathlib,resource,subprocess,sys,time
root=pathlib.Path('/opt/workflow-resource-probe');root.mkdir(exist_ok=True)
progress=root/'memory-progress.json'
def oom_counter():
    values=[line.split()[1] for line in pathlib.Path('/proc/vmstat').read_text().splitlines() if line.startswith('oom_kill ')]
    return int(values[0]) if values else None
before=oom_counter()
memory={line.split(':')[0]:int(line.split()[1])*1024 for line in pathlib.Path('/proc/meminfo').read_text().splitlines() if line.startswith(('MemTotal:','MemAvailable:','SwapTotal:'))}
worker=r"""
import json,pathlib,sys,time
chunks=[];size=0;progress=pathlib.Path(sys.argv[1])
while size<1536*1024*1024:
    block=bytearray(16*1024*1024)
    for offset in range(0,len(block),4096):block[offset]=1
    chunks.append(block);size+=len(block)
    temporary=progress.with_suffix('.tmp')
    temporary.write_text(json.dumps({'touched_bytes':size}))
    temporary.replace(progress)
time.sleep(2)
"""
start=time.monotonic()
child=subprocess.Popen([sys.executable,'-c',worker,str(progress)],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
deadline=False
try:
    out,err=child.communicate(timeout=24)
except subprocess.TimeoutExpired:
    deadline=True;child.kill();out,err=child.communicate(timeout=4)
touched=json.loads(progress.read_text())['touched_bytes'] if progress.exists() else 0
if progress.exists():progress.unlink()
after=oom_counter()
print(json.dumps({'upper_probe_bytes':1536*1024*1024,'last_completed_touched_bytes':touched,'child_exit_code':child.returncode,'child_stdout_bytes':len(out),'child_stderr_bytes':len(err),'deadline_killed_by_probe':deadline,'kernel_oom_kill_before':before,'kernel_oom_kill_after':after,'maximum_child_resident_bytes':resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss*1024,'memory':memory,'elapsed_seconds':time.monotonic()-start,'guest_rlimit_applied':False,'progress_file_removed':not progress.exists()}))
'''


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.tmp')
    with temporary.open('w') as stream:
        os.chmod(temporary, 0o600)
        json.dump(value, stream, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)


class Journey:
    def __init__(self, args):
        self.args = args
        self.session = uuid.uuid4().hex
        self.name = 'workflow-resource-qa-' + self.session
        self.private = ROOT / 'private' / ('cloud-resource-' + self.session)
        self.private.mkdir(mode=0o700, parents=True)
        self.state = {'session': self.session, 'name': self.name, 'runtime_id': None,
                      'creation_dispatched': False, 'executions': [], 'cleanup': 'pending'}
        self.report = {'version': 1, 'session': self.session, 'outcome': 'incomplete',
                       'runtime': 'actual BoxLite Cloud, SDK0.11.0',
                       'scope': 'runtime adapter only; no Provider HTTP/PostgreSQL/GCC deployment proof',
                       'bounds': {'cpus': 1, 'memory_mib': 1024, 'disk_mib': 1024,
                                  'cpu_workers': 2, 'cpu_worker_seconds': 2,
                                  'disk_max_write_mib': 1228, 'disk_deadline_seconds': 18,
                                  'memory_max_touch_mib': 1536, 'memory_child_deadline_seconds': 24},
                       'checks': [], 'cleanup': 'pending',
                       'host_reboot': 'not performed', 'full_escape_qualification': 'not performed',
                       'vendor_host_claims': 'not established'}
        self.persist()
        settings = SimpleNamespace(boxlite_rest_url='https://api.boxlite.ai',
                                   boxlite_api_key=Path(args.key_file).read_text().strip(),
                                   boxlite_account_scope='workflow-resource-qa',
                                   boxlite_rest_path_prefix=None, runtime_request_timeout=45)
        self.adapter = BoxLiteCloudRuntime(settings)
        self.client = None

    def persist(self):
        save(self.private / 'session.json', self.state)
        save(self.args.report, self.report)

    async def request(self, operation, seconds=45):
        return await asyncio.wait_for(operation, timeout=seconds)

    async def exact_info(self):
        reference = self.state['runtime_id']
        if reference:
            info = await self.request(self.client.get_info(reference))
            if info is not None and (info.id != reference or info.name != self.name):
                raise RuntimeError('fixture_identity_mismatch')
            return info
        matches = [info for info in await self.request(self.client.list_info()) if info.name == self.name]
        if len(matches) > 1:
            raise RuntimeError('ambiguous_fixture_name')
        if matches:
            self.state['runtime_id'] = matches[0].id
            self.persist()
            return matches[0]
        return None

    async def wait_state(self, allowed, seconds=80):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            info = await self.exact_info()
            if info is None or info.state.status in allowed:
                return info
            await asyncio.sleep(.5)
        raise RuntimeError('fixture_transition_timeout')

    async def cleanup(self):
        if not self.client or not self.state['creation_dispatched']:
            self.report['cleanup'] = self.state['cleanup'] = 'no allocation dispatched'
            self.persist()
            return
        info = await self.exact_info()
        if info is None:
            self.report['cleanup'] = self.state['cleanup'] = 'confirmed absent'
            self.persist()
            return
        box = await self.request(self.client.get(info.id))
        if info.state.status in ('unknown', 'stopping'):
            info = await self.wait_state({'running', 'configured', 'stopped', 'paused', 'failed'})
        if info is not None and info.state.running:
            try:
                await self.request(box.stop())
            except Exception:
                pass  # Confirm retained identity/state after any lost acknowledgement.
        await self.wait_state({'configured', 'stopped', 'paused', 'failed'})
        for attempt in range(8):
            info = await self.exact_info()
            if info is None:
                break
            try:
                await self.request(self.client.remove(info.id, force=False))
            except Exception:
                pass  # Eventual deletion acknowledgement is resolved by exact ID.
            await asyncio.sleep(1)
        if await self.exact_info() is not None:
            raise RuntimeError('fixture_cleanup_unconfirmed')
        self.report['cleanup'] = self.state['cleanup'] = 'confirmed stopped and removed by exact name/id'
        self.persist()

    async def probe(self, scenario, source, seconds):
        reference = 'resource_' + self.session + '_' + scenario
        self.state['executions'].append({'scenario': scenario, 'reference': reference,
                                         'runtime_execution_id': None, 'dispatched': True})
        self.persist()
        execution = await self.adapter.execute(self.state['runtime_id'],
            ['/usr/local/bin/python3', '-c', source],
            {'working_directory': '/', 'max_output_bytes': 16384, 'environment': {},
             '_result_reference': reference}, seconds)
        self.state['executions'][-1]['runtime_execution_id'] = execution.id()
        self.persist()
        result = await self.request(self.adapter.collect(execution, 16384), seconds + 15)
        if result['exit_code'] or result['output_truncated'] or result['stderr']:
            self.report.setdefault('incomplete_probes', []).append({'scenario': scenario,
                'exit_code': result['exit_code'], 'output_truncated': result['output_truncated'],
                'stdout_bytes': len(result['stdout'].encode()), 'stderr_bytes': len(result['stderr'].encode()),
                'stderr_classification': next((name for name in ('JSONDecodeError', 'MemoryError', 'FileNotFoundError', 'StopIteration', 'TimeoutExpired') if name in result['stderr']), 'unclassified')})
            self.persist()
            raise RuntimeError('probe_result_incomplete_' + scenario)
        value = json.loads(result['stdout'])
        return value

    def record(self, scenario, outcome, observations):
        check = {'scenario': scenario, 'outcome': outcome, 'observations': observations}
        self.report['checks'].append(check)
        self.persist()
        print(json.dumps(check), flush=True)

    async def run(self):
        if boxlite.__version__ != '0.11.0':
            raise RuntimeError('sdk_version_mismatch')
        self.client = await self.adapter._runtime()
        if await self.exact_info() is not None:
            raise RuntimeError('fixture_name_preexists')
        profile = json.loads((ROOT / 'deploy/profiles.cloud.staging.json').read_text())['sandboxes']['cloud-minimal-linux:v1']
        if (profile['cpus'], profile['memory_mib'], profile['disk_mib'], profile['network']) != (1, 1024, 1024, 'denied'):
            raise RuntimeError('approved_profile_changed')
        self.report['profile'] = profile
        self.state['creation_dispatched'] = True
        self.persist()
        options = boxlite.BoxOptions(image=profile['image'], cpus=1, memory_mib=1024, disk_size_gb=1,
            working_dir='/', network=boxlite.NetworkSpec(outbound=boxlite.OutboundNetworkSpec(mode='disabled'),
                inbound=boxlite.InboundNetworkSpec(mode='disabled')), auto_remove=False,
            auto_delete=0, auto_stop=0, auto_resume=False, detach=True,
            entrypoint=profile['entrypoint'], cmd=profile['cmd'])
        box = await self.request(self.client.create(options, name=self.name))
        self.state['runtime_id'] = box.id
        self.report['runtime_id'] = box.id
        self.persist()
        info = await self.exact_info()
        self.adapter._verify_profile(info, profile)
        await self.request(box.start())
        await self.wait_state({'running'})
        self.record('approved_metadata', 'passed', {'cpus': info.cpus, 'memory_mib': info.memory_mib,
            'network_inbound': info.network.inbound.mode, 'network_outbound': info.network.outbound.mode,
            'disk_size_attestation': 'SDK BoxInfo unavailable; guest filesystem observed below'})
        if not self.args.memory_only:
            cpu = await self.probe('network_cpu', NETWORK_CPU, 18)
            denied = (not cpu['ipv4_routes'] and all(not a['connected'] and a['errno'] == 101 for a in cpu['external_tcp_attempts']))
            self.record('network_denied_fixed_ip_probes', 'passed' if denied else 'failed',
                        {'interfaces': cpu['interfaces'], 'ipv4_routes': cpu['ipv4_routes'], 'attempts': cpu['external_tcp_attempts'],
                         'scope': 'two external TCP endpoints only; no universal egress or allowed-host proof'})
            cpu_ok = cpu['cpu_count'] == 1 and .15 <= cpu['cpu_to_wall_ratio'] <= 1.35
            self.record('bounded_two_worker_cpu', 'passed' if cpu_ok else 'unverified', cpu)
            disk = await self.probe('disk', DISK, 30)
            disk_ok = disk['reason'] == 'enospc' and disk['temporary_fill_removed'] and disk['available_after_bytes'] >= disk['available_before_bytes'] - 16*1024*1024
            self.record('bounded_rootfs_capacity', 'passed' if disk_ok else 'unverified', disk)
        memory = await self.probe('memory', MEMORY, 34)
        memory_ok = (memory['child_exit_code'] == -9 and not memory['deadline_killed_by_probe']
                     and memory['memory']['SwapTotal'] == 0
                     and memory['last_completed_touched_bytes'] >= 512*1024*1024
                     and memory['maximum_child_resident_bytes'] <= memory['memory']['MemTotal']*1.125
                     and memory['last_completed_touched_bytes'] < memory['upper_probe_bytes'])
        memory['termination_interpretation'] = ('SIGKILL during bounded memory pressure without probe kill or guest RLIMIT; consistent with guest OOM, but missing kernel oom_kill counter prevents exact cause attestation'
            if memory['kernel_oom_kill_before'] is None else 'Kernel oom_kill counter captured separately; inspect before/after')
        self.record('bounded_memory_pressure', 'passed' if memory_ok else 'unverified', memory)
        self.report['outcome'] = 'passed_bounded_scope' if all(c['outcome'] == 'passed' for c in self.report['checks']) else 'incomplete'
        self.persist()


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--key-file', type=Path, required=True)
    parser.add_argument('--memory-only', action='store_true', help='Run metadata and memory pressure only, avoiding repeated CPU/disk probes')
    parser.add_argument('--report', type=Path, default=ROOT / 'docs/release/cloud-resource-journey.json')
    args = parser.parse_args()
    journey = Journey(args)
    try:
        await journey.run()
    except Exception as error:
        journey.report['error_classification'] = getattr(error, 'code', type(error).__name__)
        journey.report['outcome'] = 'incomplete'
        journey.persist()
    finally:
        try:
            await journey.cleanup()
        except Exception as error:
            journey.report['outcome'] = 'incomplete'
            journey.report['cleanup'] = 'pending exact fixture reconciliation'
            journey.report['cleanup_error_classification'] = getattr(error, 'code', type(error).__name__)
            journey.persist()
        if journey.client:
            journey.client.close()
    print(json.dumps({'outcome': journey.report['outcome'], 'cleanup': journey.report['cleanup'],
                      'session': journey.session}), flush=True)
    return 0 if journey.report['outcome'] == 'passed_bounded_scope' and journey.report['cleanup'].startswith('confirmed') else 1


if __name__ == '__main__':
    raise SystemExit(asyncio.run(main()))
