import { z } from "zod";
import type { PoolClient } from "pg";
import type { FastifyBaseLogger } from "fastify";
import type { Config } from "./config.js";
import { Database, workspaceLock } from "./database.js";
import {
  AppError,
  digest,
  manifest,
  requestRow,
  uuid,
  MAX_FILE_BYTES,
  workspaceRow,
  type WorkspaceRow,
  type RequestRow,
} from "./model.js";
import { RemoteError, type ExecutionServices } from "./remote.js";
import type { Objects } from "./storage.js";
import { validateDelivery } from "./validate.js";
import { progress, uploadProgress } from "./progress.js";

export class RequestWorker {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private tasks = new Map<string, Promise<void>>();
  private scheduling: Promise<void> | undefined;
  private closing = false;
  constructor(
    private db: Database,
    private objects: Objects,
    private remote: ExecutionServices,
    private config: Config,
    private log: FastifyBaseLogger,
  ) {}
  start() {
    const loop = () => {
      if (this.closing) return;
      if (!this.scheduling)
        this.scheduling = this.schedule()
          .catch(() =>
            this.log.error({
              action: "worker.tick",
              outcome: "failed",
              error_classification: "worker_error",
            }),
          )
          .finally(() => {
            this.scheduling = undefined;
          });
      this.timer = setTimeout(loop, this.config.workerIntervalMs);
    };
    loop();
  }
  async close() {
    this.closing = true;
    if (this.timer) clearTimeout(this.timer);
    await this.scheduling;
    await Promise.all(this.tasks.values());
  }
  // Deterministic drain for an explicit operator/test tick; start() keeps polling while uploads run.
  async tick() {
    await this.schedule();
    await Promise.all(this.tasks.values());
  }
  private launch(key: string, operation: () => Promise<void>) {
    if (this.tasks.has(key)) return;
    const task = operation()
      .catch(() =>
        this.log.error({
          action: "worker.task",
          outcome: "failed",
          error_classification: "worker_error",
        }),
      )
      .finally(() => {
        this.tasks.delete(key);
      });
    this.tasks.set(key, task);
  }
  private async schedule() {
    const workspaces = await this.db.pool.query(
      "SELECT w.* FROM application.user_workspaces w WHERE next_attempt_at<=now() AND (status IN ('pending','uploading','preparing','stopping') OR (status='failed' AND sandbox_id IS NOT NULL AND sandbox_stopped=false) OR (status='stopped' AND (wake_requested OR EXISTS(SELECT 1 FROM application.requests r WHERE r.workspace_id=w.id AND r.status IN ('pending','running')))) OR (status='ready' AND updated_at<=now()-make_interval(secs=>$1) AND NOT EXISTS(SELECT 1 FROM application.requests r WHERE r.workspace_id=w.id AND r.status IN ('pending','running')))) ORDER BY CASE WHEN status='ready' THEN 1 ELSE 0 END,updated_at LIMIT 32",
      [this.config.idleStopSeconds],
    );
    for (const raw of workspaces.rows) {
      const workspace = workspaceRow.parse(raw);
      if (
        [...this.tasks.keys()].filter((key) => key.startsWith("workspace:"))
          .length >= 2
      )
        break;
      this.launch(`workspace:${workspace.id}`, () =>
        this.processWorkspace(workspace),
      );
    }
    const rows = await this.db.pool.query(
      "SELECT r.* FROM application.requests r LEFT JOIN application.user_workspaces w ON w.id=r.workspace_id WHERE (r.status IN ('pending','running') OR (r.workspace_id IS NULL AND r.sandbox_id IS NOT NULL AND r.sandbox_stopped=false AND (r.export_complete OR r.terminal_error))) AND r.next_attempt_at<=now() ORDER BY CASE WHEN r.status='running' THEN 0 WHEN w.status='ready' OR r.workspace_id IS NULL THEN 1 ELSE 2 END,r.created_at LIMIT 32",
    );
    for (const raw of rows.rows) {
      const r = requestRow.parse(raw);
      if (
        [...this.tasks.keys()].filter((key) => key.startsWith("request:"))
          .length >= this.config.requestConcurrency
      )
        break;
      this.launch(`request:${r.id}`, () => this.processLockedRequest(r));
    }
  }
  private async processLockedRequest(r: RequestRow) {
    const connection = await this.db.pool.connect();
    let locked = false;
    try {
      const lock = await connection.query(
        "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
        [r.id],
      );
      locked = lock.rows[0]?.locked === true;
      if (!locked) return;
      const current = await this.db.ownedRequest(r.owner_id, r.id);
      if (current) await this.process(current, connection);
    } catch (error) {
      await this.failure(r, error);
    } finally {
      if (locked)
        await connection.query(
          "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
          [r.id],
        );
      connection.release();
    }
  }
  private async processWorkspace(original: WorkspaceRow) {
    const c = await this.db.pool.connect();
    let locked = false;
    try {
      locked =
        (
          await c.query(
            "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
            [`provision:${original.owner_id}`],
          )
        ).rows[0]?.locked === true;
      if (!locked) return;
      const w = await this.db.workspace(original.owner_id);
      if (!w) return;
      if (w.status === "failed") {
        if (w.sandbox_id && !w.sandbox_stopped) {
          await this.remote.stop(w.sandbox_id, w.id);
          await c.query(
            "UPDATE application.user_workspaces SET sandbox_stopped=true WHERE id=$1",
            [w.id],
          );
          await this.workspaceAudit(c, w, "workspace.stopped");
        }
        return;
      }
      if (w.runtime_sha256 !== this.config.runtimeBundleSha256)
        throw new AppError(
          422,
          "workspace_runtime_changed",
          "Your workspace requires an update. Contact support before submitting more requests.",
        );
      if (w.status === "stopping") {
        await this.finishWorkspaceStop(w);
        return;
      }
      if (w.status === "ready") {
        await this.stopIdleWorkspace(w);
        return;
      }
      if (w.status === "stopped") {
        const pending = await c.query(
          "SELECT 1 FROM application.requests WHERE workspace_id=$1 AND status IN ('pending','running') LIMIT 1",
          [w.id],
        );
        if (!pending.rowCount && !w.wake_requested) return;
        if (!w.sandbox_id) throw new Error("workspace_identity_missing");
        await this.remote.start(w.sandbox_id, w.id);
        await c.query(
          "UPDATE application.user_workspaces SET status='ready',sandbox_stopped=false,wake_requested=false,updated_at=now(),attempts=0 WHERE id=$1",
          [w.id],
        );
        return;
      }
      let sandbox = w.sandbox_id;
      if (!sandbox) {
        sandbox = await this.remote.createWorkspaceSandbox(w.id);
        await c.query(
          "UPDATE application.user_workspaces SET sandbox_id=$2,status='uploading',updated_at=now() WHERE id=$1",
          [w.id, sandbox],
        );
      }
      let prepareId = w.prepare_job_id;
      if (!prepareId) {
        const runtime = await this.objects.get(
          this.config.runtimeBundleKey,
          256 * 1024 * 1024,
        );
        if (digest(runtime) !== w.runtime_sha256)
          throw new AppError(
            422,
            "runtime_integrity",
            "Your workspace could not be prepared. Contact support.",
          );
        await c.query(
          "UPDATE application.user_workspaces SET status='uploading',total_bytes=$2 WHERE id=$1",
          [w.id, runtime.length],
        );
        await this.remote.upload(
          sandbox,
          "runtime/runtime-bundle.tar.gz",
          runtime,
          `workspace:runtime:${w.id}`,
          w.id,
          async (uploaded, total) => {
            await this.db.pool.query(
              "UPDATE application.user_workspaces SET uploaded_bytes=$2,total_bytes=$3,updated_at=now() WHERE id=$1",
              [w.id, uploaded, total],
            );
          },
        );
        // Stable key reconciles a lost prepare-submission acknowledgement without another install.
        const prepared = await this.remote.prepare(w.id, sandbox);
        prepareId = prepared.job_id;
        await c.query(
          "UPDATE application.user_workspaces SET status='preparing',prepare_job_id=$2,uploaded_bytes=total_bytes,updated_at=now() WHERE id=$1",
          [w.id, prepareId],
        );
      }
      const job = await this.remote.job(prepareId, w.id);
      if (["failed", "cancelled", "timed_out"].includes(job.status))
        throw new AppError(
          422,
          "workspace_preparation_failed",
          "Your workspace could not be prepared. Contact support. Your requests have been saved.",
        );
      if (job.status !== "completed") return;
      const result = z
        .object({
          schema_version: z.literal(1),
          prepared: z.literal(true),
          runtime_sha256: z.literal(w.runtime_sha256),
        })
        .strict()
        .parse(JSON.parse(job.result?.stdout ?? "null"));
      if (job.result?.exit_code !== 0 || !result.prepared)
        throw new AppError(
          422,
          "workspace_preparation_invalid",
          "Your workspace could not be verified. Contact support.",
        );
      await this.db.transaction(async (tx) => {
        await tx.query(
          "UPDATE application.user_workspaces SET status='ready',wake_requested=false,failure_message=NULL,attempts=0,updated_at=now() WHERE id=$1",
          [w.id],
        );
        await this.workspaceAudit(tx, w, "workspace.ready");
      });
    } catch (error) {
      const permanent =
        error instanceof AppError ||
        error instanceof z.ZodError ||
        error instanceof SyntaxError ||
        (error instanceof RemoteError &&
          !error.retryable &&
          !["sandbox_busy", "invalid_state"].includes(error.code));
      await this.db.pool.query(
        "UPDATE application.user_workspaces SET status=CASE WHEN $2 THEN 'failed' ELSE status END,failure_message=$3,attempts=attempts+1,next_attempt_at=now()+interval '10 seconds',updated_at=now() WHERE id=$1",
        [
          original.id,
          permanent,
          permanent && error instanceof AppError
            ? error.message
            : permanent
              ? "Your workspace could not be verified. Contact support. Your requests have been saved."
              : null,
        ],
      );
      this.log.warn({
        action: "workspace.reconcile",
        owner_id: original.owner_id,
        outcome: permanent ? "failed" : "retry",
        error_classification: "workspace_unavailable",
      });
    } finally {
      if (locked)
        await c.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [
          `provision:${original.owner_id}`,
        ]);
      c.release();
    }
  }
  private async workspaceAudit(
    c: Pick<PoolClient, "query">,
    w: WorkspaceRow,
    action: string,
  ) {
    await c.query(
      "INSERT INTO application.audit(owner_id,actor_id,action,correlation_id) VALUES($1,'application-worker',$2,$3)",
      [w.owner_id, action, w.id],
    );
  }
  private async stopIdleWorkspace(w: WorkspaceRow) {
    if (!w.sandbox_id) return;
    const stopping = await this.db.transaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        workspaceLock(w.owner_id),
      ]);
      const eligible = await c.query(
        "UPDATE application.user_workspaces w SET status='stopping',wake_requested=false WHERE w.id=$1 AND w.status='ready' AND w.updated_at<=now()-make_interval(secs=>$2) AND NOT EXISTS(SELECT 1 FROM application.requests r WHERE r.workspace_id=w.id AND r.status IN ('pending','running')) RETURNING w.id",
        [w.id, this.config.idleStopSeconds],
      );
      if (!eligible.rowCount) return false;
      await this.workspaceAudit(c, w, "workspace.stop_requested");
      return true;
    });
    if (stopping) await this.finishWorkspaceStop(w);
  }
  private async finishWorkspaceStop(w: WorkspaceRow) {
    if (!w.sandbox_id) throw new Error("workspace_identity_missing");
    // Admission may now proceed; a newly queued request waits for this same-disk stop/start.
    await this.remote.stop(w.sandbox_id, w.id);
    await this.db.transaction(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        workspaceLock(w.owner_id),
      ]);
      await c.query(
        "UPDATE application.user_workspaces SET status='stopped',sandbox_stopped=true,updated_at=now() WHERE id=$1 AND status='stopping'",
        [w.id],
      );
      await c.query(
        "UPDATE application.requests SET sandbox_stopped=true WHERE workspace_id=$1 AND status IN ('completed','failed')",
        [w.id],
      );
      await this.workspaceAudit(c, w, "workspace.stopped");
    });
  }
  private async process(r: RequestRow, c: PoolClient) {
    if (
      !r.workspace_id &&
      (r.export_complete || r.terminal_error) &&
      r.sandbox_id
    ) {
      await this.remote.stop(r.sandbox_id, r.correlation_id);
      await this.db.pool.query(
        "UPDATE application.requests SET sandbox_stopped=true,updated_at=now() WHERE id=$1",
        [r.id],
      );
      await this.db.audit(c, r, "sandbox.stopped");
      return;
    }
    let sandbox = r.sandbox_id;
    if (r.workspace_id) {
      const w = await this.db.workspace(r.owner_id);
      if (!w || w.id !== r.workspace_id)
        throw new AppError(
          422,
          "workspace_identity",
          "Your workspace could not be found. Contact support.",
        );
      if (w.runtime_sha256 !== this.config.runtimeBundleSha256)
        throw new AppError(
          422,
          "workspace_runtime_changed",
          "Your workspace requires an update. Contact support before submitting more requests.",
        );
      if (w.status === "failed")
        throw new AppError(
          422,
          "workspace_unavailable",
          w.failure_message ??
            "Your workspace needs attention. Contact support. Your request has been saved.",
        );
      if (w.status !== "ready") {
        const message =
          w.status === "uploading"
            ? uploadProgress(
                w.total_bytes
                  ? Math.floor((w.uploaded_bytes * 100) / w.total_bytes)
                  : 0,
              )
            : w.status === "preparing"
              ? progress.installing
              : w.status === "stopping"
                ? progress.stopping
                : w.status === "stopped"
                  ? progress.starting
                  : progress.preparing;
        await this.db.progress(c, r, message);
        return;
      }
      if (!w.sandbox_id) throw new Error("workspace_identity_missing");
      sandbox = w.sandbox_id;
      if (!r.job_id) {
        await c.query(
          "UPDATE application.requests SET sandbox_id=$2 WHERE id=$1 AND job_id IS NULL",
          [r.id, sandbox],
        );
        await this.db.progress(c, r, progress.inputs);
      }
    }
    if (!sandbox) {
      sandbox = await this.remote.createSandbox(r.id);
      await this.db.pool.query(
        "UPDATE application.requests SET sandbox_id=$2,updated_at=now() WHERE id=$1",
        [r.id, sandbox],
      );
      await this.db.audit(c, r, "sandbox.prepared");
    }
    let jobId = r.job_id;
    if (!jobId) {
      if (!r.workspace_id) {
        const runtime = await this.objects.get(
          this.config.runtimeBundleKey,
          256 * 1024 * 1024,
        );
        if (digest(runtime) !== this.config.runtimeBundleSha256)
          throw new AppError(
            422,
            "runtime_integrity",
            "The request service is unavailable. Contact support with the request identifier.",
          );
        await this.remote.upload(
          sandbox,
          "runtime/runtime-bundle.tar.gz",
          runtime,
          `runtime:${r.id}`,
          r.correlation_id,
        );
      }
      const files = (await this.db.files(r.id)).filter(
        (f) => f.kind === "input",
      );
      const inputs = [];
      for (const file of files) {
        const data = await this.objects.get(file.object_key, MAX_FILE_BYTES);
        if (digest(data) !== file.sha256 || data.length !== file.size_bytes)
          throw new AppError(
            422,
            "input_integrity",
            "An input file could not be verified. Upload it again in a new request.",
          );
        const path = `${file.id}.${file.name.toLowerCase().split(".").pop()}`;
        await this.remote.upload(
          sandbox,
          `requests/${r.id}/inputs/${path}`,
          data,
          `input:${file.id}`,
          r.correlation_id,
        );
        inputs.push({
          name: file.name,
          path,
          media_type: file.media_type,
          size_bytes: file.size_bytes,
          sha256: file.sha256,
        });
      }
      const requestData = Buffer.from(
        JSON.stringify({
          schema_version: r.workspace_id ? 2 : 1,
          request_id: r.id,
          ...(r.workspace_id ? { system_prompt: r.system_prompt } : {}),
          instructions: r.instructions,
          inputs,
        }),
      );
      await this.saveFile(
        r,
        "checkpoint",
        "request.json",
        "application/json",
        requestData,
        digest(requestData),
      );
      await this.remote.upload(
        sandbox,
        `requests/${r.id}/request.json`,
        requestData,
        `request:${r.id}`,
        r.correlation_id,
      );
      const submitted = await this.remote.submit(r.id, sandbox);
      jobId = submitted.job_id;
      await this.db.transaction(async (tx) => {
        await tx.query(
          "UPDATE application.requests SET job_id=$2,status='running',progress_message=NULL,updated_at=now(),attempts=0 WHERE id=$1",
          [r.id, jobId],
        );
        await this.db.audit(tx, r, "request.dispatched");
        if (r.workspace_id)
          await tx.query(
            "UPDATE application.user_workspaces SET updated_at=now() WHERE id=$1",
            [r.workspace_id],
          );
      });
    }
    const page = await this.remote.events(
      jobId,
      r.event_cursor,
      r.correlation_id,
    );
    await this.db.transaction(async (tx) => {
      for (const event of page.events)
        await tx.query(
          "INSERT INTO application.runner_events(request_id,event_id,event_type) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
          [r.id, event.event_id, event.type],
        );
      if (page.next_cursor)
        await tx.query(
          "UPDATE application.requests SET event_cursor=$2 WHERE id=$1",
          [r.id, page.next_cursor],
        );
    });
    const job = await this.remote.job(jobId, r.correlation_id);
    if (["failed", "cancelled", "timed_out"].includes(job.status)) {
      const message =
        job.error?.code === "ambiguous_execution"
          ? "The request was interrupted and its outcome is uncertain. Contact support with the request identifier before repeating it."
          : job.status === "timed_out"
            ? "The request exceeded its time limit. Try a smaller request."
            : "The request could not finish. Check your inputs and submit a new request.";
      await this.db.transaction(async (tx) => {
        await tx.query(
          "UPDATE application.requests SET status='failed',failure_message=$2,terminal_error=true,updated_at=now(),next_attempt_at=now() WHERE id=$1",
          [r.id, message],
        );
        await this.db.audit(tx, r, "request.failed");
      });
      return;
    }
    if (job.status !== "completed") {
      await this.db.progress(
        c,
        r,
        ["queued", "scheduled", "retry_wait", "dispatching"].includes(
          job.status,
        )
          ? progress.queued
          : progress.working,
      );
      return;
    }
    await this.db.progress(c, r, progress.saving);
    if (job.result?.exit_code !== 0)
      throw new AppError(
        422,
        "missing_result",
        "The request produced no verified result. Contact support with the request identifier.",
      );
    // Exit zero alone never delivers a result. The independently transferred manifest and files are mandatory.
    const manifestData = await this.remote.download(
      sandbox,
      `requests/${r.id}/outputs/result.json`,
      1024 * 1024,
      r.correlation_id,
    );
    let decoded: unknown;
    try {
      decoded = JSON.parse(manifestData.toString("utf8"));
    } catch {
      throw new AppError(
        422,
        "invalid_result",
        "The result could not be verified. Contact support with the request identifier.",
      );
    }
    const result = manifest.parse(decoded);
    if (result.request_id !== r.id)
      throw new AppError(
        422,
        "result_identity",
        "The result identity could not be verified. Contact support with the request identifier.",
      );
    if (result.outcome === "completed" && result.session_files.length === 0)
      throw new AppError(
        422,
        "missing_session",
        "The request state could not be safely saved. Contact support with the request identifier.",
      );
    const outputs = new Map<string, Buffer>();
    for (const artifact of result.artifacts)
      outputs.set(
        artifact.path,
        await this.remote.download(
          sandbox,
          `requests/${r.id}/outputs/${artifact.path}`,
          MAX_FILE_BYTES,
          r.correlation_id,
        ),
      );
    const summary = await validateDelivery(result, outputs);
    for (const artifact of result.artifacts) {
      const data = outputs.get(artifact.path);
      if (!data) throw new Error("missing_verified_artifact");
      await this.saveFile(
        r,
        "output",
        artifact.path,
        artifact.media_type,
        data,
        artifact.sha256,
      );
    }
    await this.saveFile(
      r,
      "checkpoint",
      "result.json",
      "application/json",
      manifestData,
      digest(manifestData),
    );
    for (const session of result.session_files) {
      const data = await this.remote.download(
        sandbox,
        `requests/${r.id}/session/${session.path}`,
        MAX_FILE_BYTES,
        r.correlation_id,
      );
      if (data.length !== session.size_bytes || digest(data) !== session.sha256)
        throw new AppError(
          422,
          "session_integrity",
          "The request state could not be safely saved. Contact support with the request identifier.",
        );
      await this.saveFile(
        r,
        "checkpoint",
        session.path,
        "application/x-ndjson",
        data,
        session.sha256,
      );
    }
    await this.db.transaction(async (tx) => {
      await tx.query(
        "UPDATE application.requests SET status='completed',progress_message=NULL,final_text=$2,validation_summary=$3,export_complete=true,updated_at=now(),attempts=0,next_attempt_at=now() WHERE id=$1",
        [r.id, result.text, summary],
      );
      await this.db.audit(tx, r, "request.completed");
      if (r.workspace_id)
        await tx.query(
          "UPDATE application.user_workspaces SET updated_at=now() WHERE id=$1",
          [r.workspace_id],
        );
    });
    this.log.info({
      action: "request.completed",
      request_id: r.id,
      owner_id: r.owner_id,
      correlation_id: r.correlation_id,
      outcome: "passed",
    });
  }
  private async saveFile(
    r: RequestRow,
    kind: "output" | "checkpoint",
    name: string,
    mediaType: string,
    data: Buffer,
    sha256: string,
  ) {
    const objectKey = `owners/${r.owner_id}/requests/${r.id}/${kind}/${sha256}/${name}`;
    await this.objects.put(objectKey, data, mediaType, sha256);
    const saved = await this.db.pool.query(
      "INSERT INTO application.files(id,owner_id,request_id,kind,name,media_type,size_bytes,sha256,object_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(request_id,kind,name) DO UPDATE SET name=application.files.name RETURNING sha256",
      [
        uuid(),
        r.owner_id,
        r.id,
        kind,
        name,
        mediaType,
        data.length,
        sha256,
        objectKey,
      ],
    );
    if (saved.rows[0]?.sha256 !== sha256)
      throw new AppError(
        422,
        "result_changed",
        "A result changed during recovery. Contact support with the request identifier.",
      );
  }
  private async failure(r: RequestRow, error: unknown) {
    if (r.export_complete || r.terminal_error) {
      await this.db.pool.query(
        "UPDATE application.requests SET attempts=attempts+1,next_attempt_at=now()+interval '30 seconds' WHERE id=$1",
        [r.id],
      );
      this.log.warn({
        action: "sandbox.stop",
        request_id: r.id,
        owner_id: r.owner_id,
        correlation_id: r.correlation_id,
        outcome: "retry",
        error_classification: "stop_unconfirmed",
      });
      return;
    }
    if (
      r.workspace_id &&
      error instanceof RemoteError &&
      ["sandbox_busy", "invalid_state"].includes(error.code)
    ) {
      const workspace = await this.db.workspace(r.owner_id);
      if (workspace?.sandbox_id && workspace.status === "ready") {
        try {
          const actual = await this.remote.inspect(
            workspace.sandbox_id,
            r.correlation_id,
          );
          if (actual.status === "stopped")
            await this.db.transaction(async (c) => {
              await c.query(
                "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
                [workspaceLock(r.owner_id)],
              );
              await c.query(
                "UPDATE application.user_workspaces SET status='stopped',sandbox_stopped=true,next_attempt_at=now() WHERE id=$1 AND status='ready'",
                [workspace.id],
              );
              await this.workspaceAudit(
                c,
                workspace,
                "workspace.stopped_observed",
              );
            });
        } catch {
          /* Preserve exact request identity until lifecycle inspection succeeds. */
        }
      }
    }
    const permanent =
      error instanceof AppError ||
      (error instanceof RemoteError &&
        !error.retryable &&
        !["sandbox_busy", "invalid_state", "quota_exceeded"].includes(
          error.code,
        )) ||
      error instanceof SyntaxError ||
      error instanceof z.ZodError;
    const code =
      error instanceof AppError || error instanceof RemoteError
        ? error.code
        : error instanceof z.ZodError
          ? "invalid_result_schema"
          : "dependency_unavailable";
    const message =
      error instanceof AppError
        ? error.message
        : "The request service is unavailable. Contact support with the request identifier.";
    if (permanent) {
      await this.db.transaction(async (c) => {
        await c.query(
          "UPDATE application.requests SET status='failed',terminal_error=true,failure_message=$2,updated_at=now(),next_attempt_at=now()+interval '30 seconds' WHERE id=$1",
          [r.id, message],
        );
        await this.db.audit(c, r, "request.failed", "application-worker", {
          code,
        });
      });
    } else {
      await this.db.pool.query(
        "UPDATE application.requests SET attempts=attempts+1,next_attempt_at=now()+make_interval(secs=>LEAST(60, power(2,LEAST(attempts,6))::integer)),updated_at=now() WHERE id=$1",
        [r.id],
      );
    }
    this.log.warn({
      action: "request.reconcile",
      request_id: r.id,
      owner_id: r.owner_id,
      correlation_id: r.correlation_id,
      outcome: permanent ? "failed" : "retry",
      error_classification: code,
    });
  }
}
