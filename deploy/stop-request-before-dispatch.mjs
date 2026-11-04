/** User-authorized stop of one exact pending request. Never submits or destroys. */
(async () => {
  const {createRequire} = await import('node:module');
  const {pathToFileURL} = await import('node:url');
  const {setTimeout: sleep} = await import('node:timers/promises');
  const require = createRequire(process.cwd() + '/package.json');
  const {Client} = require('pg');
  const {configuration} = await import(pathToFileURL(process.cwd() + '/dist/config.js'));
  const config = configuration();
  const id = '61530470-de69-4b96-bf99-2843baea9916';
  const sid = 'sbx_212b2f8d323a415b8758e8a532a11a5d';
  const message = 'Stopped at your request. Your original file is preserved.';
  const db = new Client({connectionString: config.databaseUrl, statement_timeout: 15000,
    connectionTimeoutMillis: 10000});
  let locked = false;
  async function provider(method, suffix, body) {
    const r = await fetch(new URL('/v1/sandboxes/' + sid + suffix, config.providerUrl), {
      method, redirect: 'error', signal: AbortSignal.timeout(60000),
      headers: {authorization: 'Bearer ' + config.providerToken,
        'content-type': 'application/json', 'x-correlation-id': id},
      body: body === undefined ? undefined : JSON.stringify(body)});
    if (!r.ok) throw Error('provider_http_' + r.status);
    return r.json();
  }
  async function row() {
    return (await db.query('SELECT id,owner_id,status,sandbox_id,job_id,export_complete,terminal_error,failure_message FROM application.requests WHERE id=$1 AND owner_id=$2',
      [id, config.users[0].owner_id])).rows[0];
  }
  function check(r) {
    if (!r || r.sandbox_id !== sid || r.job_id || r.export_complete ||
        !['pending','failed'].includes(r.status)) throw Error('pre_dispatch_request_guard');
  }
  try {
    await db.connect(); check(await row());
    const before = await provider('GET', '');
    if (before.owner_ref !== 'application:' + id) throw Error('sandbox_identity_guard');
    // Stop first to interrupt the in-flight chunk and release the worker lock.
    // Re-read under that same lock before recording any terminal application state.
    await provider('POST', '/stop', {});
    const until = Date.now() + 25000;
    do {
      locked = (await db.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked', [id])).rows[0].locked;
      if (locked) break;
      await sleep(250);
    } while (Date.now() < until);
    if (!locked) throw Error('request_lock_not_released');
    const r = await row(); check(r);
    const stopped = await provider('GET', '');
    if (stopped.status !== 'stopped' || stopped.owner_ref !== 'application:' + id)
      throw Error('sandbox_stop_unconfirmed');
    if (!(r.terminal_error && r.failure_message === message)) {
      await db.query('BEGIN');
      try {
        const changed = await db.query("UPDATE application.requests SET status='failed',terminal_error=true,sandbox_stopped=true,failure_message=$2,updated_at=now(),next_attempt_at=now() WHERE id=$1 AND job_id IS NULL AND export_complete=false", [id,message]);
        if (changed.rowCount !== 1) throw Error('request_state_changed');
        await db.query("INSERT INTO application.audit(request_id,owner_id,actor_id,action,correlation_id,detail) VALUES($1::uuid,$2,$3,'request.cancelled',$1::text,$4)",
          [id,r.owner_id,config.users[0].username,JSON.stringify({reason:'explicit_user_stop_before_dispatch',sandbox_stopped:true,job_dispatched:false})]);
        await db.query('COMMIT');
      } catch (error) {await db.query('ROLLBACK'); throw error;}
    }
    console.log(JSON.stringify({operation:'user-authorized-pre-dispatch-stop',outcome:'stopped',request_id:id,
      sandbox_id:sid,sandbox_status:stopped.status,job_dispatched:false,original_files_preserved:true,
      application_status:'failed',failure_message:message}));
  } finally {
    try {if (locked) await db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[id]);}
    finally {await db.end();}
  }
})().catch(error => {
  console.log(JSON.stringify({operation:'user-authorized-pre-dispatch-stop',outcome:'failed',
    error_classification:/^[a-z_0-9]+$/.test(error.message) ? error.message : error.name}));
  process.exitCode = 1;
});
