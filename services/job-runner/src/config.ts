import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { timingSafeEqual } from "node:crypto";
import type { Principal } from "./types.js";
import { ApiError } from "./errors.js";
export type ProfileConfig = {
  version: 1;
  sandboxes: Record<
    string,
    {
      image: string;
      cpus: number;
      memory_mib: number;
      disk_mib: number;
      network: string;
      max_concurrent_runs?: number;
    }
  >;
  workloads: Record<
    string,
    {
      arguments_schema: Record<string, unknown>;
      sandbox_profiles: string[];
      max_duration_seconds: number;
      [key: string]: unknown;
    }
  >;
};
export type Config = {
  databaseUrl: string;
  databasePoolSize: number;
  databaseQueryTimeoutMs: number;
  providerUrl: string;
  providerToken: string;
  auth: Principal[];
  profiles: ProfileConfig;
  host: string;
  port: number;
  queueConcurrency: number;
  maxGlobalConcurrency: number;
  maxOwnerConcurrency: number;
  maxPendingJobs: number;
  maxPendingSchedules: number;
  maxDurationSeconds: number;
  maxAttempts: number;
  providerTimeoutMs: number;
  pollIntervalMs: number;
  retryBackoffSeconds: number;
  auditRetentionDays: number;
  logLevel: string;
};
function number(
  env: NodeJS.ProcessEnv,
  key: string,
  value: number,
  min = 1,
  max = 86400000,
) {
  const n = Number(env[key] ?? value);
  if (!Number.isInteger(n) || n < min || n > max)
    throw new Error(`Invalid ${key}`);
  return n;
}
function required(env: NodeJS.ProcessEnv, key: string) {
  const s = env[key];
  if (!s) throw new Error(`Missing ${key}`);
  return s;
}
function jsonEnvironment(env: NodeJS.ProcessEnv, key: string): unknown {
  const value = required(env, key);
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`Invalid ${key} JSON`);
  }
}
export function loadConfig(env = process.env): Config {
  const auth = jsonEnvironment(env, "RUNNER_AUTH_JSON") as Principal[];
  if (!Array.isArray(auth) || !auth.length)
    throw new Error("RUNNER_AUTH_JSON must be a nonempty array");
  const ids = new Set<string>(),
    tokens = new Set<string>();
  for (const a of auth) {
    if (
      !a.token ||
      a.token.length < 16 ||
      !validId(a.actor_id) ||
      !validId(a.owner_id) ||
      !Array.isArray(a.permissions) ||
      !Array.isArray(a.workload_profiles) ||
      !Array.isArray(a.sandbox_profiles) ||
      ids.has(a.actor_id) ||
      tokens.has(a.token)
    )
      throw new Error("Invalid Runner authentication configuration");
    for (const limit of [
      a.max_concurrency,
      a.max_pending_jobs,
      a.max_pending_schedules,
    ]) {
      if (
        limit !== undefined &&
        (!Number.isInteger(limit) || limit < 1 || limit > 100000)
      )
        throw new Error("Invalid credential quota");
    }
    if (a.allow_resume !== undefined && typeof a.allow_resume !== "boolean")
      throw new Error("Invalid resume policy");
    ids.add(a.actor_id);
    tokens.add(a.token);
  }
  const profiles = jsonEnvironment(
    env,
    "RUNNER_PROFILES_JSON",
  ) as ProfileConfig;
  const profileSchema = JSON.parse(
    readFileSync(
      new URL("../config/profiles.schema.json", import.meta.url),
      "utf8",
    ),
  );
  if (!new Ajv2020({ strict: false }).compile(profileSchema)(profiles))
    throw new Error("Invalid Runner profiles configuration");
  if (profiles.version !== 1 || !profiles.workloads || !profiles.sandboxes)
    throw new Error("Invalid Runner profiles configuration");
  for (const p of Object.values(profiles.workloads)) {
    if (
      !p.arguments_schema ||
      !p.sandbox_profiles?.length ||
      !Number.isInteger(p.max_duration_seconds) ||
      p.max_duration_seconds < 1
    )
      throw new Error("Invalid workload policy");
  }
  const providerUrl = required(env, "SANDBOX_PROVIDER_URL");
  const u = new URL(providerUrl);
  if (
    !["http:", "https:"].includes(u.protocol) ||
    u.username ||
    u.password ||
    u.search ||
    u.hash
  )
    throw new Error("Invalid Provider URL");
  const queueConcurrency = number(env, "QUEUE_CONCURRENCY", 2, 1, 64),
    databasePoolSize = number(
      env,
      "DB_POOL_SIZE",
      queueConcurrency + 8,
      queueConcurrency + 4,
      200,
    );
  if (
    !["debug", "info", "warn", "error", "silent"].includes(
      env.LOG_LEVEL ?? "info",
    )
  )
    throw new Error("Invalid LOG_LEVEL");
  return {
    databaseUrl: required(env, "DATABASE_URL"),
    databasePoolSize,
    databaseQueryTimeoutMs: number(
      env,
      "DB_QUERY_TIMEOUT_MS",
      5000,
      100,
      300000,
    ),
    providerUrl: providerUrl.replace(/\/$/, ""),
    providerToken: required(env, "SANDBOX_PROVIDER_TOKEN"),
    auth,
    profiles,
    host: env.HOST ?? "0.0.0.0",
    port: number(env, "PORT", 8080, 1, 65535),
    queueConcurrency,
    maxGlobalConcurrency: number(env, "MAX_GLOBAL_CONCURRENCY", 2, 1, 1024),
    maxOwnerConcurrency: number(env, "MAX_OWNER_CONCURRENCY", 1, 1, 1024),
    maxPendingJobs: number(env, "MAX_PENDING_JOBS", 100, 1, 100000),
    maxPendingSchedules: number(env, "MAX_PENDING_SCHEDULES", 100, 1, 100000),
    maxDurationSeconds: number(env, "MAX_DURATION_SECONDS", 3600, 1, 86400),
    maxAttempts: number(env, "MAX_ATTEMPTS", 3, 1, 10),
    providerTimeoutMs: number(env, "PROVIDER_TIMEOUT_MS", 5000, 10, 300000),
    pollIntervalMs: number(env, "POLL_INTERVAL_MS", 250, 10, 60000),
    retryBackoffSeconds: number(env, "RETRY_BACKOFF_SECONDS", 2, 1, 3600),
    auditRetentionDays: number(env, "AUDIT_RETENTION_DAYS", 90, 1, 36500),
    logLevel: env.LOG_LEVEL ?? "info",
  };
}
export function validId(x: unknown): x is string {
  return (
    typeof x === "string" &&
    x.length <= 128 &&
    /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(x)
  );
}
export function authenticate(config: Config, header: unknown): Principal {
  if (typeof header !== "string" || !header.startsWith("Bearer "))
    throw new ApiError(401, "unauthorized", "Valid credentials are required");
  const token = Buffer.from(header.slice(7));
  let match: Principal | undefined;
  for (const a of config.auth) {
    const known = Buffer.from(a.token);
    if (token.length === known.length && timingSafeEqual(token, known))
      match = a;
  }
  if (!match)
    throw new ApiError(401, "unauthorized", "Valid credentials are required");
  return match;
}
export function authorize(principal: Principal, permission: string) {
  if (!principal.permissions.includes(permission))
    throw new ApiError(403, "forbidden", "Operation is not permitted");
}
