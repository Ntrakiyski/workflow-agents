import { z } from "zod";
import type { PoolClient } from "pg";
import type { FastifyBaseLogger } from "fastify";
import type { Config } from "./config.js";
import { Database } from "./database.js";
import {
  AppError,
  digest,
  manifest,
  requestRow,
  uuid,
  MAX_FILE_BYTES,
  type RequestRow,
} from "./model.js";
import { RemoteError, type ExecutionServices } from "./remote.js";
import type { Objects } from "./storage.js";
import { validateDelivery } from "./validate.js";

export class RequestWorker {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active: Promise<void> | undefined;
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
      this.active = this.tick()
        .catch(() =>
          this.log.error({
            action: "worker.tick",
            outcome: "failed",
            error_classification: "worker_error",
          }),
        )
        .finally(() => {
          this.active = undefined;
          if (!this.closing)
            this.timer = setTimeout(loop, this.config.workerIntervalMs);
        });
    };
    loop();
  }
  async close() {
    this.closing = true;
    if (this.timer) clearTimeout(this.timer);
    await this.active;
  }
  async tick() {
    const rows = await this.db.pool.query(
      "SELECT * FROM application.requests WHERE (status IN ('pending','running') OR (sandbox_id IS NOT NULL AND sandbox_stopped=false AND (export_complete OR terminal_error))) AND next_attempt_at<=now() ORDER BY created_at LIMIT 8",
    );
    for (const raw of rows.rows) {
      const r = requestRow.parse(raw);
      const connection = await this.db.pool.connect();
      let locked = false;
      try {
        const lock = await connection.query(
          "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
          [r.id],
        );
        locked = lock.rows[0]?.locked === true;
        if (!locked) continue;
        const current = await this.db.ownedRequest(r.owner_id, r.id);
        if (!current) continue;
        await this.process(current, connection);
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
  }
  private async process(r: RequestRow, c: PoolClient) {
    if ((r.export_complete || r.terminal_error) && r.sandbox_id) {
      await this.remote.stop(r.sandbox_id, r.correlation_id);
      await this.db.pool.query(
        "UPDATE application.requests SET sandbox_stopped=true,updated_at=now() WHERE id=$1",
        [r.id],
      );
      await this.db.audit(c, r, "sandbox.stopped");
      return;
    }
    let sandbox = r.sandbox_id;
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
          schema_version: 1,
          request_id: r.id,
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
          "UPDATE application.requests SET job_id=$2,status='running',updated_at=now(),attempts=0 WHERE id=$1",
          [r.id, jobId],
        );
        await this.db.audit(tx, r, "request.dispatched");
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
    if (job.status !== "completed") return;
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
        "UPDATE application.requests SET status='completed',final_text=$2,validation_summary=$3,export_complete=true,updated_at=now(),attempts=0,next_attempt_at=now() WHERE id=$1",
        [r.id, result.text, summary],
      );
      await this.db.audit(tx, r, "request.completed");
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
    const permanent =
      error instanceof AppError ||
      (error instanceof RemoteError && !error.retryable) ||
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
