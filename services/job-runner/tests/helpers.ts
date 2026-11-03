import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Config } from "../src/config.js";
import { validate } from "../src/validation.js";
const token = "fixture-client-token-0123456789",
  other = "fixture-other-token-0123456789";
export const headers = {
  authorization: "Bearer " + token,
  "idempotency-key": "fixture-default-key",
  "x-correlation-id": "corr_fixture",
};
export const otherHeaders = { ...headers, authorization: "Bearer " + other };
export function config(
  databaseUrl: string,
  providerUrl = "http://127.0.0.1:1",
): Config {
  const profiles = JSON.parse(
    readFileSync(
      new URL("../config/profiles.template.json", import.meta.url),
      "utf8",
    ),
  );
  profiles.sandboxes["minimal-linux:v1"].image =
    "registry.invalid/fixture@sha256:" + "1".repeat(64);
  return {
    databaseUrl,
    databasePoolSize: 12,
    databaseQueryTimeoutMs: 5000,
    providerUrl,
    providerToken: "fixture-provider-token-0123456789",
    auth: [
      {
        token,
        actor_id: "fixture-client",
        owner_id: "fixture-owner",
        permissions: ["job:submit", "job:read", "job:cancel", "schedule:write"],
        workload_profiles: Object.keys(profiles.workloads),
        sandbox_profiles: ["minimal-linux:v1"],
        allow_resume: true,
      },
      {
        token: other,
        actor_id: "other-client",
        owner_id: "other-owner",
        permissions: ["job:submit", "job:read", "job:cancel", "schedule:write"],
        workload_profiles: Object.keys(profiles.workloads),
        sandbox_profiles: ["minimal-linux:v1"],
        allow_resume: true,
      },
    ],
    profiles,
    host: "127.0.0.1",
    port: 0,
    queueConcurrency: 3,
    maxGlobalConcurrency: 3,
    maxOwnerConcurrency: 2,
    maxPendingJobs: 100,
    maxDurationSeconds: 120,
    maxAttempts: 3,
    providerTimeoutMs: 120,
    pollIntervalMs: 30,
    retryBackoffSeconds: 1,
    auditRetentionDays: 90,
    logLevel: "info",
  };
}
export function submission(text = "hello") {
  return {
    workload: {
      profile: "fixture-write-file:v1",
      arguments: { file: "hello-world.txt", text },
    },
    sandbox: {
      mode: "ensure",
      owner_ref: "workspace_" + randomUUID(),
      profile: "minimal-linux:v1",
      persistent: true,
    },
    limits: { max_duration_seconds: 20, max_attempts: 2 },
  };
}
export const wait = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));
export async function until<T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeout = 8000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  let v: T;
  do {
    v = await fn();
    if (predicate(v)) return v;
    await wait(25);
  } while (Date.now() < deadline);
  throw new Error(
    "Timed out waiting for expected state: " + JSON.stringify(v!),
  );
}
export async function mockProvider() {
  const api = Fastify({ logger: false }),
    sandboxes = new Map<string, any>(),
    refs = new Map<string, string>(),
    runs = new Map<string, any>(),
    keys = new Map<string, string>(),
    requests: any[] = [],
    fences = new Set<string>();
  const stats = {
    creates: 0,
    executions: 0,
    active: 0,
    maxActive: 0,
    ambiguousCreate: false,
    ambiguousExecute: false,
    transientRuns: 0,
    delayMs: 100,
    holdRuns: false,
    rejectExecuteBefore: false,
    executeRequests: 0,
    stopDelayMs: 0,
    stopStarted: false,
  };
  const timers = new Set<NodeJS.Timeout>();
  api.addHook("onRequest", async (req, reply) => {
    if (
      req.headers.authorization !==
        "Bearer fixture-provider-token-0123456789" ||
      !req.headers["x-owner-id"]
    )
      return reply.code(401).send({
        code: "unauthorized",
        message: "invalid",
        retryable: false,
        correlation_id: "corr_mock",
      });
    requests.push({ path: req.url, headers: req.headers });
  });
  const box = (req: any) => {
    const s = sandboxes.get(req.params.sandbox_id);
    return s && s.owner === req.headers["x-owner-id"] ? s : null;
  };
  const wire = (s: any) => {
    const { owner, files, ...rest } = s;
    return rest;
  };
  const error = (reply: any, code: string, status = 409) =>
    reply.code(status).send({
      code,
      message: "Fixture operation rejected",
      retryable: status >= 500,
      correlation_id: "corr_mock",
    });
  api.post("/v1/sandboxes", async (req, reply) => {
    validate("provider", "CreateSandbox", req.body);
    const body = req.body as any;
    const ref = req.headers["x-owner-id"] + ":" + body.owner_ref;
    let sid = refs.get(ref);
    if (!sid) {
      sid = "sbx_" + randomUUID();
      const now = new Date().toISOString();
      sandboxes.set(sid, {
        sandbox_id: sid,
        owner: req.headers["x-owner-id"],
        owner_ref: body.owner_ref,
        profile: body.profile,
        persistent: true,
        status: "running",
        created_at: now,
        updated_at: now,
        active_run_id: null,
        resources: {
          cpus: 1,
          memory_mib: 256,
          disk_mib: 1024,
          network: "denied",
        },
        error: null,
        files: {},
      });
      refs.set(ref, sid);
      stats.creates++;
    }
    if (stats.ambiguousCreate) {
      stats.ambiguousCreate = false;
      await wait(220);
    }
    return reply.code(201).send(wire(sandboxes.get(sid)));
  });
  api.get("/v1/sandboxes/:sandbox_id", async (req, reply) => {
    const s = box(req);
    return s ? wire(s) : error(reply, "not_found", 404);
  });
  api.post("/v1/sandboxes/:sandbox_id/start", async (req, reply) => {
    validate("provider", "Empty", req.body);
    const s = box(req);
    if (!s) return error(reply, "not_found", 404);
    s.status = "running";
    return wire(s);
  });
  api.post("/v1/sandboxes/:sandbox_id/stop", async (req, reply) => {
    const s = box(req);
    if (!s) return error(reply, "not_found", 404);
    stats.stopStarted = true;
    if (stats.stopDelayMs) await wait(stats.stopDelayMs);
    if (s.active_run_id) return error(reply, "sandbox_busy");
    s.status = "stopped";
    return wire(s);
  });
  api.post("/v1/sandboxes/:sandbox_id/execute", async (req, reply) => {
    validate("provider", "ExecuteRequest", req.body);
    const s = box(req);
    if (!s) return error(reply, "not_found", 404);
    const body = req.body as any;
    stats.executeRequests++;
    if (stats.rejectExecuteBefore)
      return error(reply, "runtime_unavailable", 503);
    if (fences.has(s.sandbox_id + ":" + body.execution_ref))
      return error(reply, "execution_cancelled");
    const key =
      req.headers["x-owner-id"] + ":" + req.headers["idempotency-key"];
    const existing = keys.get(key);
    if (existing) {
      const r = runs.get(existing);
      if (JSON.stringify(r.payload) !== JSON.stringify(body))
        return error(reply, "idempotency_conflict");
      const { payload, ...rest } = r;
      return reply.code(202).send(rest);
    }
    if (s.active_run_id) return error(reply, "sandbox_busy");
    const now = new Date().toISOString(),
      rid = "run_" + randomUUID();
    const r = {
      run_id: rid,
      sandbox_id: s.sandbox_id,
      execution_ref: body.execution_ref,
      profile: body.profile,
      status: "running",
      created_at: now,
      updated_at: now,
      started_at: now,
      finished_at: null,
      result: null,
      error: null,
      payload: body,
    };
    keys.set(key, rid);
    runs.set(rid, r);
    s.active_run_id = rid;
    stats.executions++;
    stats.active++;
    stats.maxActive = Math.max(stats.maxActive, stats.active);
    if (!stats.holdRuns) {
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (r.status !== "running") return;
        stats.active--;
        s.active_run_id = null;
        r.finished_at = new Date().toISOString();
        r.updated_at = r.finished_at;
        if (stats.transientRuns > 0) {
          stats.transientRuns--;
          r.status = "failed";
          r.error = {
            code: "runtime_temporarily_unavailable",
            message: "transient",
            retryable: true,
            correlation_id: "corr_mock",
          };
          return;
        }
        r.status = "completed";
        if (body.profile === "fixture-write-file:v1")
          s.files[body.arguments.file] = body.arguments.text;
        r.result = {
          exit_code: 0,
          stdout:
            body.profile === "fixture-read-file:v1"
              ? (s.files[body.arguments.file] ?? "")
              : "written",
          stderr: "",
          output_truncated: false,
          artifacts: [],
        };
      }, stats.delayMs);
      timers.add(timer);
    }
    if (stats.ambiguousExecute) {
      stats.ambiguousExecute = false;
      await wait(220);
    }
    const { payload, ...rest } = r;
    return reply.code(202).send(rest);
  });
  api.post(
    "/v1/sandboxes/:sandbox_id/runs/cancel-by-reference",
    async (req: any, reply) => {
      validate("provider", "CancelByReferenceRequest", req.body);
      const s = box(req);
      if (!s) return error(reply, "not_found", 404);
      const execution_ref = req.body.execution_ref;
      fences.add(s.sandbox_id + ":" + execution_ref);
      const r = [...runs.values()].find(
        (r) =>
          r.sandbox_id === s.sandbox_id && r.execution_ref === execution_ref,
      );
      if (!r)
        return reply
          .code(202)
          .send({ execution_ref, run_id: null, status: "fenced" });
      if (r.status === "running") {
        r.status = "cancelled";
        r.updated_at = new Date().toISOString();
        r.finished_at = r.updated_at;
        s.active_run_id = null;
        stats.active--;
      }
      return reply
        .code(202)
        .send({ execution_ref, run_id: r.run_id, status: r.status });
    },
  );
  api.get("/v1/sandboxes/:sandbox_id/runs/:run_id", async (req: any, reply) => {
    const s = box(req),
      r = runs.get(req.params.run_id);
    if (!s || !r || r.sandbox_id !== s.sandbox_id)
      return error(reply, "not_found", 404);
    const { payload, ...rest } = r;
    return rest;
  });
  api.post(
    "/v1/sandboxes/:sandbox_id/runs/:run_id/cancel",
    async (req: any, reply) => {
      const s = box(req),
        r = runs.get(req.params.run_id);
      if (!s || !r || r.sandbox_id !== s.sandbox_id)
        return error(reply, "not_found", 404);
      if (r.status === "running") {
        r.status = "cancelled";
        r.updated_at = new Date().toISOString();
        r.finished_at = r.updated_at;
        s.active_run_id = null;
        stats.active--;
      }
      const { payload, ...rest } = r;
      return reply.code(202).send(rest);
    },
  );
  await api.listen({ host: "127.0.0.1", port: 0 });
  const address = api.server.address() as { port: number };
  return {
    url: "http://127.0.0.1:" + address.port,
    api,
    stats,
    sandboxes,
    runs,
    requests,
    close: async () => {
      for (const t of timers) clearTimeout(t);
      await api.close();
    },
  };
}
