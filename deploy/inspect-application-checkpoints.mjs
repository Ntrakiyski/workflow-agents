/** Read-only operator evidence. Run in the owning application container. */
(async () => {
  const { createRequire } = await import('node:module');
  const { createHash } = await import('node:crypto');
  const { pathToFileURL } = await import('node:url');
  const require = createRequire(process.cwd() + '/package.json');
  const pg = require('pg');
  const { configuration } = await import(pathToFileURL(process.cwd() + '/dist/config.js'));
  const { S3Objects } = await import(pathToFileURL(process.cwd() + '/dist/storage.js'));
  const config = configuration();
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 1,
    statement_timeout: 15000, options: '-c default_transaction_read_only=on' });
  const objects = new S3Objects(config);
  async function get(service, path, correlation) {
    const response = await fetch(new URL(path, service === 'runner' ? config.runnerUrl : config.providerUrl), {
      redirect: 'error', signal: AbortSignal.timeout(30000), headers: {
        authorization: 'Bearer ' + (service === 'runner' ? config.runnerToken : config.providerToken),
        'x-correlation-id': correlation } });
    if (!response.ok) throw Error('dependency_http_' + response.status);
    if (!response.body) throw Error('response_body');
    const chunks = []; let size = 0; const reader = response.body.getReader();
    for (;;) { const next = await reader.read(); if (next.done) break;
      size += next.value.length; if (size > 1024 * 1024) { await reader.cancel(); throw Error('response_bound'); }
      chunks.push(next.value); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  async function events(service, path, correlation) {
    let cursor = null; const result = [];
    for (let page = 0; page < 20; page++) {
      const value = await get(service, path + '?limit=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), correlation);
      if (!Array.isArray(value.events)) throw Error('event_schema');
      result.push(...value.events.map(({event_id,type,status,occurred_at,correlation_id,actor_id,job_id,sandbox_id,run_id}) =>
        ({event_id,type,status,occurred_at,correlation_id,actor_id,job_id,sandbox_id,run_id})));
      if (!value.next_cursor) return result;
      if (value.next_cursor === cursor) throw Error('event_cursor');
      cursor = value.next_cursor;
    }
    throw Error('event_page_bound');
  }
  try {
    const owner = config.users[0].owner_id;
    const rows = await pool.query(`SELECT id,owner_id,status,correlation_id,sandbox_id,job_id,workspace_id,
      export_complete,sandbox_stopped,created_at,updated_at FROM application.requests WHERE owner_id=$1 ORDER BY created_at LIMIT 101`, [owner]);
    if (rows.rows.length > 100) throw Error('request_bound');
    const requests = [];
    for (const row of rows.rows) {
      const audit = await pool.query(`SELECT event_id::text,action,correlation_id,actor_id FROM application.audit WHERE request_id=$1 ORDER BY application.audit.event_id`, [row.id]);
      const files = await pool.query(`SELECT id,kind,size_bytes,sha256,object_key, CASE WHEN kind='checkpoint' AND name='request.json' THEN 'request_manifest' WHEN kind='checkpoint' AND name='result.json' THEN 'result_manifest' WHEN kind='checkpoint' AND media_type='application/x-ndjson' THEN 'session' ELSE kind END AS role FROM application.files WHERE request_id=$1 ORDER BY id`, [row.id]);
      const checked = [];
      for (const file of files.rows) {
        const bytes = await objects.get(file.object_key, 50 * 1024 * 1024);
        if (bytes.length !== file.size_bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw Error('object_integrity');
        const verified = {id:file.id,kind:file.kind,role:file.role,bytes:file.size_bytes,sha256:file.sha256,verified:true};
        if (row.workspace_id && file.role === 'session') {
          const entries = bytes.toString('utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
          const headers = entries.filter(entry => entry.type === 'session');
          if (headers.length !== 1 || headers[0].id !== row.id || headers[0].cwd !== '/opt/workflow-transfer/requests/' + row.id)
            throw Error('independent_session_identity');
          const times = entries.map(entry => new Date(entry.timestamp ?? entry.message?.timestamp).getTime()).filter(Number.isFinite);
          if (times.length < 2) throw Error('session_times_unverified');
          verified.session = {id:headers[0].id,cwd:headers[0].cwd,first_entry_at:new Date(Math.min(...times)).toISOString(),last_entry_at:new Date(Math.max(...times)).toISOString()};
        }
        checked.push(verified);
      }
      const record = {...row, audit:audit.rows, files:checked};
      if (row.job_id) {
        const job = await get('runner','/v1/jobs/' + encodeURIComponent(row.job_id),row.id);
        if (job.job_id !== row.job_id || job.sandbox_id !== row.sandbox_id) throw Error('job_identity');
        record.runner = {job_id:job.job_id,status:job.status,attempt_count:job.attempt_count,
          events:await events('runner','/v1/jobs/'+encodeURIComponent(row.job_id)+'/events',row.id)};
      }
      if (row.sandbox_id) {
        const sandbox = await get('provider','/v1/sandboxes/'+encodeURIComponent(row.sandbox_id),row.id);
        if (sandbox.sandbox_id !== row.sandbox_id) throw Error('sandbox_identity');
        record.provider = {sandbox_id:sandbox.sandbox_id,status:sandbox.status,
          events:await events('provider','/v1/sandboxes/'+encodeURIComponent(row.sandbox_id)+'/events',row.id)};
      }
      if (row.status === 'completed') {
        if (!row.export_complete || !row.sandbox_stopped || !row.job_id || !row.sandbox_id ||
          record.runner?.status !== 'completed' || record.provider?.status !== 'stopped' ||
          !['request_manifest','result_manifest','session'].every(role => checked.some(file => file.role === role)) ||
          !audit.rows.some(event => event.action === 'request.completed')) throw Error('completed_checkpoint_incomplete');
        record.completed_checkpoint_verified = true;
      }
      requests.push(record);
    }
    const workspaces = await pool.query(`SELECT id,owner_id,sandbox_id,prepare_job_id,runtime_sha256,status,uploaded_bytes,total_bytes,sandbox_stopped FROM application.user_workspaces WHERE owner_id=$1`, [owner]);
    const workspaceAudit = await pool.query(`SELECT event_id::text,action,correlation_id,created_at FROM application.audit WHERE owner_id=$1 AND request_id IS NULL ORDER BY event_id LIMIT 1000`,[owner]);
    console.log(JSON.stringify({version:2,operation:'read-only-application-checkpoint-inspection',outcome:'passed',
      workspaces:workspaces.rows,workspace_audit:workspaceAudit.rows,requests,scope:'Owning application database and immutable objects; published Runner/Provider APIs only. No workload replay or service database access.'}));
  } finally { objects.close(); await pool.end(); }
})().catch(error => { console.log(JSON.stringify({operation:'read-only-application-checkpoint-inspection',outcome:'failed',error_classification:/^[a-z_0-9]+$/.test(error.message) ? error.message : error.name, error_code:/^[A-Z_0-9]+$/.test(error.code??'') ? error.code : undefined})); process.exitCode = 1; });
