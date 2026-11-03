import Fastify, { type FastifyRequest } from "fastify";
import type { Service } from "./service.js";
import { jobResponse, scheduleResponse, id } from "./service.js";
import { authenticate, authorize, validId } from "./config.js";
import { ApiError } from "./errors.js";
import type { Principal, JobSubmission, ScheduleSubmission } from "./types.js";
import { VERSION } from "./types.js";
import { validate, runnerContract } from "./validation.js";
import { log } from "./log.js";
export function createApi(service: Service, isWorkerReady: () => boolean) {
  const api = Fastify({
    logger: false,
    bodyLimit: 65536,
    genReqId: (req) =>
      validId(req.headers["x-correlation-id"])
        ? req.headers["x-correlation-id"]
        : id("corr"),
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
  });
  const principals = new WeakMap<FastifyRequest, Principal>(),
    started = new WeakMap<FastifyRequest, number>();
  const principal = (r: FastifyRequest) => principals.get(r)!;
  api.addHook("onRequest", async (req, reply) => {
    started.set(req, Date.now());
    reply.header("X-Correlation-ID", req.id);
    if (
      req.headers["x-correlation-id"] !== undefined &&
      !validId(req.headers["x-correlation-id"])
    )
      throw new ApiError(
        400,
        "invalid_request",
        "Invalid correlation identifier",
      );
    if (req.url.startsWith("/v1/") || req.url.startsWith("/metrics")) {
      const p = authenticate(service.config, req.headers.authorization);
      if (req.headers["x-owner-id"] !== undefined)
        throw new ApiError(
          403,
          "forbidden",
          "Caller-selected delegation is not permitted",
        );
      principals.set(req, p);
    }
  });
  api.addHook("onResponse", async (req, reply) => {
    const p = principals.get(req);
    log(service.sink, {
      action: "http.request",
      correlation_id: req.id,
      actor_id: p?.actor_id ?? null,
      owner_id: p?.owner_id ?? null,
      duration_ms: Date.now() - (started.get(req) ?? Date.now()),
      outcome: reply.statusCode < 400 ? "ok" : "failed",
      status_code: reply.statusCode,
      method: req.method,
      route: req.routeOptions.url ?? "unknown",
    });
  });
  api.setErrorHandler((err, req, reply) => {
    let error =
      err instanceof ApiError
        ? err
        : new ApiError(
            503,
            "dependency_unavailable",
            "A required dependency is unavailable",
            true,
          );
    if (
      !(err instanceof ApiError) &&
      typeof err === "object" &&
      err !== null &&
      "statusCode" in err &&
      Number(err.statusCode) >= 400 &&
      Number(err.statusCode) < 500
    )
      error = new ApiError(
        Number(err.statusCode),
        "invalid_request",
        "Request could not be parsed",
      );
    return reply.code(error.status).send(error.safe(req.id));
  });
  api.setNotFoundHandler((req, reply) =>
    reply
      .code(404)
      .send(new ApiError(404, "not_found", "Resource not found").safe(req.id)),
  );
  function key(req: FastifyRequest) {
    const k = req.headers["idempotency-key"];
    if (!validId(k))
      throw new ApiError(
        400,
        "invalid_request",
        "A valid Idempotency-Key is required",
      );
    return k;
  }
  function parameter(req: FastifyRequest, name: string) {
    const value = (req.params as Record<string, unknown>)[name];
    if (!validId(value))
      throw new ApiError(400, "invalid_request", "Invalid resource identifier");
    return value;
  }
  api.get("/health/live", async () => ({
    status: "ok",
    service: "job-runner",
    version: VERSION,
    checks: { process: "ok" },
  }));
  api.get("/health/ready", async (_, reply) => {
    let database = "ok";
    try {
      await service.pool.query(
        "SELECT 1 FROM runner.schema_migrations LIMIT 1",
      );
    } catch {
      database = "failed";
    }
    const worker = isWorkerReady();
    const ready = database === "ok" && worker;
    return reply.code(ready ? 200 : 503).send({
      status: ready ? "ok" : "unavailable",
      service: "job-runner",
      version: VERSION,
      checks: { database, queue: worker ? "ok" : "failed" },
    });
  });
  api.get("/openapi.json", async () => runnerContract);
  api.get("/metrics", async (req, reply) => {
    authorize(principal(req), "job:read");
    const rows = (
      await service.pool.query(
        "SELECT status,count(*)::int AS count FROM runner.jobs WHERE owner_id=$1 GROUP BY status",
        [principal(req).owner_id],
      )
    ).rows;
    reply.type("text/plain; version=0.0.4");
    return (
      rows
        .map((r) => `workflow_runner_jobs{status="${r.status}"} ${r.count}`)
        .join("\n") + "\n"
    );
  });
  api.post("/v1/jobs", async (req, reply) => {
    const j = await service.submit(
      principal(req),
      req.id,
      key(req),
      req.body as JobSubmission,
    );
    return reply.code(202).send(jobResponse(j));
  });
  api.get("/v1/jobs/:job_id", async (req) => {
    const p = principal(req);
    authorize(p, "job:read");
    return jobResponse(
      await service.job(service.pool, p.owner_id, parameter(req, "job_id")),
    );
  });
  api.get("/v1/jobs/:job_id/events", async (req) => {
    const p = principal(req);
    authorize(p, "job:read");
    const query = req.query as Record<string, unknown>;
    if (Object.keys(query).some((k) => !["cursor", "limit"].includes(k)))
      throw new ApiError(400, "invalid_request", "Unknown query parameter");
    return service.events(
      p.owner_id,
      parameter(req, "job_id"),
      query.cursor,
      query.limit,
    );
  });
  api.post("/v1/jobs/:job_id/cancel", async (req, reply) => {
    validate("runner", "CancelRequest", req.body);
    return reply
      .code(202)
      .send(
        jobResponse(
          await service.cancel(
            principal(req),
            req.id,
            parameter(req, "job_id"),
          ),
        ),
      );
  });
  api.post("/v1/jobs/:job_id/resume", async (req, reply) =>
    reply
      .code(202)
      .send(
        jobResponse(
          await service.resume(
            principal(req),
            req.id,
            key(req),
            parameter(req, "job_id"),
            req.body,
          ),
        ),
      ),
  );
  api.post("/v1/schedules", async (req, reply) =>
    reply
      .code(201)
      .send(
        scheduleResponse(
          await service.createSchedule(
            principal(req),
            req.id,
            key(req),
            req.body as ScheduleSubmission,
          ),
        ),
      ),
  );
  api.get("/v1/schedules/:schedule_id", async (req) => {
    const p = principal(req);
    authorize(p, "job:read");
    return scheduleResponse(
      await service.schedule(
        service.pool,
        p.owner_id,
        parameter(req, "schedule_id"),
      ),
    );
  });
  api.delete("/v1/schedules/:schedule_id", async (req) =>
    scheduleResponse(
      await service.cancelSchedule(
        principal(req),
        parameter(req, "schedule_id"),
        req.id,
      ),
    ),
  );
  return api;
}
