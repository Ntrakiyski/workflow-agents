import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { Config } from "./config.js";
import { authorize } from "./config.js";
import { ApiError, notFound } from "./errors.js";
import {
  fingerprint,
  canonical,
  validate,
  workloadValidator,
} from "./validation.js";
import type {
  JobRow,
  JobSubmission,
  Principal,
  ScheduleRow,
  ScheduleSubmission,
  Sql,
  Status,
} from "./types.js";
import { TERMINAL } from "./types.js";
import { queue, transaction } from "./db.js";
import { ProviderClient } from "./provider.js";
import { log, type LogSink } from "./log.js";
export const id = (prefix: string) => prefix + "_" + randomUUID();
const time = (x: Date | null) => x?.toISOString() ?? null;
export const jobResponse = (j: JobRow) => ({
  job_id: j.job_id,
  status: j.status,
  client_reference: j.client_reference,
  correlation_id: j.correlation_id,
  sandbox_id: j.sandbox_id,
  run_id: j.run_id,
  attempt_count: j.attempt_count,
  created_at: time(j.created_at),
  updated_at: time(j.updated_at),
  started_at: time(j.started_at),
  finished_at: time(j.finished_at),
  result: j.result,
  error: j.error,
});
export const scheduleResponse = (s: ScheduleRow) => ({
  schedule_id: s.schedule_id,
  status: s.status,
  action: s.action,
  run_at: time(s.run_at),
  created_at: time(s.created_at),
  updated_at: time(s.updated_at),
  job_id: s.job_id,
  sandbox_id: s.sandbox_id,
  correlation_id: s.correlation_id,
  error: s.error,
});
export class Service {
  readonly provider: ProviderClient;
  constructor(
    readonly pool: pg.Pool,
    readonly config: Config,
    readonly sink: LogSink,
  ) {
    this.provider = new ProviderClient(config);
  }
  principal(owner: string, actor: string) {
    return this.config.auth.find(
      (p) => p.owner_id === owner && p.actor_id === actor,
    );
  }
  async job(sql: Sql, owner: string, id: string) {
    const j = (
      await sql.query<JobRow>(
        "SELECT * FROM runner.jobs WHERE job_id=$1 AND owner_id=$2",
        [id, owner],
      )
    ).rows[0];
    if (!j) throw notFound();
    return j;
  }
  async schedule(sql: Sql, owner: string, id: string) {
    const s = (
      await sql.query<ScheduleRow>(
        "SELECT * FROM runner.schedules WHERE schedule_id=$1 AND owner_id=$2",
        [id, owner],
      )
    ).rows[0];
    if (!s) throw notFound();
    return s;
  }
  async audit(
    sql: Sql,
    j: Pick<
      JobRow,
      | "owner_id"
      | "actor_id"
      | "correlation_id"
      | "job_id"
      | "sandbox_id"
      | "run_id"
      | "client_reference"
    >,
    type: string,
    status: string,
    detail: Record<string, unknown> = {},
    targetId = j.job_id,
  ) {
    await sql.query(
      "INSERT INTO runner.audit_events(event_id,owner_id,actor_id,correlation_id,target_id,type,status,job_id,sandbox_id,run_id,client_reference,detail) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
      [
        id("evt"),
        j.owner_id,
        j.actor_id,
        j.correlation_id,
        targetId,
        type,
        status,
        j.job_id,
        j.sandbox_id,
        j.run_id,
        j.client_reference,
        detail,
      ],
    );
    log(this.sink, {
      action: type,
      outcome: status,
      actor_id: j.actor_id,
      owner_id: j.owner_id,
      correlation_id: j.correlation_id,
      job_id: j.job_id,
      sandbox_id: j.sandbox_id,
      run_id: j.run_id,
      ...detail,
    });
  }
  assertPolicy(principal: Principal, body: JobSubmission) {
    authorize(principal, "job:submit");
    const profile = this.config.profiles.workloads[body.workload.profile];
    if (
      !profile ||
      !principal.workload_profiles.includes(body.workload.profile)
    )
      throw new ApiError(403, "forbidden", "Workload profile is not permitted");
    if (Buffer.byteLength(canonical(body.workload.arguments)) > 16384)
      throw new ApiError(
        422,
        "invalid_request",
        "Workload arguments exceed the allowed bound",
      );
    if (!workloadValidator(profile.arguments_schema)(body.workload.arguments))
      throw new ApiError(
        422,
        "invalid_request",
        "Workload arguments do not match the approved profile",
      );
    if (
      body.sandbox.mode === "ensure" &&
      (!body.sandbox.profile ||
        !this.config.profiles.sandboxes[body.sandbox.profile] ||
        !principal.sandbox_profiles.includes(body.sandbox.profile) ||
        !profile.sandbox_profiles.includes(body.sandbox.profile))
    )
      throw new ApiError(403, "forbidden", "Sandbox profile is not permitted");
    if (
      body.limits.max_duration_seconds >
        Math.min(
          this.config.maxDurationSeconds,
          profile.max_duration_seconds,
        ) ||
      body.limits.max_attempts > this.config.maxAttempts
    )
      throw new ApiError(
        422,
        "invalid_request",
        "Execution limits exceed configured policy",
      );
  }
  async assertReuse(
    principal: Principal,
    body: JobSubmission,
    correlation: string,
  ) {
    if (body.sandbox.mode !== "reuse") return;
    const box = await this.provider.sandbox(
      principal.owner_id,
      correlation,
      body.sandbox.sandbox_id!,
    );
    if (
      !principal.sandbox_profiles.includes(box.profile) ||
      !this.config.profiles.workloads[
        body.workload.profile
      ]!.sandbox_profiles.includes(box.profile)
    )
      throw new ApiError(403, "forbidden", "Sandbox profile is not permitted");
    if (box.status === "destroyed" || box.status === "destroying")
      throw new ApiError(409, "invalid_state", "Sandbox is unavailable");
  }
  async replay(
    sql: Sql,
    owner: string,
    operation: string,
    key: string,
    body: unknown,
  ) {
    const row = (
      await sql.query<{ fingerprint: string; resource_id: string }>(
        "SELECT fingerprint,resource_id FROM runner.idempotency WHERE owner_id=$1 AND operation=$2 AND key=$3",
        [owner, operation, key],
      )
    ).rows[0];
    if (row && row.fingerprint !== fingerprint(body))
      throw new ApiError(
        409,
        "idempotency_conflict",
        "Idempotency key was already used with a different payload",
      );
    return row?.resource_id;
  }
  async insertJob(
    sql: Sql,
    p: Principal,
    correlation: string,
    key: string,
    body: JobSubmission,
    operation = "submit",
  ) {
    await sql.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "runner:owner:" + p.owner_id,
    ]);
    const previous = await this.replay(sql, p.owner_id, operation, key, body);
    if (previous) return this.job(sql, p.owner_id, previous);
    const count = Number(
      (
        await sql.query(
          "SELECT count(*) FROM runner.jobs WHERE owner_id=$1 AND status NOT IN ('completed','failed','cancelled','timed_out')",
          [p.owner_id],
        )
      ).rows[0].count,
    );
    if (count >= (p.max_pending_jobs ?? this.config.maxPendingJobs))
      throw new ApiError(
        429,
        "quota_exceeded",
        "Pending job quota exceeded",
        true,
      );
    const jobId = id("job"),
      due = new Date(body.run_at ?? Date.now()),
      status = due.getTime() > Date.now() ? "scheduled" : "queued";
    const dispatchKey =
      body.sandbox.mode === "ensure"
        ? "owner_ref:" + body.sandbox.owner_ref
        : "sandbox:" + body.sandbox.sandbox_id;
    const j = (
      await sql.query<JobRow>(
        "INSERT INTO runner.jobs(job_id,owner_id,actor_id,correlation_id,client_reference,payload,dispatch_key,status,sandbox_id,due_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *",
        [
          jobId,
          p.owner_id,
          p.actor_id,
          correlation,
          body.client_reference ?? null,
          body,
          dispatchKey,
          status,
          body.sandbox.sandbox_id ?? null,
          due,
        ],
      )
    ).rows[0]!;
    await sql.query(
      "INSERT INTO runner.idempotency(owner_id,operation,key,fingerprint,resource_id) VALUES($1,$2,$3,$4,$5)",
      [p.owner_id, operation, key, fingerprint(body), jobId],
    );
    await this.audit(sql, j, "job.submitted", status);
    await queue(sql, "job_tick", jobId, due, body.priority);
    return j;
  }
  async submit(
    p: Principal,
    correlation: string,
    key: string,
    body: JobSubmission,
    operation = "submit",
  ) {
    validate("runner", "JobSubmission", body);
    this.assertPolicy(p, body);
    const existing = await this.replay(
      this.pool,
      p.owner_id,
      operation,
      key,
      body,
    );
    if (existing) return this.job(this.pool, p.owner_id, existing);
    await this.assertReuse(p, body, correlation);
    return transaction(this.pool, (c) =>
      this.insertJob(c, p, correlation, key, body, operation),
    );
  }
  async cancel(p: Principal, correlation: string, jobId: string) {
    authorize(p, "job:cancel");
    return transaction(this.pool, async (c) => {
      const j = await this.job(c, p.owner_id, jobId);
      await c.query(
        "SELECT job_id FROM runner.jobs WHERE job_id=$1 FOR UPDATE",
        [jobId],
      );
      const fresh = await this.job(c, p.owner_id, jobId);
      if (TERMINAL.has(fresh.status)) return fresh;
      if (fresh.status !== "cancelling") {
        const active = ["dispatching", "running"].includes(fresh.status);
        const status = active ? "cancelling" : "cancelled";
        const changed = (
          await c.query<JobRow>(
            "UPDATE runner.jobs SET status=$2,cancellation_target=$3,updated_at=now(),finished_at=CASE WHEN $2='cancelled' THEN now() ELSE NULL END WHERE job_id=$1 RETURNING *",
            [jobId, status, "cancelled"],
          )
        ).rows[0]!;
        await this.audit(
          c,
          { ...changed, actor_id: p.actor_id, correlation_id: correlation },
          "job.cancellation_requested",
          status,
        );
        if (!active) await this.audit(c, changed, "job.cancelled", "cancelled");
      }
      await queue(c, "job_tick", jobId);
      return this.job(c, p.owner_id, jobId);
    });
  }
  async resume(
    p: Principal,
    correlation: string,
    key: string,
    jobId: string,
    body: unknown,
  ) {
    authorize(p, "job:submit");
    if (!p.allow_resume)
      throw new ApiError(403, "forbidden", "Resume is not permitted");
    validate("runner", "ResumeRequest", body);
    const prior = await this.job(this.pool, p.owner_id, jobId);
    if (!TERMINAL.has(prior.status) || !prior.sandbox_id)
      throw new ApiError(
        409,
        "invalid_state",
        "Job has no resumable retained sandbox",
      );
    return this.submit(
      p,
      correlation,
      key,
      {
        ...(body as Omit<JobSubmission, "sandbox">),
        sandbox: { mode: "reuse", sandbox_id: prior.sandbox_id },
      },
      "resume:" + jobId,
    );
  }
  async createSchedule(
    p: Principal,
    correlation: string,
    key: string,
    body: ScheduleSubmission,
  ) {
    authorize(p, "schedule:write");
    validate("runner", "ScheduleSubmission", body);
    if (body.job) {
      this.assertPolicy(p, body.job);
      await this.assertReuse(p, body.job, correlation);
    }
    if (body.job_id) {
      authorize(p, "job:cancel");
      await this.job(this.pool, p.owner_id, body.job_id);
    }
    if (body.sandbox_id)
      await this.provider.sandbox(p.owner_id, correlation, body.sandbox_id);
    return transaction(this.pool, async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "runner:owner:" + p.owner_id,
      ]);
      const previous = await this.replay(c, p.owner_id, "schedule", key, body);
      if (previous) return this.schedule(c, p.owner_id, previous);
      const s = (
        await c.query<ScheduleRow>(
          "INSERT INTO runner.schedules(schedule_id,owner_id,actor_id,correlation_id,action,payload,status,run_at,job_id,sandbox_id) VALUES($1,$2,$3,$4,$5,$6,'pending',$7,$8,$9) RETURNING *",
          [
            id("sch"),
            p.owner_id,
            p.actor_id,
            correlation,
            body.action,
            body,
            body.run_at,
            body.job_id ?? null,
            body.sandbox_id ?? null,
          ],
        )
      ).rows[0]!;
      await c.query(
        "INSERT INTO runner.idempotency(owner_id,operation,key,fingerprint,resource_id) VALUES($1,'schedule',$2,$3,$4)",
        [p.owner_id, key, fingerprint(body), s.schedule_id],
      );
      await this.auditSchedule(c, s, "schedule.created", "pending");
      await queue(c, "schedule_tick", s.schedule_id, s.run_at);
      return s;
    });
  }
  async auditSchedule(
    sql: Sql,
    s: ScheduleRow,
    type: string,
    status: string,
    detail: Record<string, unknown> = {},
  ) {
    await this.audit(
      sql,
      {
        owner_id: s.owner_id,
        actor_id: s.actor_id,
        correlation_id: s.correlation_id,
        job_id: s.job_id ?? s.guard_job_id!,
        sandbox_id: s.sandbox_id,
        run_id: null,
        client_reference: null,
      },
      type,
      status,
      detail,
      s.schedule_id,
    );
  }
  async cancelSchedule(p: Principal, scheduleId: string) {
    authorize(p, "schedule:write");
    return transaction(this.pool, async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "runner:schedule:" + scheduleId,
      ]);
      await c.query(
        "SELECT schedule_id FROM runner.schedules WHERE schedule_id=$1 FOR UPDATE",
        [scheduleId],
      );
      const s = await this.schedule(c, p.owner_id, scheduleId);
      if (s.status === "cancelled") return s;
      if (s.status !== "pending")
        throw new ApiError(
          409,
          "invalid_state",
          "Schedule is already terminal",
        );
      const changed = (
        await c.query<ScheduleRow>(
          "UPDATE runner.schedules SET status='cancelled',updated_at=now() WHERE schedule_id=$1 RETURNING *",
          [scheduleId],
        )
      ).rows[0]!;
      await this.auditSchedule(c, changed, "schedule.cancelled", "cancelled");
      return changed;
    });
  }
  async events(owner: string, jobId: string, cursor: unknown, limit: unknown) {
    await this.job(this.pool, owner, jobId);
    let sequence = "0";
    if (cursor !== undefined) {
      if (
        typeof cursor !== "string" ||
        !/^seq_[0-9]+$/.test(cursor) ||
        cursor.length > 30
      )
        throw new ApiError(400, "invalid_request", "Invalid event cursor");
      sequence = cursor.slice(4);
      if (BigInt(sequence) > 9223372036854775807n)
        throw new ApiError(400, "invalid_request", "Invalid event cursor");
    }
    const size = limit === undefined ? 50 : Number(limit);
    if (!Number.isInteger(size) || size < 1 || size > 100)
      throw new ApiError(400, "invalid_request", "Invalid page limit");
    const rows = (
      await this.pool.query(
        "SELECT * FROM runner.audit_events WHERE owner_id=$1 AND job_id=$2 AND sequence>$3::bigint ORDER BY sequence LIMIT $4",
        [owner, jobId, sequence, size + 1],
      )
    ).rows;
    const page = rows.slice(0, size);
    return {
      events: page.map(({ sequence, ...e }) => ({
        ...e,
        occurred_at: e.occurred_at.toISOString(),
      })),
      next_cursor: rows.length > size ? "seq_" + page.at(-1)!.sequence : null,
    };
  }
}
