"""Read only the two recorded Phase 1 fixture mappings and Cloud metadata.

Run inside Provider; credentials stay in its environment. This opens no local
runtime, issues no Cloud mutation and queries only the Provider's own registry.
"""
import asyncio
import json
import re
import sys
from urllib.parse import urlsplit
from urllib.request import build_opener, HTTPRedirectHandler

import psycopg
from psycopg.rows import dict_row
from provider.config import Settings
from provider.runtime import configured_runtime


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


async def main():
    settings = Settings.from_env()
    assert settings.runtime_mode == 'cloud', 'Cloud configuration required'
    target = urlsplit(sys.argv[1])
    assert (target.scheme == 'https' and target.hostname == 'raw.githubusercontent.com'
            and not target.username and not target.password and not target.query
            and not target.fragment and re.fullmatch(
                r'/Ntrakiyski/workflow-agents/[a-f0-9]{7,40}/docs/phase1/GCC-RETAINED-RECORD.json',
                target.path)), 'Immutable own-repository fixture record required'
    with build_opener(NoRedirect()).open(sys.argv[1], timeout=10) as response:
        raw = response.read(32769)
    assert len(raw) <= 32768, 'Fixture record exceeds bound'
    record = json.loads(raw)
    assert record['version'] == 1 and re.fullmatch(r'gccqa_[a-f0-9]{32}', record['run_id']), 'Invalid fixture record'
    runtime = configured_runtime(settings)
    records = []
    try:
        with psycopg.connect(settings.database_url, row_factory=dict_row,
                             connect_timeout=10, options='-c statement_timeout=10000') as connection:
            connection.execute('SET TRANSACTION READ ONLY')
            for suffix in ('a', 'b'):
                sid = record['sandbox_' + suffix]
                assert re.fullmatch(r'sbx_[a-f0-9]{32}', sid), 'Invalid fixture identifier'
                row = connection.execute('''SELECT sandbox_id,owner_id,owner_ref,profile,profile_snapshot,
                    runtime_name,runtime_id,disk_ref,runtime_backend,runtime_create_attempted,status
                    FROM sandboxes WHERE sandbox_id=%s''', (sid,)).fetchone()
                assert row and row['owner_id'] == record['owner_id'], 'Fixture owner mismatch'
                assert row['owner_ref'] == 'gcc-qa:' + record['run_id'] + ':' + suffix, 'Fixture reference mismatch'
                assert row['runtime_backend'] == runtime.backend_id and row['runtime_id'], 'Fixture backend mismatch'
                await runtime.verify(row['runtime_id'], row['profile_snapshot'])
                client = await runtime._runtime()
                info = await runtime._request(client.get_info(row['runtime_id']))
                assert info.id == row['runtime_id'] and info.name == row['runtime_name'], 'Cloud identity mismatch'
                records.append({k: row[k] for k in ('sandbox_id', 'owner_ref', 'profile', 'runtime_name',
                    'runtime_id', 'disk_ref', 'runtime_backend', 'runtime_create_attempted', 'status')} | {
                    'cloud_id': info.id, 'cloud_name': info.name, 'cloud_state': info.state.status,
                    'image': info.image, 'cpus': info.cpus, 'memory_mib': info.memory_mib,
                    'requested_disk_mib': row['profile_snapshot']['disk_mib'],
                    'auto_delete': info.auto_delete, 'auto_stop': info.auto_stop, 'auto_resume': info.auto_resume,
                    'network': json.loads(str(info.network))})
        report = {'probe': 'phase1-cloud-registry-attestation', 'outcome': 'passed',
                  'scope': 'Read-only own-DB mappings and Cloud control-plane metadata; disk capacity requires guest proof.',
                  'records': records}
        encoded = json.dumps(report, separators=(',', ':'))
        assert settings.boxlite_api_key not in encoded, 'Credential output refused'
        print(encoded)
    finally:
        await runtime.close()


try:
    asyncio.run(main())
except Exception as error:
    print(json.dumps({'probe': 'phase1-cloud-registry-attestation', 'outcome': 'failed',
                      'error_classification': type(error).__name__}))
    raise SystemExit(1)
