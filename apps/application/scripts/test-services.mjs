import { randomBytes } from 'node:crypto';
import { mkdir,writeFile,readFile,chown } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const directory=new URL('../private/test/',import.meta.url);
const configFile=new URL('config.json',directory);
function docker(args){const result=spawnSync('docker',args,{encoding:'utf8'});if(result.status!==0)throw new Error(`Docker command failed: ${result.stderr.slice(0,200)}`);return result.stdout.trim();}
const names=['workflow-app-test-db','workflow-app-test-storage'];
if(process.argv[2]==='down'){for(const name of names){const state=spawnSync('docker',['inspect',name],{encoding:'utf8'});if(state.status===0){const owned=JSON.parse(state.stdout)[0].Config.Labels?.['workflow-agents.test'];if(owned!=='application')throw new Error('Unowned test container');docker(['rm','-f','-v',name]);}}process.exit(0);}
if(process.argv[2]!=='up')throw new Error('Specify up or down');
for(const name of names){if(spawnSync('docker',['inspect',name],{encoding:'utf8'}).status===0)throw new Error('Test container already exists. Reuse private/test/config.json or explicitly run down.');}
await mkdir(directory,{recursive:true,mode:0o700});
const password=randomBytes(24).toString('hex'),accessKey=randomBytes(12).toString('hex'),secret=randomBytes(24).toString('hex');
const pgEnv=new URL('postgres.env',directory);const storageEnv=new URL('storage.env',directory);
await writeFile(pgEnv,`POSTGRES_USER=app_test\nPOSTGRES_DB=workflow_app_test\nPOSTGRES_PASSWORD=${password}\n`,{mode:0o600});
await writeFile(storageEnv,`RUSTFS_ACCESS_KEY=${accessKey}\nRUSTFS_SECRET_KEY=${secret}\nRUSTFS_CONSOLE_ENABLE=false\nRUSTFS_OBS_LOG_DIRECTORY=/data/logs\n`,{mode:0o600});
const data=new URL('storage/',directory);await mkdir(data,{recursive:true,mode:0o700});await chown(data,10001,10001);
docker(['run','-d','--name',names[0],'--label','workflow-agents.test=application','--env-file',pgEnv.pathname,'-p','127.0.0.1:25433:5432','postgres:16-alpine']);
docker(['run','-d','--name',names[1],'--label','workflow-agents.test=application','--env-file',storageEnv.pathname,'-p','127.0.0.1:29002:9000','--mount',`type=bind,source=${data.pathname},target=/data`,'rustfs/rustfs@sha256:1cfa82fb394a7c6a4ffc24f5333b52afee608d258503f94b37fcce5cc965c896','/data']);
const config={databaseUrl:`postgresql://app_test:${password}@127.0.0.1:25433/workflow_app_test`,publicOrigin:'http://127.0.0.1:8082',port:8082,users:[{username:'alice',password_sha256:'',owner_id:'alice'},{username:'bob',password_sha256:'',owner_id:'bob'}],s3Endpoint:'http://127.0.0.1:29002',s3Region:'us-east-1',s3Bucket:'application-test',s3AccessKey:accessKey,s3SecretKey:secret,runnerUrl:'http://127.0.0.1:39998',runnerToken:'test-only-runner',providerUrl:'http://127.0.0.1:39999',providerToken:'test-only-provider',sandboxProfile:'fixture:v1',workloadProfile:'pi-document-agent:v1',runtimeBundleKey:'runtime/test.tar.gz',runtimeBundleSha256:''};
await writeFile(configFile,JSON.stringify(config),{mode:0o600});
console.log('Dedicated application PostgreSQL and RustFS started; private configuration written.');
