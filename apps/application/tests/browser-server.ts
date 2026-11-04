import { readFile } from "node:fs/promises";
import { CreateBucketCommand } from "@aws-sdk/client-s3";
import { configSchema } from "../src/config.js";
import { Database } from "../src/database.js";
import { S3Objects } from "../src/storage.js";
import { createApi } from "../src/api.js";
import { RequestWorker } from "../src/worker.js";
import { digest } from "../src/model.js";
import type { ExecutionServices, Job } from "../src/remote.js";

const raw = JSON.parse(
  await readFile(
    process.env.APPLICATION_TEST_CONFIG ?? "private/test/config.json",
    "utf8",
  ),
);
const config = configSchema.parse({
  ...raw,
  users: raw.users.map((u: { username: string; owner_id: string }) => ({
    ...u,
    password_sha256: digest("application-integration-password"),
  })),
  runtimeBundleSha256: digest("test runtime"),
  workerIntervalMs: 150,
});
if (new URL(config.databaseUrl).pathname !== "/workflow_app_test")
  throw new Error("Dedicated application test database required");
const db = new Database(config.databaseUrl);
const objects = new S3Objects(config);
await db.migrate();
await db.pool.query(
  "UPDATE application.user_workspaces SET sandbox_id=NULL,prepare_job_id=NULL,status='pending',uploaded_bytes=0,total_bytes=0,next_attempt_at=now() WHERE owner_id IN ('alice','bob')",
);
await db.pool.query(
  "UPDATE application.requests SET next_attempt_at=now()+interval '1 day'",
);
try {
  await objects.client.send(
    new CreateBucketCommand({ Bucket: config.s3Bucket }),
  );
} catch (e) {
  if (
    !(e instanceof Error) ||
    !["BucketAlreadyOwnedByYou", "BucketAlreadyExists"].includes(e.name)
  )
    throw e;
}
await objects.put(
  config.runtimeBundleKey,
  Buffer.from("test runtime"),
  "application/gzip",
  config.runtimeBundleSha256,
);
class BrowserFixture implements ExecutionServices {
  files = new Map<string, Buffer>();
  jobs = new Map<string, Job>();
  requests = new Map<string, string>();
  async createSandbox(id: string) {
    return "sbx_" + id.replaceAll("-", "");
  }
  async createWorkspaceSandbox(id: string) {
    return this.createSandbox(id);
  }
  async start() {}
  async inspect() {
    return { status: "running" };
  }
  async prepare(id: string, sandbox: string) {
    const job: Job = {
      job_id: `job_prepare_${id}`,
      status: "completed",
      sandbox_id: sandbox,
      result: {
        exit_code: 0,
        stdout: JSON.stringify({
          schema_version: 1,
          prepared: true,
          runtime_sha256: config.runtimeBundleSha256,
        }),
        stderr: "",
        output_truncated: false,
        artifacts: [],
      },
      error: null,
    };
    this.jobs.set(job.job_id, job);
    return job;
  }
  async upload(sandbox: string, path: string, data: Buffer) {
    this.files.set(sandbox + "/" + path, data);
  }
  async download(sandbox: string, path: string) {
    const value = this.files.get(sandbox + "/" + path);
    if (!value) throw new Error("Fixture output missing");
    return value;
  }
  async submit(requestId: string, sandbox: string) {
    const jobId = "job_" + requestId.replaceAll("-", "");
    this.requests.set(jobId, requestId);
    const artifact = Buffer.from("Browser verified downloadable result.");
    const session = Buffer.from('{"type":"session"}\n');
    const result = {
      schema_version: 1,
      request_id: requestId,
      outcome: "completed",
      text: "Your result is ready.",
      artifacts: [
        {
          path: "result.txt",
          media_type: "text/plain",
          size_bytes: artifact.length,
          sha256: digest(artifact),
        },
      ],
      validations: [
        {
          category: "structural",
          status: "passed",
          code: "text_fixture",
          message: "Fixture result checked.",
        },
        {
          category: "content",
          status: "not_performed",
          code: "fixture",
          message: "Model not called in browser fixture.",
        },
        {
          category: "rendered_layout",
          status: "not_performed",
          code: "text_only",
          message: "Not rendered.",
        },
      ],
      session_files: [
        {
          path: "session.jsonl",
          media_type: "application/x-ndjson",
          sha256: digest(session),
          size_bytes: session.length,
        },
      ],
    };
    this.files.set(
      sandbox + `/requests/${requestId}/outputs/result.json`,
      Buffer.from(JSON.stringify(result)),
    );
    this.files.set(
      sandbox + `/requests/${requestId}/outputs/result.txt`,
      artifact,
    );
    this.files.set(
      sandbox + `/requests/${requestId}/session/session.jsonl`,
      session,
    );
    const job: Job = {
      job_id: jobId,
      status: "completed",
      sandbox_id: sandbox,
      result: {
        exit_code: 0,
        stdout: "",
        stderr: "",
        output_truncated: false,
        artifacts: [],
      },
      error: null,
    };
    this.jobs.set(jobId, job);
    return job;
  }
  async job(id: string) {
    const job = this.jobs.get(id);
    if (!job) throw new Error("Unknown fixture job");
    return job;
  }
  async events(id: string) {
    return {
      events: [{ event_id: id + ":complete", type: "job.completed" }],
      next_cursor: null,
    };
  }
  async stop() {}
}
const api = createApi(db, objects, config);
await api.listen({ port: config.port, host: "127.0.0.1" });
const worker = new RequestWorker(
  db,
  objects,
  new BrowserFixture(),
  config,
  api.log,
);
worker.start();
async function close() {
  await worker.close();
  await api.close();
  await db.pool.end();
  objects.close();
  process.exit(0);
}
process.on("SIGTERM", () => void close());
process.on("SIGINT", () => void close());
