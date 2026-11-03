import type pg from "pg";
import { run, type Runner } from "graphile-worker";
import type { Service } from "./service.js";
import { id } from "./service.js";
import type { JobRow, ScheduleRow, Status, Result, Run } from "./types.js";
import { TERMINAL } from "./types.js";
import { queue } from "./db.js";
import { ApiError } from "./errors.js";
import { fingerprint } from "./validation.js";
import { graphileLogger, log } from "./log.js";
type Attempt = {
  attempt_id: string;
  number: number;
  execution_ref: string;
  provider_key: string;
  run_id: string | null;
  timeout_seconds: number;
  status: string;
};
async function tx<T>(c: pg.PoolClient, fn: () => Promise<T>) {
  await c.query("BEGIN");
  try {
    const result = await fn();
    await c.query("COMMIT");
    return result;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  }
}
export class Worker {
  runner: Runner | null = null;
  active = false;
  constructor(readonly service: Service) {}
  get pool() {
    return this.service.pool;
  }
  get config() {
    return this.service.config;
  }
  async start() {
    await this.recover();
    this.runner = await run({
      pgPool: this.pool,
      concurrency: this.config.queueConcurrency,
      pollInterval: this.config.pollIntervalMs,
      noHandleSignals: true,
      logger: graphileLogger(this.service.sink),
      taskList: {
        job_tick: async (payload) => this.tick((payload as { id: string }).id),
        schedule_tick: async (payload) =>
          this.scheduleTick((payload as { id: string }).id),
      },
    });
    this.active = true;
    void this.runner.promise.catch(() => {
      this.active = false;
      log(this.service.sink, {
        action: "queue.failed",
        outcome: "failed",
        error_classification: "queue_unavailable",
      });
    });
  }
  async stop() {
    this.active = false;
    if (this.runner) await this.runner.stop();
    this.runner = null;
  }
  async recover() {
    const c = await this.pool.connect();
    try {
      await tx(c, async () => {
        const jobs = (
          await c.query<JobRow>(
            "SELECT * FROM runner.jobs WHERE status NOT IN ('completed','failed','cancelled','timed_out')",
          )
        ).rows;
        for (const j of jobs) {
          await queue(c, "job_tick", j.job_id, j.due_at, j.payload.priority);
          await this.service.audit(c, j, "job.recovered", j.status, {
            attempt: j.attempt_count,
          });
        }
        for (const s of (
          await c.query<ScheduleRow>(
            "SELECT * FROM runner.schedules WHERE status='pending'",
          )
        ).rows) {
          await queue(c, "schedule_tick", s.schedule_id, s.run_at);
          await this.service.auditSchedule(
            c,
            s,
            "schedule.recovered",
            s.status,
          );
        }
      });
    } finally {
      c.release();
    }
  }
  async locked(target: string, fn: (c: pg.PoolClient) => Promise<void>) {
    const c = await this.pool.connect();
    let locked = false;
    try {
      locked = (
        await c.query(
          "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked",
          ["runner:" + target],
        )
      ).rows[0].locked;
      if (locked) await fn(c);
    } finally {
      if (locked)
        await c.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
          "runner:" + target,
        ]);
      c.release();
    }
  }
  async read(c: pg.PoolClient, id: string) {
    return (
      await c.query<JobRow>("SELECT * FROM runner.jobs WHERE job_id=$1", [id])
    ).rows[0];
  }
  async enqueue(
    c: pg.PoolClient,
    j: JobRow,
    delay = this.config.pollIntervalMs,
  ) {
    await queue(
      c,
      "job_tick",
      j.job_id,
      new Date(Date.now() + delay),
      j.payload.priority,
    );
  }
  async finish(
    c: pg.PoolClient,
    j: JobRow,
    status: Status,
    result: Result | null = null,
    error: JobRow["error"] = null,
  ) {
    await tx(c, async () => {
      const current = await this.read(c, j.job_id);
      if (!current || TERMINAL.has(current.status)) return;
      const updated = (
        await c.query<JobRow>(
          "UPDATE runner.jobs SET status=$2,result=$3,error=$4,finished_at=now(),updated_at=now() WHERE job_id=$1 RETURNING *",
          [j.job_id, status, result, error],
        )
      ).rows[0]!;
      await c.query(
        "UPDATE runner.attempts SET status=$2,finished_at=now() WHERE job_id=$1 AND number=$3",
        [j.job_id, status, j.attempt_count],
      );
      await this.service.audit(c, updated, "job." + status, status, {
        attempt: j.attempt_count,
        ...(error ? { error_classification: error.code } : {}),
      });
      if (
        status === "completed" &&
        j.payload.idle_stop_after_seconds &&
        j.sandbox_id
      ) {
        const at = new Date(
            Date.now() + j.payload.idle_stop_after_seconds * 1000,
          ),
          scheduleId = id("sch");
        const s = (
          await c.query<ScheduleRow>(
            "INSERT INTO runner.schedules(schedule_id,owner_id,actor_id,correlation_id,action,payload,status,run_at,sandbox_id,guard_job_id) VALUES($1,$2,$3,$4,'stop_sandbox',$5,'pending',$6,$7,$8) RETURNING *",
            [
              scheduleId,
              j.owner_id,
              j.actor_id,
              j.correlation_id,
              {
                run_at: at.toISOString(),
                action: "stop_sandbox",
                sandbox_id: j.sandbox_id,
              },
              at,
              j.sandbox_id,
              j.job_id,
            ],
          )
        ).rows[0]!;
        await this.service.auditSchedule(c, s, "schedule.created", "pending");
        await queue(c, "schedule_tick", scheduleId, at);
      }
    });
  }
  async attempt(c: pg.PoolClient, j: JobRow) {
    return (
      await c.query<Attempt>(
        "SELECT * FROM runner.attempts WHERE job_id=$1 AND number=$2",
        [j.job_id, j.attempt_count],
      )
    ).rows[0];
  }
  duration(j: JobRow) {
    const deadline = j.payload.limits.deadline_at
      ? new Date(j.payload.limits.deadline_at).getTime()
      : Infinity;
    const attempt = j.attempt_started_at
      ? j.attempt_started_at.getTime() +
        j.payload.limits.max_duration_seconds * 1000
      : Infinity;
    return Math.ceil((Math.min(deadline, attempt) - Date.now()) / 1000);
  }
  async timeoutIntent(c: pg.PoolClient, j: JobRow) {
    if (j.status === "cancelling") return j;
    if (["dispatching", "running"].includes(j.status)) {
      const fresh = (
        await c.query<JobRow>(
          "UPDATE runner.jobs SET status='cancelling',cancellation_target='timed_out',updated_at=now() WHERE job_id=$1 AND status NOT IN ('completed','failed','cancelled','timed_out') RETURNING *",
          [j.job_id],
        )
      ).rows[0];
      if (fresh)
        await this.service.audit(
          c,
          fresh,
          "job.cancellation_requested",
          "cancelling",
          { error_classification: "deadline_exceeded" },
        );
      return fresh ?? j;
    }
    await this.finish(c, j, "timed_out", null, {
      code: "deadline_exceeded",
      message: "Execution deadline exceeded",
      retryable: false,
      correlation_id: j.correlation_id,
    });
    return (await this.read(c, j.job_id))!;
  }
  async claim(c: pg.PoolClient, j: JobRow) {
    return tx(c, async () => {
      await c.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('runner:capacity',0))",
      );
      const current = (
        await c.query<JobRow>(
          "SELECT * FROM runner.jobs WHERE job_id=$1 FOR UPDATE",
          [j.job_id],
        )
      ).rows[0]!;
      if (!["queued", "scheduled", "retry_wait"].includes(current.status))
        return current;
      const principal = this.service.principal(j.owner_id, j.actor_id);
      const counts = (
        await c.query(
          "SELECT count(*)::int AS global,count(*) FILTER(WHERE owner_id=$1)::int AS owner,count(*) FILTER(WHERE owner_id=$1 AND dispatch_key=$2)::int AS dispatch,count(*) FILTER(WHERE sandbox_id=$3 AND $3 IS NOT NULL)::int AS sandbox FROM runner.jobs WHERE status IN ('dispatching','running','cancelling')",
          [j.owner_id, j.dispatch_key, j.sandbox_id],
        )
      ).rows[0];
      if (
        counts.global >= this.config.maxGlobalConcurrency ||
        counts.owner >=
          (principal?.max_concurrency ?? this.config.maxOwnerConcurrency) ||
        counts.dispatch > 0 ||
        counts.sandbox > 0
      ) {
        await this.enqueue(c, j);
        return null;
      }
      const claimed = (
        await c.query<JobRow>(
          "UPDATE runner.jobs SET status='dispatching',started_at=coalesce(started_at,now()),updated_at=now() WHERE job_id=$1 RETURNING *",
          [j.job_id],
        )
      ).rows[0]!;
      await this.service.audit(c, claimed, "job.dispatched", "dispatching", {
        attempt: claimed.attempt_count + 1,
      });
      return claimed;
    });
  }
  async ensureAttempt(c: pg.PoolClient, j: JobRow) {
    let attempt = await this.attempt(c, j);
    if (attempt && !TERMINAL.has(attempt.status)) return { job: j, attempt };
    return tx(c, async () => {
      const fresh = (
        await c.query<JobRow>(
          "UPDATE runner.jobs SET attempt_count=attempt_count+1,attempt_started_at=now(),updated_at=now() WHERE job_id=$1 RETURNING *",
          [j.job_id],
        )
      ).rows[0]!;
      const attemptId = id("att");
      attempt = (
        await c.query<Attempt>(
          "INSERT INTO runner.attempts(attempt_id,job_id,number,execution_ref,provider_key,timeout_seconds,status) VALUES($1,$2,$3,$4,$5,$6,'prepared') RETURNING *",
          [
            attemptId,
            j.job_id,
            fresh.attempt_count,
            attemptId,
            attemptId,
            Math.max(
              1,
              Math.min(
                j.payload.limits.max_duration_seconds,
                this.duration(fresh),
              ),
            ),
          ],
        )
      ).rows[0]!;
      return { job: fresh, attempt };
    });
  }
  async dispatch(c: pg.PoolClient, j: JobRow) {
    if (!j.sandbox_id) {
      const box = await this.service.provider.create(
        j,
        "sbx_" +
          fingerprint({
            owner: j.owner_id,
            owner_ref: j.payload.sandbox.owner_ref,
          }),
      );
      if (box.status !== "running" && box.status !== "stopped")
        throw new ApiError(
          503,
          "runtime_unavailable",
          "Sandbox is not ready",
          true,
        );
      try {
        await c.query(
          "UPDATE runner.jobs SET sandbox_id=$2,updated_at=now() WHERE job_id=$1",
          [j.job_id, box.sandbox_id],
        );
      } catch (e) {
        if ((e as { code?: string }).code === "23505") {
          await c.query(
            "UPDATE runner.jobs SET status='queued',updated_at=now() WHERE job_id=$1 AND status='dispatching'",
            [j.job_id],
          );
          await this.enqueue(c, j);
          return;
        }
        throw e;
      }
      j = (await this.read(c, j.job_id))!;
    }
    if (j.status === "cancelling") {
      await this.cancelActive(c, j);
      return;
    }
    const principal = this.service.principal(j.owner_id, j.actor_id);
    if (!principal)
      throw new ApiError(
        403,
        "forbidden",
        "Submitting principal is no longer authorized",
      );
    await this.service.assertReuse(
      principal,
      { ...j.payload, sandbox: { mode: "reuse", sandbox_id: j.sandbox_id! } },
      j.correlation_id,
    );
    await this.service.provider.start(j);
    j = (await this.read(c, j.job_id))!;
    if (j.status === "cancelling") {
      await this.cancelActive(c, j);
      return;
    }
    const ensured = await this.ensureAttempt(c, j);
    j = ensured.job;
    const attempt = ensured.attempt;
    if (attempt.run_id) {
      await c.query(
        "UPDATE runner.jobs SET run_id=$2,status=CASE WHEN status='cancelling' THEN status ELSE 'running' END,updated_at=now() WHERE job_id=$1",
        [j.job_id, attempt.run_id],
      );
      await this.enqueue(c, j);
      return;
    }
    await c.query(
      "UPDATE runner.attempts SET status='dispatching' WHERE attempt_id=$1",
      [attempt.attempt_id],
    );
    const remaining = this.duration(j);
    if (remaining <= 0) {
      await this.timeoutIntent(c, j);
      await this.enqueue(c, j);
      return;
    }
    const r = await this.service.provider.execute(
      j,
      attempt.execution_ref,
      attempt.provider_key,
      attempt.timeout_seconds,
    );
    await tx(c, async () => {
      await c.query(
        "UPDATE runner.attempts SET run_id=$2,status='running' WHERE attempt_id=$1",
        [attempt.attempt_id, r.run_id],
      );
      await c.query(
        "UPDATE runner.jobs SET run_id=$2,status=CASE WHEN status='cancelling' THEN status ELSE 'running' END,updated_at=now() WHERE job_id=$1",
        [j.job_id, r.run_id],
      );
    });
    await this.enqueue(c, j);
  }
  async retryOrFinish(c: pg.PoolClient, j: JobRow, r: Run) {
    if (r.status === "completed" && r.result?.exit_code === 0) {
      await this.finish(c, j, "completed", r.result);
      return;
    }
    if (r.status === "cancelled") {
      await this.finish(c, j, j.cancellation_target ?? "cancelled", r.result);
      return;
    }
    if (r.status === "timed_out") {
      await this.finish(c, j, "timed_out", r.result, {
        code: "deadline_exceeded",
        message: "Execution timed out",
        retryable: false,
        correlation_id: j.correlation_id,
      });
      return;
    }
    const error = r.error
      ? {
          ...r.error,
          message: "Workload execution failed",
          correlation_id: j.correlation_id,
        }
      : {
          code: "execution_failed",
          message: "Workload execution failed",
          retryable: false,
          correlation_id: j.correlation_id,
        };
    if (
      error.retryable &&
      j.attempt_count < j.payload.limits.max_attempts &&
      j.status !== "cancelling" &&
      this.duration(j) > 0
    ) {
      const backoff = Math.min(
        3600,
        (j.payload.limits.retry_backoff_seconds ??
          this.config.retryBackoffSeconds) *
          2 ** (j.attempt_count - 1),
      );
      await tx(c, async () => {
        await c.query(
          "UPDATE runner.attempts SET status='failed',finished_at=now() WHERE job_id=$1 AND number=$2",
          [j.job_id, j.attempt_count],
        );
        const changed = (
          await c.query<JobRow>(
            "UPDATE runner.jobs SET status='retry_wait',run_id=NULL,error=$2,due_at=$3,attempt_started_at=NULL,updated_at=now() WHERE job_id=$1 RETURNING *",
            [j.job_id, error, new Date(Date.now() + backoff * 1000)],
          )
        ).rows[0]!;
        await this.service.audit(c, changed, "job.retry", "retry_wait", {
          attempt: j.attempt_count,
          error_classification: error.code,
        });
        await queue(
          c,
          "job_tick",
          j.job_id,
          changed.due_at,
          j.payload.priority,
        );
      });
    } else
      await this.finish(
        c,
        j,
        j.cancellation_target ?? "failed",
        r.result,
        error,
      );
  }
  async cancelActive(c: pg.PoolClient, j: JobRow) {
    if (!j.run_id) {
      const attempt = await this.attempt(c, j);
      if (attempt) {
        const r = await this.service.provider.fence(j, attempt.execution_ref);
        if (r.status === "fenced" && !r.run_id) {
          await this.finish(c, j, j.cancellation_target ?? "cancelled");
          return;
        }
        if (!r.run_id)
          throw new ApiError(
            503,
            "dependency_unavailable",
            "Cancellation is pending reconciliation",
            true,
          );
        await tx(c, async () => {
          await c.query("UPDATE runner.jobs SET run_id=$2 WHERE job_id=$1", [
            j.job_id,
            r.run_id,
          ]);
          await c.query(
            "UPDATE runner.attempts SET run_id=$2 WHERE attempt_id=$1",
            [attempt.attempt_id, r.run_id],
          );
        });
        j = (await this.read(c, j.job_id))!;
      } else {
        await this.finish(c, j, j.cancellation_target ?? "cancelled");
        return;
      }
    }
    const current = await this.service.provider.run(j);
    if (TERMINAL.has(current.status)) {
      await this.retryOrFinish(c, j, current);
      return;
    }
    const cancelled = await this.service.provider.cancel(j);
    if (TERMINAL.has(cancelled.status))
      await this.retryOrFinish(c, j, cancelled);
    else await this.enqueue(c, j);
  }
  async tick(jobId: string) {
    await this.locked("job:" + jobId, async (c) => {
      let j = await this.read(c, jobId);
      if (!j || TERMINAL.has(j.status)) return;
      try {
        const deadline = j.payload.limits.deadline_at
          ? new Date(j.payload.limits.deadline_at).getTime()
          : Infinity;
        const setupExpired =
          j.attempt_count === 0 &&
          j.started_at &&
          j.started_at.getTime() +
            j.payload.limits.max_duration_seconds * 1000 <=
            Date.now();
        if (deadline <= Date.now() || this.duration(j) <= 0 || setupExpired)
          j = await this.timeoutIntent(c, j);
        if (TERMINAL.has(j.status)) return;
        if (j.status === "cancelling") {
          await this.cancelActive(c, j);
          return;
        }
        if (j.due_at.getTime() > Date.now()) {
          await queue(c, "job_tick", j.job_id, j.due_at, j.payload.priority);
          return;
        }
        const p = this.service.principal(j.owner_id, j.actor_id);
        if (!p)
          throw new ApiError(
            403,
            "forbidden",
            "Submitting principal is no longer authorized",
          );
        this.service.assertPolicy(p, j.payload);
        if (["queued", "scheduled", "retry_wait"].includes(j.status)) {
          const claimed = await this.claim(c, j);
          if (!claimed) return;
          j = claimed;
        }
        if (j.status === "dispatching") {
          await this.dispatch(c, j);
          return;
        }
        if (j.status === "running") {
          const r = await this.service.provider.run(j);
          if (TERMINAL.has(r.status)) await this.retryOrFinish(c, j, r);
          else await this.enqueue(c, j);
        }
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        j = (await this.read(c, jobId))!;
        if (e.retryable || e.code === "sandbox_busy") {
          await c.query(
            "UPDATE runner.jobs SET error=$2,updated_at=now() WHERE job_id=$1",
            [jobId, e.safe(j.correlation_id)],
          );
          log(this.service.sink, {
            action: "job.reconcile",
            outcome: "retry",
            job_id: jobId,
            correlation_id: j.correlation_id,
            actor_id: j.actor_id,
            owner_id: j.owner_id,
            error_classification: e.code,
          });
          await this.enqueue(
            c,
            j,
            Math.min(5000, this.config.pollIntervalMs * 4),
          );
        } else if (j.run_id || j.attempt_count > 0) {
          await c.query(
            "UPDATE runner.jobs SET status='cancelling',cancellation_target='failed',error=$2 WHERE job_id=$1",
            [jobId, e.safe(j.correlation_id)],
          );
          await this.enqueue(c, j);
        } else
          await this.finish(c, j, "failed", null, e.safe(j.correlation_id));
      }
    });
  }
  async scheduleTick(scheduleId: string) {
    await this.locked("schedule:" + scheduleId, async (c) => {
      let s = (
        await c.query<ScheduleRow>(
          "SELECT * FROM runner.schedules WHERE schedule_id=$1",
          [scheduleId],
        )
      ).rows[0];
      if (!s || s.status !== "pending") return;
      if (s.run_at.getTime() > Date.now()) {
        await queue(c, "schedule_tick", s.schedule_id, s.run_at);
        return;
      }
      try {
        const principal = this.service.principal(s.owner_id, s.actor_id);
        if (!principal || !principal.permissions.includes("schedule:write"))
          throw new ApiError(
            403,
            "forbidden",
            "Schedule principal is no longer authorized",
          );
        let outcome: "fired" | "skipped" = "fired";
        let reason: string | undefined;
        if (s.action === "submit_job") {
          this.service.assertPolicy(principal, s.payload.job!);
          await this.service.assertReuse(
            principal,
            s.payload.job!,
            s.correlation_id,
          );
          await tx(c, async () => {
            await c.query(
              "SELECT schedule_id FROM runner.schedules WHERE schedule_id=$1 FOR UPDATE",
              [s!.schedule_id],
            );
            const current = await this.service.schedule(
              c,
              s!.owner_id,
              s!.schedule_id,
            );
            if (current.status !== "pending") return;
            const j = await this.service.insertJob(
              c,
              principal,
              s!.correlation_id,
              "scheduled_" + s!.schedule_id,
              { ...s!.payload.job!, run_at: s!.run_at.toISOString() },
              "schedule_dispatch",
            );
            await c.query(
              "UPDATE runner.schedules SET status='fired',job_id=$2,updated_at=now() WHERE schedule_id=$1",
              [s!.schedule_id, j.job_id],
            );
            s = { ...s!, job_id: j.job_id };
            await this.service.auditSchedule(c, s!, "schedule.fired", "fired");
          });
          return;
        }
        if (s.action === "cancel_job")
          await this.service.cancel(principal, s.correlation_id, s.job_id!);
        if (s.action === "stop_sandbox") {
          const active = (
            await c.query(
              "SELECT 1 FROM runner.jobs WHERE sandbox_id=$1 AND status IN ('dispatching','running','cancelling') LIMIT 1",
              [s.sandbox_id],
            )
          ).rowCount;
          const stale =
            s.guard_job_id &&
            (
              await c.query(
                "SELECT 1 FROM runner.jobs j JOIN runner.jobs guard ON guard.job_id=$2 WHERE j.sandbox_id=$1 AND j.job_id<>$2 AND (j.started_at>guard.finished_at OR j.finished_at>guard.finished_at) LIMIT 1",
                [s.sandbox_id, s.guard_job_id],
              )
            ).rowCount;
          if (active || stale) {
            outcome = "skipped";
            reason = active ? "sandbox_busy" : "newer_activity";
          } else {
            const box = await this.service.provider.sandbox(
              s.owner_id,
              s.correlation_id,
              s.sandbox_id!,
            );
            if (box.active_run_id) {
              outcome = "skipped";
              reason = "sandbox_busy";
            } else
              await this.service.provider.stop(
                s.owner_id,
                s.correlation_id,
                s.sandbox_id!,
              );
          }
        }
        await tx(c, async () => {
          const changed = (
            await c.query<ScheduleRow>(
              "UPDATE runner.schedules SET status=$2,updated_at=now() WHERE schedule_id=$1 AND status='pending' RETURNING *",
              [s!.schedule_id, outcome],
            )
          ).rows[0];
          if (changed)
            await this.service.auditSchedule(
              c,
              changed,
              "schedule." + outcome,
              outcome,
              reason ? { reason } : {},
            );
        });
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        if (e.retryable) {
          await queue(
            c,
            "schedule_tick",
            s.schedule_id,
            new Date(Date.now() + this.config.retryBackoffSeconds * 1000),
          );
          return;
        }
        const busy = e.code === "sandbox_busy";
        await tx(c, async () => {
          const changed = (
            await c.query<ScheduleRow>(
              "UPDATE runner.schedules SET status=$2,error=$3,updated_at=now() WHERE schedule_id=$1 AND status='pending' RETURNING *",
              [
                s!.schedule_id,
                busy ? "skipped" : "failed",
                e.safe(s!.correlation_id),
              ],
            )
          ).rows[0];
          if (changed)
            await this.service.auditSchedule(
              c,
              changed,
              busy ? "schedule.skipped" : "schedule.failed",
              changed.status,
              { error_classification: e.code },
            );
        });
      }
    });
  }
}
