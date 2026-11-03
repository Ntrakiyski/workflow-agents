/** Read-only operator evidence. Run in the owning application container. */
(async () => {
  const { createRequire } = await import('node:module');
  const { createHash } = await import('node:crypto');
  const require = createRequire(process.cwd() + '/package.json');
  const pg = require('pg');
  const { configuration } = await import(process.cwd() + '/dist/config.js');
  const { S3Objects } = await import(process.cwd() + '/dist/storage.js');
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
    const raw = await response.text(); if (Buffer.byteLength(raw) > 1024 * 1024) throw Error('response_bound');
    return JSON.parse(raw);
  }
  async function events(service, path, correlation) {
    let cursor = null; const result = [];
    for (let page = 0; page < 20; page++) {
      const value = await get(service, path + '?limit=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), correlation);
      if (!Array.isArray(value.events)) throw Error('event_schema');
      result.push(...value.events.map(({event_id,type,status,correlation_id,actor_id,job_id,sandbox_id,run_id}) =>
        ({event_id,type,status,correlation_id,actor_id,job_id,sandbox_id,run_id})));
      if (!value.next_cursor) return result;
      if (value.next_cursor === cursor) throw Error('event_cursor');
      cursor = value.next_cursor;
    }
    throw Error('event_page_bound');
  }
  try {
    const owner = config.users[0].owner_id;
    const rows = await pool.query(`SELECT id,owner_id,status,correlation_id,sandbox_id,job_id,
      export_complete,sandbox_stopped,created_at,updated_at FROM application.requests WHERE owner_id=$1 ORDER BY created_at LIMIT 101`, [owner]);
    if (rows.rows.length > 100) throw Error('request_bound');
    const requests = [];
    for (const row of rows.rows) {
      const audit = await pool.query(`SELECT event_id::text,action,correlation_id,actor_id FROM application.audit WHERE request_id=$1 ORDER BY event_id`, [row.id]);
      const files = await pool.query(`SELECT id,kind,size_bytes,sha256,object_key FROM application.files WHERE request_id=$1 ORDER BY id`, [row.id]);
      const checked = [];
      for (const file of files.rows) {
        const bytes = await objects.get(file.object_key, 50 * 1024 * 1024);
        if (bytes.length !== file.size_bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw Error('object_integrity');
        checked.push({id:file.id,kind:file.kind,bytes:file.size_bytes,sha256:file.sha256,verified:true});
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
      requests.push(record);
    }
    console.log(JSON.stringify({version:1,operation:'read-only-application-checkpoint-inspection',outcome:'passed',
      requests,scope:'Owning application database and immutable objects; published Runner/Provider APIs only. No workload replay or service database access.'}));
  } finally { objects.close(); await pool.end(); }
})().catch(error => { console.log(JSON.stringify({operation:'read-only-application-checkpoint-inspection',outcome:'failed',error_classification:/^[a-z_0-9]+$/.test(error.message) ? error.message : error.name})); process.exitCode = 1; });
