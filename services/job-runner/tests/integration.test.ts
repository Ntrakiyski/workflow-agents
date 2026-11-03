import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPool, migrate } from "../src/db.js";
import { Service } from "../src/service.js";
import { Worker } from "../src/worker.js";
import { createApi } from "../src/api.js";
import { validate } from "../src/validation.js";
import {
  config,
  headers,
  otherHeaders,
  submission,
  mockProvider,
  until,
  wait,
} from "./helpers.js";
const url = process.env.TEST_DATABASE_URL;
test(
  "real PostgreSQL, Graphile Worker and mock Provider HTTP behavior",
  { skip: !url, timeout: 60000 },
  async (t) => {
    const pool = createPool(url!);
    await pool.query("DROP SCHEMA IF EXISTS runner CASCADE");
    await pool.query("DROP SCHEMA IF EXISTS graphile_worker CASCADE");
    const logs: Record<string, unknown>[] = [];
    const provider = await mockProvider();
    const cfg = config(url!, provider.url);
    await migrate(pool, (r) => logs.push(r));
    await migrate(pool, (r) => logs.push(r));
    const service = new Service(pool, cfg, (r) => logs.push(r));
    let worker = new Worker(service);
    const api = createApi(service, () => worker.active);
    await api.ready();
    await worker.start();
    const send = async (
      method: string,
      path: string,
      body?: unknown,
      requestHeaders = headers,
    ) =>
      api.inject({
        method: method as any,
        url: path,
        headers: requestHeaders,
        payload: body as any,
      });
    const submit = async (
      body: unknown,
      key = randomUUID(),
      requestHeaders = headers,
    ) => {
      const r = await send("POST", "/v1/jobs", body, {
        ...requestHeaders,
        "idempotency-key": key,
      });
      assert.equal(r.statusCode, 202, r.body);
      validate("runner", "Job", r.json());
      return r.json();
    };
    const job = async (id: string) =>
      (await send("GET", "/v1/jobs/" + id)).json();
    const terminal = async (id: string) =>
      until(
        () => job(id),
        (j) =>
          ["completed", "failed", "cancelled", "timed_out"].includes(j.status),
      );
    try {
      await t.test(
        "authentication, owner isolation, strict schemas, quotas and log redaction",
        async () => {
          assert.equal(
            (await api.inject({ method: "GET", url: "/v1/jobs/unknown" }))
              .statusCode,
            401,
          );
          const j = await submit(submission());
          assert.equal(
            (await send("GET", "/v1/jobs/" + j.job_id, undefined, otherHeaders))
              .statusCode,
            404,
          );
          assert.equal(
            (await send("POST", "/v1/jobs", { ...submission(), shell: "sh" }))
              .statusCode,
            422,
          );
          const forbidden = submission();
          forbidden.workload.profile = "unregistered:v1";
          assert.equal(
            (await send("POST", "/v1/jobs", forbidden)).statusCode,
            403,
          );
          assert.equal(
            (
              await send("POST", "/v1/jobs", submission(), {
                ...headers,
                "x-owner-id": "other-owner",
              })
            ).statusCode,
            403,
          );
          const traversal = submission();
          traversal.workload.arguments.file = "../secret";
          assert.equal(
            (await send("POST", "/v1/jobs", traversal)).statusCode,
            422,
          );
          const pending = submission();
          (pending as any).run_at = new Date(Date.now() + 30000).toISOString();
          cfg.auth[0]!.max_pending_jobs = 1;
          await terminal(j.job_id);
          const p = await submit(pending);
          assert.equal(
            (
              await send("POST", "/v1/jobs", submission(), {
                ...headers,
                "idempotency-key": randomUUID(),
              })
            ).statusCode,
            429,
          );
          delete cfg.auth[0]!.max_pending_jobs;
          await send("POST", "/v1/jobs/" + p.job_id + "/cancel", {});
          assert.equal((await terminal(p.job_id)).status, "cancelled");
          assert.ok(!JSON.stringify(logs).includes("fixture-client-token"));
          assert.ok(!JSON.stringify(logs).includes("fixture-provider-token"));
          assert.ok(!JSON.stringify(logs).includes('"text":"hello"'));
        },
      );
      await t.test(
        "durable submissions deduplicate concurrent delivery and reject changed reuse",
        async () => {
          const body = submission(),
            key = randomUUID(),
            before = provider.stats.executions;
          const [a, b] = await Promise.all([
            submit(body, key),
            submit(body, key),
          ]);
          assert.equal(a.job_id, b.job_id);
          assert.equal((await terminal(a.job_id)).status, "completed");
          assert.equal(provider.stats.executions, before + 1);
          assert.equal(
            (
              await send(
                "POST",
                "/v1/jobs",
                { ...body, client_reference: "changed" },
                { ...headers, "idempotency-key": key },
              )
            ).statusCode,
            409,
          );
        },
      );
      await t.test(
        "delayed job does not run early and survives worker restart",
        async () => {
          const body = submission();
          (body as any).run_at = new Date(Date.now() + 900).toISOString();
          const j = await submit(body);
          assert.equal(j.status, "scheduled");
          await worker.stop();
          await wait(150);
          assert.equal((await job(j.job_id)).attempt_count, 0);
          worker = new Worker(service);
          await worker.start();
          assert.equal((await terminal(j.job_id)).status, "completed");
        },
      );
      await t.test(
        "classified transient workload failure creates a fresh bounded attempt",
        async () => {
          provider.stats.transientRuns = 1;
          const before = provider.stats.executions;
          const j = await submit(submission());
          const result = await terminal(j.job_id);
          assert.equal(result.status, "completed");
          assert.equal(result.attempt_count, 2);
          assert.equal(provider.stats.executions, before + 2);
          const events = (
            await send("GET", "/v1/jobs/" + j.job_id + "/events")
          ).json();
          assert.ok(events.events.some((e: any) => e.type === "job.retry"));
        },
      );
      await t.test(
        "ambiguous create and execute reconcile stable keys across restart",
        async () => {
          provider.stats.ambiguousCreate = true;
          provider.stats.ambiguousExecute = true;
          const created = provider.stats.creates,
            executed = provider.stats.executions;
          const j = await submit(submission());
          await until(
            async () => provider.stats.executions,
            (n) => n > executed,
          );
          await worker.stop();
          worker = new Worker(service);
          await worker.start();
          const result = await terminal(j.job_id);
          assert.equal(result.status, "completed");
          assert.equal(result.attempt_count, 1);
          assert.equal(provider.stats.creates, created + 1);
          assert.equal(provider.stats.executions, executed + 1);
        },
      );
      await t.test(
        "one active execution per retained sandbox and cross-owner concurrency",
        async () => {
          provider.stats.delayMs = 250;
          const body = submission(),
            before = provider.stats.executions;
          const a = await submit(body);
          await until(
            () => job(a.job_id),
            (j) => j.sandbox_id !== null,
          );
          const bbody = submission("second");
          bbody.sandbox = body.sandbox;
          const b = await submit(bbody);
          const c = await submit(submission(), randomUUID(), otherHeaders);
          await Promise.all([
            terminal(a.job_id),
            terminal(b.job_id),
            until(
              async () =>
                (
                  await send(
                    "GET",
                    "/v1/jobs/" + c.job_id,
                    undefined,
                    otherHeaders,
                  )
                ).json(),
              (j) => j.status === "completed",
            ),
          ]);
          assert.equal(provider.stats.executions, before + 3);
          assert.ok(provider.stats.maxActive >= 2);
          provider.stats.delayMs = 100;
        },
      );
      await t.test(
        "active cancellation waits for Provider terminal state and preserves sandbox",
        async () => {
          provider.stats.holdRuns = true;
          const j = await submit(submission());
          const active = await until(
            () => job(j.job_id),
            (j) => j.status === "running",
          );
          const c = await send("POST", "/v1/jobs/" + j.job_id + "/cancel", {
            reason: "fixture cancellation",
          });
          assert.equal(c.statusCode, 202);
          assert.equal(c.json().status, "cancelling");
          const end = await terminal(j.job_id);
          assert.equal(end.status, "cancelled");
          assert.equal(
            provider.sandboxes.get(active.sandbox_id).status,
            "running",
          );
          provider.stats.holdRuns = false;
        },
      );
      await t.test(
        "ambiguous unlaunched execution is fenced on cancel without creating a workload",
        async () => {
          provider.stats.rejectExecuteBefore = true;
          const before = provider.stats.executions,
            requests = provider.stats.executeRequests;
          const j = await submit(submission());
          await until(
            async () => provider.stats.executeRequests,
            (n) => n > requests,
          );
          await send("POST", "/v1/jobs/" + j.job_id + "/cancel", {});
          const done = await terminal(j.job_id);
          assert.equal(done.status, "cancelled");
          assert.equal(provider.stats.executions, before);
          provider.stats.rejectExecuteBefore = false;
        },
      );
      await t.test(
        "expired deadlines prevent dispatch and running duration cancels the real HTTP mock run",
        async () => {
          const body = submission();
          (body.limits as any).deadline_at = new Date(
            Date.now() - 1000,
          ).toISOString();
          const before = provider.stats.executions;
          const j = await submit(body);
          assert.equal((await terminal(j.job_id)).status, "timed_out");
          assert.equal(provider.stats.executions, before);
          provider.stats.holdRuns = true;
          const short = submission();
          short.limits.max_duration_seconds = 1;
          const active = await submit(short);
          assert.equal((await terminal(active.job_id)).status, "timed_out");
          provider.stats.holdRuns = false;
        },
      );
      await t.test(
        "resume reads same mock filesystem after non-destructive scheduled stop",
        async () => {
          const j = await submit(submission("retained marker"));
          const done = await terminal(j.job_id);
          const stop = await send(
            "POST",
            "/v1/schedules",
            {
              run_at: new Date(Date.now() + 250).toISOString(),
              action: "stop_sandbox",
              sandbox_id: done.sandbox_id,
            },
            { ...headers, "idempotency-key": randomUUID() },
          );
          assert.equal(stop.statusCode, 201, stop.body);
          validate("runner", "Schedule", stop.json());
          await until(
            async () =>
              (
                await send("GET", "/v1/schedules/" + stop.json().schedule_id)
              ).json(),
            (s) => s.status === "fired",
          );
          assert.equal(
            provider.sandboxes.get(done.sandbox_id).status,
            "stopped",
          );
          const resumed = await send(
            "POST",
            "/v1/jobs/" + j.job_id + "/resume",
            {
              workload: {
                profile: "fixture-read-file:v1",
                arguments: { file: "hello-world.txt" },
              },
              limits: { max_duration_seconds: 10, max_attempts: 1 },
            },
            { ...headers, "idempotency-key": randomUUID() },
          );
          assert.equal(resumed.statusCode, 202, resumed.body);
          const read = await terminal(resumed.json().job_id);
          assert.equal(read.result.stdout, "retained marker");
          assert.equal(read.sandbox_id, done.sandbox_id);
        },
      );
      await t.test(
        "schedule cancellation is durable and delayed submit survives restart",
        async () => {
          const schedule = await send(
            "POST",
            "/v1/schedules",
            {
              run_at: new Date(Date.now() + 400).toISOString(),
              action: "submit_job",
              job: submission(),
            },
            { ...headers, "idempotency-key": randomUUID() },
          );
          assert.equal(schedule.statusCode, 201, schedule.body);
          const sid = schedule.json().schedule_id;
          assert.equal(
            (await send("DELETE", "/v1/schedules/" + sid)).json().status,
            "cancelled",
          );
          await wait(450);
          assert.equal(
            (await send("GET", "/v1/schedules/" + sid)).json().status,
            "cancelled",
          );
          const second = await send(
            "POST",
            "/v1/schedules",
            {
              run_at: new Date(Date.now() + 500).toISOString(),
              action: "submit_job",
              job: submission(),
            },
            { ...headers, "idempotency-key": randomUUID() },
          );
          await worker.stop();
          worker = new Worker(service);
          await worker.start();
          const fired = await until(
            async () =>
              (
                await send("GET", "/v1/schedules/" + second.json().schedule_id)
              ).json(),
            (s) => s.status === "fired",
          );
          assert.equal((await terminal(fired.job_id)).status, "completed");
        },
      );
      await t.test(
        "scheduled stop versus cancellation is serialized during external HTTP side effect",
        async () => {
          const j = await submit(submission());
          const done = await terminal(j.job_id);
          provider.stats.stopDelayMs = 90;
          provider.stats.stopStarted = false;
          const r = await send(
            "POST",
            "/v1/schedules",
            {
              run_at: new Date().toISOString(),
              action: "stop_sandbox",
              sandbox_id: done.sandbox_id,
            },
            { ...headers, "idempotency-key": randomUUID() },
          );
          await until(
            async () => provider.stats.stopStarted,
            (x) => x,
          );
          const cancelled = await send(
            "DELETE",
            "/v1/schedules/" + r.json().schedule_id,
          );
          assert.equal(cancelled.statusCode, 409, cancelled.body);
          assert.equal(
            (await send("GET", "/v1/schedules/" + r.json().schedule_id)).json()
              .status,
            "fired",
          );
          provider.stats.stopDelayMs = 0;
        },
      );
      await t.test(
        "audit is durable, immutable, paginated, correlated; readiness checks database/worker",
        async () => {
          const j = await submit(submission());
          await terminal(j.job_id);
          const eventResponse = await send(
            "GET",
            "/v1/jobs/" + j.job_id + "/events?limit=1",
          );
          assert.equal(eventResponse.statusCode, 200);
          validate("runner", "EventPage", eventResponse.json());
          assert.ok(eventResponse.json().next_cursor);
          const page2 = await send(
            "GET",
            "/v1/jobs/" +
              j.job_id +
              "/events?limit=1&cursor=" +
              eventResponse.json().next_cursor,
          );
          assert.notEqual(
            eventResponse.json().events[0].event_id,
            page2.json().events[0].event_id,
          );
          assert.equal(
            eventResponse.json().events[0].correlation_id,
            "corr_fixture",
          );
          assert.equal(
            eventResponse.json().events[0].actor_id,
            "fixture-client",
          );
          assert.equal(
            eventResponse.json().events[0].owner_id,
            "fixture-owner",
          );
          await assert.rejects(
            pool.query("UPDATE runner.audit_events SET status='forged'"),
            /immutable/,
          );
          assert.equal(
            (
              await send(
                "GET",
                "/v1/jobs/" + j.job_id + "/events?cursor=malformed",
              )
            ).statusCode,
            400,
          );
          assert.equal(
            (
              await send(
                "GET",
                "/v1/jobs/" +
                  j.job_id +
                  "/events?cursor=seq_999999999999999999999999",
              )
            ).statusCode,
            400,
          );
          assert.equal((await send("GET", "/health/ready")).statusCode, 200);
          await worker.stop();
          assert.equal((await send("GET", "/health/ready")).statusCode, 503);
          worker = new Worker(service);
          await worker.start();
          assert.ok(logs.some((e) => e.action === "job.recovered"));
          assert.ok(
            logs.every(
              (e) =>
                typeof e.timestamp === "string" && e.service === "job-runner",
            ),
          );
        },
      );
    } finally {
      await api.close();
      await worker.stop();
      await provider.close();
      await pool.end();
    }
  },
);
