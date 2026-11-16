/** Read-only diagnosis of the fixed capacity-qualification pair. No replay. */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const require = createRequire(process.cwd() + '/package.json');
const { configuration } = await import(pathToFileURL(process.cwd() + '/dist/config.js'));
const { HttpExecutionServices } = await import(pathToFileURL(process.cwd() + '/dist/remote.js'));
const config = configuration(), remote = new HttpExecutionServices(config);
const pool = new (require('pg').Pool)({ connectionString: config.databaseUrl, max: 1,
  statement_timeout: 15000, options: '-c default_transaction_read_only=on' });
try {
  const records = [];
  for (const id of ['8490a42a-8667-45f9-889a-bc71d86757b4', '2762eccb-1599-480f-89ac-ce18a2756112']) {
    const row = (await pool.query('SELECT id,status,sandbox_id,job_id,terminal_error FROM application.requests WHERE id=$1 AND owner_id=$2', [id, config.users[0].owner_id])).rows[0];
    if (row?.status !== 'failed' || row.sandbox_id !== 'sbx_90cbc75fdd2c405cab2ffff81fee921c' || !row.job_id) throw Error('fixture_identity');
    const job = await remote.job(row.job_id, id);
    if (job.status !== 'failed' || job.result?.exit_code !== 1) throw Error('failed_result_required');
    const pointer = JSON.parse(job.result.stdout);
    if (pointer.result_path !== 'outputs/result.json' || pointer.size_bytes > 65536) throw Error('manifest_pointer');
    const bytes = await remote.download(row.sandbox_id, 'requests/' + id + '/outputs/result.json', 65536, id);
    if (bytes.length !== pointer.size_bytes || createHash('sha256').update(bytes).digest('hex') !== pointer.sha256) throw Error('manifest_integrity');
    const result = JSON.parse(bytes.toString('utf8'));
    if (result.request_id !== id || result.outcome !== 'failed') throw Error('manifest_identity');
    records.push({ request_id:id, job_id:row.job_id, sandbox_id:row.sandbox_id,
      manifest_sha256:pointer.sha256, validation_codes:result.validations.map(value=>value.code),
      application_error_code:row.terminal_error?.code, runner_status:job.status,
      runner_error_code:job.error?.code, attempt_count:job.attempt_count,
      run_id:job.run_id, exit_code:job.result?.exit_code,
      output_truncated:job.result?.output_truncated,
      result_stdout_bytes:Buffer.byteLength(job.result?.stdout ?? ''),
      result_stderr_bytes:Buffer.byteLength(job.result?.stderr ?? '') });
  }
  console.log(JSON.stringify({ operation:'fixed-capacity-fixture-failure-diagnosis',outcome:'passed',records,
    scope:'Owning application database and published Runner API; safe failure codes and output sizes only. No replay or mutation.' }));
} catch (error) {
  console.log(JSON.stringify({ operation:'fixed-capacity-fixture-failure-diagnosis',outcome:'failed',error_classification:/^[a-z_]+$/.test(error.message??'')?error.message:error.name }));
  process.exitCode=1;
} finally { await pool.end(); }
