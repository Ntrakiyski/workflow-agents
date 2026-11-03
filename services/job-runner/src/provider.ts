import type { Config } from "./config.js";
import type { Sandbox, Run, JobRow } from "./types.js";
import { ApiError, unavailable } from "./errors.js";
import { validate } from "./validation.js";
export class ProviderClient {
  constructor(private config: Config) {}
  async request<T>(
    owner: string,
    correlation: string,
    method: string,
    path: string,
    body?: unknown,
    key?: string,
    schema?: string,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.providerTimeoutMs,
    );
    try {
      const headers: Record<string, string> = {
        Authorization: "Bearer " + this.config.providerToken,
        "X-Owner-ID": owner,
        "X-Correlation-ID": correlation,
      };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      if (key) headers["Idempotency-Key"] = key;
      const response = await fetch(this.config.providerUrl + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        redirect: "error",
      });
      const reader = response.body?.getReader();
      const parts: Uint8Array[] = [];
      let size = 0;
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 262144) {
            await reader.cancel();
            throw unavailable();
          }
          parts.push(value);
        }
      }
      let result: unknown;
      try {
        result = JSON.parse(Buffer.concat(parts).toString("utf8"));
      } catch {
        throw unavailable();
      }
      if (!response.ok) {
        const e = result as Record<string, unknown>;
        let code = "dependency_unavailable";
        if (typeof e.code === "string" && /^[a-z_]{1,64}$/.test(e.code))
          code = e.code;
        throw new ApiError(
          response.status,
          code,
          "Sandbox Provider could not complete the operation",
          e.retryable === true ||
            response.status >= 500 ||
            response.status === 429,
        );
      }
      if (schema) {
        try {
          validate("provider", schema, result);
        } catch {
          throw unavailable();
        }
      }
      return result as T;
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw unavailable();
    } finally {
      clearTimeout(timeout);
    }
  }
  create(job: JobRow, key: string) {
    return this.request<Sandbox>(
      job.owner_id,
      job.correlation_id,
      "POST",
      "/v1/sandboxes",
      {
        owner_ref: job.payload.sandbox.owner_ref,
        profile: job.payload.sandbox.profile,
        persistent: true,
      },
      key,
      "Sandbox",
    );
  }
  sandbox(owner: string, correlation: string, id: string) {
    return this.request<Sandbox>(
      owner,
      correlation,
      "GET",
      `/v1/sandboxes/${encodeURIComponent(id)}`,
      undefined,
      undefined,
      "Sandbox",
    );
  }
  start(job: JobRow) {
    return this.request<Sandbox>(
      job.owner_id,
      job.correlation_id,
      "POST",
      `/v1/sandboxes/${job.sandbox_id}/start`,
      {},
      undefined,
      "Sandbox",
    );
  }
  execute(job: JobRow, executionRef: string, key: string, seconds: number) {
    return this.request<Run>(
      job.owner_id,
      job.correlation_id,
      "POST",
      `/v1/sandboxes/${job.sandbox_id}/execute`,
      {
        execution_ref: executionRef,
        profile: job.payload.workload.profile,
        arguments: job.payload.workload.arguments,
        timeout_seconds: seconds,
      },
      key,
      "Run",
    );
  }
  run(job: JobRow) {
    return this.request<Run>(
      job.owner_id,
      job.correlation_id,
      "GET",
      `/v1/sandboxes/${job.sandbox_id}/runs/${job.run_id}`,
      undefined,
      undefined,
      "Run",
    );
  }
  fence(job: JobRow, executionRef: string) {
    return this.request<{
      execution_ref: string;
      run_id: string | null;
      status: string;
    }>(
      job.owner_id,
      job.correlation_id,
      "POST",
      `/v1/sandboxes/${job.sandbox_id}/runs/cancel-by-reference`,
      { execution_ref: executionRef, reason: "Runner cancellation intent" },
      undefined,
      "CancellationFence",
    );
  }
  cancel(job: JobRow) {
    return this.request<Run>(
      job.owner_id,
      job.correlation_id,
      "POST",
      `/v1/sandboxes/${job.sandbox_id}/runs/${job.run_id}/cancel`,
      { reason: "Runner cancellation intent" },
      undefined,
      "Run",
    );
  }
  stop(owner: string, correlation: string, id: string) {
    return this.request<Sandbox>(
      owner,
      correlation,
      "POST",
      `/v1/sandboxes/${id}/stop`,
      {},
      undefined,
      "Sandbox",
    );
  }
}
