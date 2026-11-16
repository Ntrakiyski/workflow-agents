import json
import pytest
from .test_provider import create, execute, wait_run


@pytest.mark.integration
async def test_runtime_secret_values_are_not_snapshotted_or_returned(env, monkeypatch):
    app, client, settings, runtime = env
    secret = 'fixture-secret-never-persist-this-value'
    monkeypatch.setenv('WORKLOAD_SECRET_DEMO', secret)
    settings.profiles['workloads']['future-workload:v7']['secret_environment'] = {'MODEL_KEY': 'WORKLOAD_SECRET_DEMO'}
    original_execute, original_collect = runtime.execute, runtime.collect
    dispatched = []
    async def execute_runtime(name, argv, profile, timeout):
        dispatched.append(profile['environment']['MODEL_KEY'])
        return await original_execute(name, argv, profile, timeout)
    async def collect_runtime(execution, maximum):
        result = await original_collect(execution, maximum)
        return result | {'stdout': 'unexpected tool output: ' + secret}
    runtime.execute, runtime.collect = execute_runtime, collect_runtime
    sid = await create(client)
    rid = await execute(client, sid, 'with-secret', 'future-workload:v7', {})
    result = await wait_run(client, sid, rid)
    assert result['status'] == 'completed' and secret not in json.dumps(result)
    assert result['result']['stdout'] == 'unexpected tool output: [redacted]' and dispatched == [secret]
    async with app.state.service.db.tx() as c:
        row = await (await c.execute('SELECT profile_snapshot,result FROM runs WHERE run_id=%s', (rid,))).fetchone()
        assert secret not in json.dumps(row) and row['profile_snapshot']['secret_environment']['MODEL_KEY'] == 'WORKLOAD_SECRET_DEMO'
    monkeypatch.delenv('WORKLOAD_SECRET_DEMO')
    rid = await execute(client, sid, 'missing-secret', 'future-workload:v7', {})
    result = await wait_run(client, sid, rid)
    assert result['status'] == 'failed' and result['error']['code'] == 'workload_secret_unavailable'
    assert runtime.executes == 1  # Missing secret fails before any workload dispatch.
