#!/usr/bin/env node
/** Operator-only logical data archive; run inside the owning Runner container.
 * No database credentials, row payloads or plaintext snapshots are printed.
 * DATABASE_URL is the only database accessed. Default: export to one encrypted
 * JSON envelope on stdout. Key: SANDBOX_PROVIDER_TOKEN, or an explicit
 * PHASE1_ARCHIVE_PASSWORD for an operator-selected archive key.
 *
 * Envelope crypto is shared with migration-archive.py: PBKDF2-HMAC-SHA256,
 * 200000 rounds, 48 bytes -> AES256CBC key(32)+IV(16). Independently derive a
 * 32-byte MAC key using mac_salt; authenticate the newline-delimited header
 * fields listed in macInput(), including ciphertext. Verify HMAC BEFORE CBC
 * decryption. table.rows are raw PostgreSQL JSON text strings: do not parse
 * them through a JavaScript number parser when restoring bigint values.
 * Native schema/extension definitions are not included: apply the same pinned
 * service/Graphile migrations first, then insert in foreign-key order into a
 * quiescent fresh destination, use OVERRIDING SYSTEM VALUE for identity columns,
 * preserve generated columns by omitting them, and restore sequence values.
 */
import {createRequire} from 'node:module';
import {createCipheriv,createDecipheriv,createHmac,randomBytes,pbkdf2Sync,createHash,timingSafeEqual} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const SERVICE='job-runner', ITERATIONS=200000;
const q=value=>'"'+value.replaceAll('"','""')+'"';
export const macInput=e=>['workflow-agents-database-archive',e.version,e.service,e.cipher,e.kdf,e.iterations,e.salt_b64,e.mac_salt_b64,e.ciphertext_b64].join('\n');

export function seal(snapshot,password){
  if(typeof password!=='string'||password.length<24)throw new Error('Invalid archive key');
  const plaintext=Buffer.from(JSON.stringify(snapshot));
  if(plaintext.length>64*1024*1024)throw new Error('Snapshot exceeds operator archive bound');
  const salt=randomBytes(8),macSalt=randomBytes(16);
  const material=pbkdf2Sync(password,salt,ITERATIONS,48,'sha256');
  const cipher=createCipheriv('aes-256-cbc',material.subarray(0,32),material.subarray(32));
  const ciphertext=Buffer.concat([cipher.update(plaintext),cipher.final()]);
  const result={archive:'workflow-agents-database-archive',version:1,service:snapshot.service||SERVICE,cipher:'aes-256-cbc+hmac-sha256',kdf:'pbkdf2-hmac-sha256',iterations:ITERATIONS,salt_b64:salt.toString('base64'),mac_salt_b64:macSalt.toString('base64'),ciphertext_b64:ciphertext.toString('base64')};
  const macKey=pbkdf2Sync(password,macSalt,ITERATIONS,32,'sha256');
  result.hmac_sha256=createHmac('sha256',macKey).update(macInput(result)).digest('hex');
  return result;
}

export function unseal(envelope,password,expectedService){
  if(envelope.archive!=='workflow-agents-database-archive'||envelope.version!==1||envelope.cipher!=='aes-256-cbc+hmac-sha256'||envelope.kdf!=='pbkdf2-hmac-sha256'||envelope.iterations!==ITERATIONS||!['job-runner','sandbox-provider'].includes(envelope.service)||(expectedService&&envelope.service!==expectedService))throw new Error('archive_envelope_invalid');
  const decode=(value)=>{if(typeof value!=='string')throw new Error('archive_envelope_invalid');const bytes=Buffer.from(value,'base64');if(bytes.toString('base64')!==value)throw new Error('archive_envelope_invalid');return bytes;};
  const salt=decode(envelope.salt_b64),macSalt=decode(envelope.mac_salt_b64),ciphertext=decode(envelope.ciphertext_b64);
  if(![8,16].includes(salt.length)||macSalt.length!==16||!ciphertext.length||ciphertext.length%16||ciphertext.length>64*1024*1024||typeof envelope.hmac_sha256!=='string'||!/^[a-f0-9]{64}$/.test(envelope.hmac_sha256))throw new Error('archive_envelope_invalid');
  const macKey=pbkdf2Sync(password,macSalt,ITERATIONS,32,'sha256');
  const expected=createHmac('sha256',macKey).update(macInput(envelope)).digest();
  if(!timingSafeEqual(expected,Buffer.from(envelope.hmac_sha256,'hex')))throw new Error('archive_authentication_failed');
  const material=pbkdf2Sync(password,salt,ITERATIONS,48,'sha256'),cipher=createDecipheriv('aes-256-cbc',material.subarray(0,32),material.subarray(32));
  const snapshot=JSON.parse(Buffer.concat([cipher.update(ciphertext),cipher.final()]).toString());
  if(snapshot.service!==envelope.service)throw new Error('archive_service_mismatch');
  return snapshot;
}

