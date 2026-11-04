import { z } from "zod";
const user = z
  .object({
    username: z.string().min(1).max(128),
    password_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    owner_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/),
  })
  .strict();
export const configSchema = z.object({
  databaseUrl: z.string().min(1),
  publicOrigin: z.url(),
  port: z.coerce.number().int().min(1).max(65535).default(8082),
  users: z.array(user).min(1),
  s3Endpoint: z.url(),
  s3Region: z.string().default("us-east-1"),
  s3Bucket: z.string().min(1),
  s3AccessKey: z.string().min(1),
  s3SecretKey: z.string().min(1),
  runnerUrl: z.url(),
  runnerToken: z.string().min(1),
  providerUrl: z.url(),
  providerToken: z.string().min(1),
  sandboxProfile: z.string().min(1),
  workloadProfile: z.string().min(1),
  prepareWorkloadProfile: z.string().min(1).default("pi-document-prepare:v3"),
  requestConcurrency: z.coerce.number().int().min(1).max(2).default(2),
  idleStopSeconds: z.coerce.number().int().min(0).max(3600).default(60),
  runtimeBundleKey: z.string().min(1),
  runtimeBundleSha256: z.string().regex(/^[a-f0-9]{64}$/),
  workerIntervalMs: z.coerce.number().int().min(100).default(2000),
  maxDurationSeconds: z.coerce.number().int().min(1).max(3600).default(900),
});
export type Config = z.infer<typeof configSchema>;
export function configuration(env: NodeJS.ProcessEnv = process.env): Config {
  return configSchema.parse({
    databaseUrl: env.DATABASE_URL,
    publicOrigin: env.APPLICATION_ORIGIN,
    port: env.PORT,
    users: JSON.parse(env.APPLICATION_USERS_JSON ?? "null"),
    s3Endpoint: env.S3_ENDPOINT,
    s3Region: env.S3_REGION,
    s3Bucket: env.S3_BUCKET,
    s3AccessKey: env.S3_ACCESS_KEY_ID,
    s3SecretKey: env.S3_SECRET_ACCESS_KEY,
    runnerUrl: env.RUNNER_URL,
    runnerToken: env.RUNNER_TOKEN,
    providerUrl: env.PROVIDER_URL,
    providerToken: env.PROVIDER_TOKEN,
    sandboxProfile: env.SANDBOX_PROFILE,
    workloadProfile: env.WORKLOAD_PROFILE,
    prepareWorkloadProfile: env.PREPARE_WORKLOAD_PROFILE,
    requestConcurrency: env.REQUEST_CONCURRENCY,
    idleStopSeconds: env.IDLE_STOP_SECONDS,
    runtimeBundleKey: env.RUNTIME_BUNDLE_OBJECT_KEY,
    runtimeBundleSha256: env.RUNTIME_BUNDLE_SHA256,
    workerIntervalMs: env.WORKER_INTERVAL_MS,
    maxDurationSeconds: env.MAX_DURATION_SECONDS,
  });
}
