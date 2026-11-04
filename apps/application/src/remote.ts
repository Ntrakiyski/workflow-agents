import { z } from "zod";
import type { Config } from "./config.js";
import { digest } from "./model.js";
const jobSchema = z.object({
  job_id: z.string(),
  status: z.enum([
    "queued",
    "scheduled",
    "dispatching",
    "running",
    "retry_wait",
    "cancelling",
    "completed",
    "failed",
    "cancelled",
    "timed_out",
  ]),
  sandbox_id: z.string().nullable(),
  result: z
    .object({
      exit_code: z.number().nullable(),
      stdout: z.string(),
      stderr: z.string(),
      output_truncated: z.boolean(),
      artifacts: z.array(z.unknown()),
    })
    .nullable(),
  error: z.object({ code: z.string(), retryable: z.boolean() }).nullable(),
});
export type Job = z.infer<typeof jobSchema>;
export type RunnerEvent = { event_id: string; type: string };
export interface ExecutionServices {
  createSandbox(requestId: string): Promise<string>;
  createWorkspaceSandbox(workspaceId: string): Promise<string>;
  start(sandbox: string, correlation: string): Promise<void>;
  inspect(sandbox: string, correlation: string): Promise<{ status: string }>;
  prepare(workspaceId: string, sandbox: string): Promise<Job>;
  upload(
    sandbox: string,
    path: string,
    data: Buffer,
    key: string,
    correlation?: string,
    progress?: (uploaded: number, total: number) => Promise<void>,
  ): Promise<void>;
  download(
    sandbox: string,
    path: string,
    maxBytes: number,
    correlation?: string,
  ): Promise<Buffer>;
  submit(requestId: string, sandbox: string): Promise<Job>;
  job(jobId: string, correlation: string): Promise<Job>;
  events(
    jobId: string,
    cursor: string | null,
    correlation: string,
  ): Promise<{ events: RunnerEvent[]; next_cursor: string | null }>;
  stop(sandbox: string, correlation: string): Promise<void>;
}
export class RemoteError extends Error {
  constructor(
    public code: string,
    public retryable: boolean,
    public status: number,
  ) {
    super(code);
  }
}
export class HttpExecutionServices implements ExecutionServices {
  constructor(private config: Config) {}
  private async call(
    service: "runner" | "provider",
    path: string,
    method: string,
    correlation: string,
    body?: unknown,
    key?: string,
  ): Promise<unknown> {
    const base =
      service === "runner" ? this.config.runnerUrl : this.config.providerUrl;
    const token =
      service === "runner"
        ? this.config.runnerToken
        : this.config.providerToken;
    const response = await fetch(new URL(path, base), {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(120000),
      headers: {
        authorization: `Bearer ${token}`,
        "x-correlation-id": correlation,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(key ? { "idempotency-key": key } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.body)
      throw new RemoteError("invalid_remote_response", true, 502);
    const reader = response.body.getReader();
    const pieces: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.length;
      if (bytes > 3 * 1024 * 1024) {
        await reader.cancel();
        throw new RemoteError("remote_response_limit", false, 502);
      }
      pieces.push(next.value);
    }
    const raw = Buffer.concat(pieces).toString("utf8");
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new RemoteError("invalid_remote_response", true, 502);
    }
    if (!response.ok) {
      const error = z
        .object({ code: z.string(), retryable: z.boolean() })
        .safeParse(value);
      throw new RemoteError(
        error.success ? error.data.code : "dependency_unavailable",
        error.success ? error.data.retryable : response.status >= 500,
        response.status,
      );
    }
    return value;
  }
  async createSandbox(requestId: string) {
    const value = await this.call(
      "provider",
      "/v1/sandboxes",
      "POST",
      requestId,
      {
        owner_ref: `application:${requestId}`,
        profile: this.config.sandboxProfile,
        persistent: true,
      },
      `create:${requestId}`,
    );
    return z.object({ sandbox_id: z.string() }).parse(value).sandbox_id;
  }
  async createWorkspaceSandbox(workspaceId: string) {
    const value = await this.call(
      "provider",
      "/v1/sandboxes",
      "POST",
      workspaceId,
      {
        owner_ref: `application:user-workspace:${workspaceId}`,
        profile: this.config.sandboxProfile,
        persistent: true,
      },
      `workspace:create:${workspaceId}`,
    );
    return z.object({ sandbox_id: z.string() }).parse(value).sandbox_id;
  }
  async inspect(sandbox: string, correlation: string) {
    return z
      .object({
        status: z.enum([
          "creating",
          "running",
          "stopping",
          "stopped",
          "failed",
          "destroying",
          "destroyed",
        ]),
      })
      .parse(
        await this.call(
          "provider",
          `/v1/sandboxes/${encodeURIComponent(sandbox)}`,
          "GET",
          correlation,
        ),
      );
  }
  async start(sandbox: string, correlation: string) {
    await this.call(
      "provider",
      `/v1/sandboxes/${encodeURIComponent(sandbox)}/start`,
      "POST",
      correlation,
      {},
    );
  }
  async prepare(workspaceId: string, sandbox: string) {
    return jobSchema.parse(
      await this.call(
        "runner",
        "/v1/jobs",
        "POST",
        workspaceId,
        {
          client_reference: `application:workspace:${workspaceId}`,
          workload: {
            profile: this.config.prepareWorkloadProfile,
            arguments: {},
          },
          sandbox: { mode: "reuse", sandbox_id: sandbox },
          limits: {
            max_duration_seconds: Math.min(180, this.config.maxDurationSeconds),
            max_attempts: 1,
          },
        },
        `workspace:prepare:${workspaceId}`,
      ),
    );
  }
  async upload(
    sandbox: string,
    path: string,
    data: Buffer,
    key: string,
    correlation = key,
    progress?: (uploaded: number, total: number) => Promise<void>,
  ) {
    const prefix = `/v1/sandboxes/${encodeURIComponent(sandbox)}/files/uploads`;
    const upload = z
      .object({
        upload_id: z.string(),
        offset: z.number().int().min(0),
        status: z.enum(["uploading", "completed"]),
      })
      .parse(
        await this.call(
          "provider",
          prefix,
          "POST",
          correlation,
          { path, size_bytes: data.length, sha256: digest(data) },
          key,
        ),
      );
    await progress?.(upload.offset, data.length);
    if (upload.status === "completed") return;
    let offset = upload.offset;
    if (offset > data.length)
      throw new RemoteError("upload_offset_mismatch", false, 502);
    while (offset < data.length) {
      const chunk = data.subarray(
        offset,
        Math.min(offset + 1024 * 1024, data.length),
      );
      const next = z.object({ offset: z.number().int().min(0) }).parse(
        await this.call(
          "provider",
          `${prefix}/${encodeURIComponent(upload.upload_id)}`,
          "PATCH",
          correlation,
          {
            offset,
            data_base64: chunk.toString("base64"),
            sha256: digest(chunk),
          },
        ),
      );
      if (next.offset !== offset + chunk.length)
        throw new RemoteError("upload_offset_mismatch", false, 502);
      offset = next.offset;
      await progress?.(offset, data.length);
    }
    await this.call(
      "provider",
      `${prefix}/${encodeURIComponent(upload.upload_id)}/complete`,
      "POST",
      correlation,
      {},
    );
  }
  async download(
    sandbox: string,
    path: string,
    maxBytes: number,
    correlation = sandbox,
  ) {
    const chunks: Buffer[] = [];
    let offset = 0;
    let expectedHash: string | undefined;
    let expectedSize: number | undefined;
    while (true) {
      const value = z
        .object({
          path: z.string(),
          offset: z.number().int(),
          data_base64: z.string().max(1400000),
          size_bytes: z.number().int().min(0),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          eof: z.boolean(),
        })
        .parse(
          await this.call(
            "provider",
            `/v1/sandboxes/${encodeURIComponent(sandbox)}/files/read`,
            "POST",
            correlation,
            { path, offset, max_bytes: 1024 * 1024 },
          ),
        );
      if (
        value.path !== path ||
        value.offset !== offset ||
        value.size_bytes > maxBytes ||
        (expectedHash !== undefined && expectedHash !== value.sha256) ||
        (expectedSize !== undefined && expectedSize !== value.size_bytes)
      )
        throw new RemoteError("download_integrity", false, 502);
      expectedHash = value.sha256;
      expectedSize = value.size_bytes;
      const chunk = Buffer.from(value.data_base64, "base64");
      if (
        chunk.toString("base64") !== value.data_base64 ||
        offset + chunk.length > maxBytes ||
        (!value.eof && chunk.length === 0)
      )
        throw new RemoteError("download_integrity", false, 502);
      chunks.push(chunk);
      offset += chunk.length;
      if (value.eof) {
        const data = Buffer.concat(chunks);
        if (data.length !== value.size_bytes || digest(data) !== value.sha256)
          throw new RemoteError("download_integrity", false, 502);
        return data;
      }
    }
  }
  async submit(requestId: string, sandbox: string) {
    return jobSchema.parse(
      await this.call(
        "runner",
        "/v1/jobs",
        "POST",
        requestId,
        {
          client_reference: `application:${requestId}`,
          workload: {
            profile: this.config.workloadProfile,
            arguments: { request_id: requestId },
          },
          sandbox: { mode: "reuse", sandbox_id: sandbox },
          limits: {
            max_duration_seconds: this.config.maxDurationSeconds,
            max_attempts: 1,
          },
        },
        `submit:${requestId}`,
      ),
    );
  }
  async job(jobId: string, correlation: string) {
    return jobSchema.parse(
      await this.call(
        "runner",
        `/v1/jobs/${encodeURIComponent(jobId)}`,
        "GET",
        correlation,
      ),
    );
  }
  async events(jobId: string, cursor: string | null, correlation: string) {
    const page = z.object({
      events: z
        .array(z.object({ event_id: z.string(), type: z.string() }))
        .max(100),
      next_cursor: z.string().nullable(),
    });
    return page.parse(
      await this.call(
        "runner",
        `/v1/jobs/${encodeURIComponent(jobId)}/events?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        "GET",
        correlation,
      ),
    );
  }
  async stop(sandbox: string, correlation: string) {
    await this.call(
      "provider",
      `/v1/sandboxes/${encodeURIComponent(sandbox)}/stop`,
      "POST",
      correlation,
      {},
    );
  }
}