const timestampBootstrap={
  'runner.schema_migrations':['applied_at'],
  'graphile_worker.migrations':['ts'],
};
const rowDigest=rows=>createHash('sha256').update(rows.join('\n')).digest('hex');
function normalizedRow(raw,ignored=[]){const row=JSON.parse(raw);for(const field of ignored)delete row[field];return JSON.stringify(row);}

export async function restore(client,snapshot,{allowBootstrapMetadata=false}={}){
  if(snapshot.format!=='workflow-agents-logical-snapshot'||snapshot.version!==1||snapshot.service!==SERVICE||JSON.stringify(snapshot.schemas)!==JSON.stringify(['runner','graphile_worker'])||!Array.isArray(snapshot.tables)||!Array.isArray(snapshot.sequences))throw new Error('archive_snapshot_invalid');
  const byName=new Map(snapshot.tables.map(t=>[t.schema+'.'+t.name,t]));
  if(byName.size!==snapshot.tables.length)throw new Error('archive_snapshot_invalid');
  for(const t of snapshot.tables){
    if(!['runner','graphile_worker'].includes(t.schema)||!Array.isArray(t.rows)||t.row_count!==t.rows.length||rowDigest(t.rows)!==t.rows_sha256)throw new Error('archive_snapshot_invalid');
    if(t.name==='_private_jobs'&&t.rows.length)throw new Error('archive_source_not_quiescent');
    if(t.schema==='runner'&&t.name==='jobs'&&t.rows.some(raw=>!['completed','failed','cancelled','timed_out'].includes(JSON.parse(raw).status)))throw new Error('archive_source_not_quiescent');
    if(t.schema==='runner'&&t.name==='schedules'&&t.rows.some(raw=>JSON.parse(raw).status==='pending'))throw new Error('archive_source_not_quiescent');
  }
  await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
  try{
    await client.query("SET LOCAL TIME ZONE 'UTC'");await client.query('SET LOCAL extra_float_digits=3');await client.query("SET LOCAL lock_timeout='15s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('workflow-agents-migration-restore:job-runner',0))");
    const targets=(await client.query("SELECT n.nspname AS schema,c.relname AS name,c.oid::text AS oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=ANY($1::text[]) AND c.relkind IN ('r','p') AND NOT c.relispartition ORDER BY n.nspname,c.relname",[['runner','graphile_worker']])).rows;
    if(JSON.stringify(targets.map(t=>t.schema+'.'+t.name))!==JSON.stringify([...byName.keys()].sort()))throw new Error('archive_destination_schema_mismatch');
    await client.query('LOCK TABLE '+targets.map(t=>q(t.schema)+'.'+q(t.name)).join(',')+' IN ACCESS EXCLUSIVE MODE');
    const destinationSequences=(await client.query("SELECT n.nspname AS schema,c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=ANY($1::text[]) AND c.relkind='S' ORDER BY n.nspname,c.relname",[['runner','graphile_worker']])).rows;
    if(JSON.stringify(destinationSequences)!==JSON.stringify(snapshot.sequences.map(({schema,name})=>({schema,name}))))throw new Error('archive_destination_sequence_mismatch');
    let reconciled=0;
    for(const target of targets){
      const table=byName.get(target.schema+'.'+target.name);
      const columns=(await client.query("SELECT a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS not_null,a.attidentity AS identity,a.attgenerated AS generated FROM pg_attribute a WHERE a.attrelid=$1::oid AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum",[target.oid])).rows;
      if(JSON.stringify(columns)!==JSON.stringify(table.columns.map(({name,type,not_null,identity,generated})=>({name,type,not_null,identity,generated}))))throw new Error('archive_destination_schema_mismatch');
      const targetRows=(await client.query(`SELECT to_jsonb(t)::text AS row_json FROM ${q(target.schema)}.${q(target.name)} t ORDER BY to_jsonb(t)::text COLLATE "C"`)).rows.map(r=>r.row_json);
      const sourceSet=new Set(table.rows),ignored=timestampBootstrap[target.schema+'.'+target.name];
      const mismatches=targetRows.filter(raw=>!sourceSet.has(raw));
      if(mismatches.length){
        if(!allowBootstrapMetadata||!ignored)throw new Error('archive_destination_rows_conflict');
        const sourceNormalized=table.rows.map(raw=>normalizedRow(raw,ignored)).sort(),targetNormalized=targetRows.map(raw=>normalizedRow(raw,ignored)).sort();
        if(JSON.stringify(sourceNormalized)!==JSON.stringify(targetNormalized))throw new Error('archive_bootstrap_semantics_mismatch');
        const primary=(await client.query("SELECT a.attname AS name FROM pg_constraint k CROSS JOIN LATERAL unnest(k.conkey) WITH ORDINALITY p(attnum,ord) JOIN pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=p.attnum WHERE k.conrelid=$1::oid AND k.contype='p' ORDER BY p.ord",[target.oid])).rows.map(r=>r.name);
        if(!primary.length)throw new Error('archive_bootstrap_primary_key_missing');
        for(const raw of table.rows){
          const sql=`UPDATE ${q(target.schema)}.${q(target.name)} t SET ${ignored.map(c=>q(c)+'=s.'+q(c)).join(',')} FROM json_populate_record(NULL::${q(target.schema)}.${q(target.name)},$1::json) s WHERE ${primary.map(c=>'t.'+q(c)+' IS NOT DISTINCT FROM s.'+q(c)).join(' AND ')}`;
          await client.query(sql,[raw]);
        }
        reconciled+=mismatches.length;
      }
    }
    const remaining=new Map(byName),ordered=[];
    while(remaining.size){let progress=false;for(const [name,table]of remaining){if((table.foreign_keys??[]).every(k=>!remaining.has(k.referenced_schema+'.'+k.referenced_table)||k.referenced_schema+'.'+k.referenced_table===name)){ordered.push(table);remaining.delete(name);progress=true;}}if(!progress)throw new Error('archive_foreign_key_cycle');}
    for(const table of ordered){
      const columns=table.columns.filter(c=>!c.generated).map(c=>c.name),relation=q(table.schema)+'.'+q(table.name);
      for(const row of table.rows)await client.query(`INSERT INTO ${relation}(${columns.map(q).join(',')}) OVERRIDING SYSTEM VALUE SELECT ${columns.map(q).join(',')} FROM json_populate_record(NULL::${relation},$1::json) ON CONFLICT DO NOTHING`,[row]);
    }
    const results=[];
    for(const table of ordered){
      const rows=(await client.query(`SELECT to_jsonb(t)::text AS row_json FROM ${q(table.schema)}.${q(table.name)} t ORDER BY to_jsonb(t)::text COLLATE "C"`)).rows.map(r=>r.row_json);
      if(rows.length!==table.row_count||rowDigest(rows)!==table.rows_sha256)throw new Error('archive_restored_rows_mismatch');
      results.push({table:table.schema+'.'+table.name,rows:rows.length,rows_sha256:table.rows_sha256});
    }
    // PostgreSQL sequence setval is not transactional; destination must stay
    // quiescent until success. A failed/interrupted restore can be safely replayed.
    for(const sequence of snapshot.sequences){
      if(typeof sequence.last_value!=='string'||!/^\d+$/.test(sequence.last_value)||typeof sequence.is_called!=='boolean')throw new Error('archive_sequence_invalid');
      await client.query('SELECT setval($1::regclass,$2::bigint,$3)',[q(sequence.schema)+'.'+q(sequence.name),sequence.last_value,sequence.is_called]);
    }
    await client.query('COMMIT');
    return{operation:'logical-database-restore',service:SERVICE,outcome:'passed',tables:results,sequences:snapshot.sequences.length,bootstrap_timestamp_rows_reconciled:reconciled,scope:'logical rows only; no VM disk or host recovery proof'};
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
}

export async function collect(client){
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try{
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    await client.query('SET LOCAL extra_float_digits=3');
    const meta=(await client.query("SELECT current_database() AS database, transaction_timestamp()::text AS snapshot_at, txid_current_snapshot()::text AS transaction_snapshot")).rows[0];
    const relations=(await client.query("SELECT n.nspname AS schema,c.relname AS name,c.oid::text AS oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=ANY($1::text[]) AND c.relkind IN ('r','p') AND NOT c.relispartition ORDER BY n.nspname,c.relname",[['runner','graphile_worker']])).rows;
    const sequenceNames=(await client.query("SELECT n.nspname AS schema,c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=ANY($1::text[]) AND c.relkind='S' ORDER BY n.nspname,c.relname",[['runner','graphile_worker']])).rows;
    async function sequences(){const result=[];for(const sequence of sequenceNames){const row=(await client.query(`SELECT last_value::text AS last_value,is_called FROM ${q(sequence.schema)}.${q(sequence.name)}`)).rows[0];result.push({...sequence,...row});}return result;}
    const beforeSequences=await sequences(),tables=[];
    for(const table of relations){
      const columns=(await client.query("SELECT a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS not_null,a.attidentity AS identity,a.attgenerated AS generated,pg_get_expr(d.adbin,d.adrelid) AS default_expression FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=$1::oid AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum",[table.oid])).rows;
      const foreign_keys=(await client.query("SELECT pn.nspname AS referenced_schema,pc.relname AS referenced_table,pg_get_constraintdef(k.oid) AS definition FROM pg_constraint k JOIN pg_class pc ON pc.oid=k.confrelid JOIN pg_namespace pn ON pn.oid=pc.relnamespace WHERE k.conrelid=$1::oid AND k.contype='f' ORDER BY k.conname",[table.oid])).rows;
      const rows=(await client.query(`SELECT to_jsonb(t)::text AS row_json FROM ${q(table.schema)}.${q(table.name)} t ORDER BY to_jsonb(t)::text COLLATE "C"`)).rows.map(r=>r.row_json);
      tables.push({schema:table.schema,name:table.name,columns,foreign_keys,row_count:rows.length,rows_sha256:createHash('sha256').update(rows.join('\n')).digest('hex'),rows});
    }
    const afterSequences=await sequences();
    if(JSON.stringify(beforeSequences)!==JSON.stringify(afterSequences))throw new Error('Sequence activity during export');
    await client.query('COMMIT');
    return{format:'workflow-agents-logical-snapshot',version:1,service:SERVICE,...meta,schemas:['runner','graphile_worker'],tables,sequences:afterSequences,scope:'logical database rows and sequence state only; no VM disks or schema definitions'};
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
}

async function main(){
  let client;
  try{
    const require=createRequire((process.env.PHASE1_APP_ROOT||'/app')+'/package.json');
    const {Client}=require('pg');
    client=new Client({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:10000,query_timeout:30000});
    await client.connect();
    const password=process.env.PHASE1_ARCHIVE_PASSWORD||process.env.SANDBOX_PROVIDER_TOKEN;
    if(process.argv.includes('--restore')){
      let raw=process.env.PHASE1_ARCHIVE_ENVELOPE;
      if(!raw){const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);raw=Buffer.concat(chunks).toString();}
      if(raw.length>100*1024*1024)throw new Error('archive_envelope_invalid');
      const snapshot=unseal(JSON.parse(raw),password,SERVICE);
      console.log(JSON.stringify(await restore(client,snapshot,{allowBootstrapMetadata:process.argv.includes('--allow-bootstrap-metadata')})));
    }else{
      const snapshot=await collect(client);console.log(JSON.stringify(seal(snapshot,password)));
    }
  }catch(error){
    const code=/^archive_[a-z_]+$/.test(error?.message??'')?error.message:'archive_operation_failed';
    console.log(JSON.stringify({archive:'workflow-agents-database-archive',service:SERVICE,error:code}));
    process.exitCode=1;
  }finally{if(client)await client.end().catch(()=>{});}
}

const imported=process.env.PHASE1_ARCHIVE_LIBRARY_ONLY==='1'||(process.argv[1]&&process.argv[1]!=='-'&&import.meta.url!==pathToFileURL(process.argv[1]).href);
if(!imported)await main();
