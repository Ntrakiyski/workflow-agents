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
import {createCipheriv,createHmac,randomBytes,pbkdf2Sync,createHash,timingSafeEqual} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const SERVICE='job-runner', ITERATIONS=200000;
const q=value=>'"'+value.replaceAll('"','""')+'"';
export const macInput=e=>['workflow-agents-database-archive',e.version,e.service,e.cipher,e.kdf,e.iterations,e.salt_b64,e.mac_salt_b64,e.ciphertext_b64].join('\n');

export function seal(snapshot,password){
  if(typeof password!=='string'||password.length<24)throw new Error('Invalid archive key');
  const plaintext=Buffer.from(JSON.stringify(snapshot));
  if(plaintext.length>64*1024*1024)throw new Error('Snapshot exceeds operator archive bound');
  const salt=randomBytes(16),macSalt=randomBytes(16);
  const material=pbkdf2Sync(password,salt,ITERATIONS,48,'sha256');
  const cipher=createCipheriv('aes-256-cbc',material.subarray(0,32),material.subarray(32));
  const ciphertext=Buffer.concat([cipher.update(plaintext),cipher.final()]);
  const result={archive:'workflow-agents-database-archive',version:1,service:SERVICE,cipher:'aes-256-cbc+hmac-sha256',kdf:'pbkdf2-hmac-sha256',iterations:ITERATIONS,salt_b64:salt.toString('base64'),mac_salt_b64:macSalt.toString('base64'),ciphertext_b64:ciphertext.toString('base64')};
  const macKey=pbkdf2Sync(password,macSalt,ITERATIONS,32,'sha256');
  result.hmac_sha256=createHmac('sha256',macKey).update(macInput(result)).digest('hex');
  return result;
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
    const snapshot=await collect(client);
    const envelope=seal(snapshot,process.env.PHASE1_ARCHIVE_PASSWORD||process.env.SANDBOX_PROVIDER_TOKEN);
    console.log(JSON.stringify(envelope));
  }catch{
    console.log(JSON.stringify({archive:'workflow-agents-database-archive',service:SERVICE,error:'Logical archive export failed; no plaintext data emitted'}));
    process.exitCode=1;
  }finally{if(client)await client.end().catch(()=>{});}
}

const imported=process.env.PHASE1_ARCHIVE_LIBRARY_ONLY==='1'||(process.argv[1]&&process.argv[1]!=='-'&&import.meta.url!==pathToFileURL(process.argv[1]).href);
if(!imported)await main();
