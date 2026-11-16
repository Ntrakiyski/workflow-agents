"""Explicit cleanup authority for one recorded, pre-dispatch QA admission only.

Run inside the owning Provider container. No application database is opened.
The failed application request and all audit history remain intact.
"""
import asyncio
import json
from urllib.request import Request, urlopen

import psycopg
from psycopg.rows import dict_row
from provider.config import Settings
from provider.runtime import configured_runtime

SID = 'sbx_71ebecb9dc2242498e8236f811be3b9d'
REQUEST_ID = 'e4ce9738-c52d-4bb7-a862-93d18a2c2962'
OWNER = 'workflow-application'


async def main():
    settings = Settings.from_env()
    assert settings.runtime_mode == 'cloud'
    policies = [p for p in settings.auth if p['actor_id'] == 'workflow-release-qa']
    assert len(policies) == 1
    policy = policies[0]
    assert policy['owner_id'] == OWNER and not policy.get('delegate_owners')
    assert set(policy['permissions']) == {'sandbox:read', 'sandbox:destroy'}
    runtime = configured_runtime(settings)
    try:
        with psycopg.connect(settings.database_url, row_factory=dict_row,
                             options='-c statement_timeout=10000') as connection:
            connection.execute('SET TRANSACTION READ ONLY')
            row = connection.execute('SELECT * FROM sandboxes WHERE sandbox_id=%s', (SID,)).fetchone()
            assert row and row['owner_id'] == OWNER
            assert row['owner_ref'] == 'application:' + REQUEST_ID
            assert row['profile'] == 'pi-document-cloud:v1'
            assert row['runtime_name'] == settings.boxlite_account_scope + '-' + SID
            assert row['runtime_backend'] == runtime.backend_id and row['runtime_id'] is None
            assert row['status'] in ('creating', 'destroying', 'destroyed') and not row['active_run_id']
        # A native allow_net validation failure dispatched no create. Refuse
        # this procedure if the recorded name nevertheless has a runtime.
        assert await runtime.find_creation(row['runtime_name']) is None
        body = json.dumps({'confirm': True, 'reason': 'Recorded browser QA admission failed native policy validation before Cloud dispatch.'}).encode()
        request = Request('http://127.0.0.1:8000/v1/sandboxes/' + SID + '/destroy', data=body,
                          method='POST', headers={'Authorization': 'Bearer ' + policy['token'],
                          'Content-Type': 'application/json', 'X-Correlation-ID': REQUEST_ID})
        with urlopen(request, timeout=30) as response:
            result = json.loads(response.read(65536))
        assert result['sandbox_id'] == SID and result['status'] == 'destroyed'
        assert await runtime.find_creation(row['runtime_name']) is None
        print(json.dumps({'operation': 'cleanup-failed-document-admission', 'outcome': 'passed',
                          'sandbox_id': SID, 'application_request_id': REQUEST_ID,
                          'cloud_name_absent': True, 'registry_status': 'destroyed',
                          'failed_application_request_and_audits': 'preserved'}))
    finally:
        await runtime.close()


try:
    asyncio.run(main())
except Exception as error:
    print(json.dumps({'operation': 'cleanup-failed-document-admission', 'outcome': 'failed',
                      'error_classification': type(error).__name__}))
    raise SystemExit(1)
