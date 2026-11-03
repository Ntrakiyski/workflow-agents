import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { readFile } from "node:fs/promises";
import { Ajv2020 } from "ajv/dist/2020.js";
import { z } from "zod";
import { HttpExecutionServices, RemoteError } from "../src/remote.js";
import { configSchema } from "../src/config.js";
import { digest, uuid } from "../src/model.js";

test("HTTP adapters preserve published Runner payload/auth and checksummed bounded transfer protocol", async () => {
  const fixture = Fastify({ bodyLimit: 2 * 1024 * 1024 });
  const correlation = uuid();
  let offset = 0,
    uploadCalls = 0,
    completed = false;
  const content = Buffer.alloc(1024 * 1024 + 57, 65);
  const chunks: Buffer[] = [];
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  const contract = JSON.parse(
    await readFile(
      new URL("../../../contracts/v1/runner-v1.openapi.json", import.meta.url),
      "utf8",
    ),
  );
  ajv.addSchema(contract, "runner");
  const submission = ajv.compile({
    $ref: "runner#/components/schemas/JobSubmission",
  });
  const job = {
    job_id: "job_fixture",
    status: "running",
    sandbox_id: "sbx_fixture",
    result: null,
    error: null,
    correlation_id: correlation,
    run_id: "run_fixture",
    attempt_count: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  fixture.addHook("onRequest", async (req, reply) => {
    assert.equal(req.headers["x-correlation-id"], correlation);
    const isRunner = req.url.startsWith("/v1/jobs");
    assert.equal(
      req.headers.authorization,
      isRunner ? "Bearer runner-secret" : "Bearer provider-secret",
    );
    if (req.url.includes("missing"))
      return reply.code(404).send({ code: "not_found", retryable: false });
  });
  fixture.post("/v1/sandboxes", async (req) => {
    assert.ok(req.headers["idempotency-key"]);
    assert.deepEqual(req.body, {
      owner_ref: `application:${correlation}`,
      profile: "fixture:v1",
      persistent: true,
    });
    return { sandbox_id: "sbx_fixture" };
  });
  fixture.post("/v1/sandboxes/sbx_fixture/files/uploads", async (req) => {
    uploadCalls++;
    assert.deepEqual(req.body, {
      path: "runtime/bundle.tar.gz",
      size_bytes: content.length,
      sha256: digest(content),
    });
    return {
      upload_id: "upload_fixture",
      offset,
      status: completed ? "completed" : "uploading",
    };
  });
  fixture.patch(
    "/v1/sandboxes/sbx_fixture/files/uploads/upload_fixture",
    async (req) => {
      const body = z
        .object({
          offset: z.number(),
          data_base64: z.string(),
          sha256: z.string(),
        })
        .strict()
        .parse(req.body);
      assert.equal(body.offset, offset);
      const data = Buffer.from(body.data_base64, "base64");
      assert.ok(data.length <= 1024 * 1024);
      assert.equal(digest(data), body.sha256);
      chunks.push(data);
      offset += data.length;
      return { offset };
    },
  );
  fixture.post(
    "/v1/sandboxes/sbx_fixture/files/uploads/upload_fixture/complete",
    async () => {
      assert.equal(digest(Buffer.concat(chunks)), digest(content));
      completed = true;
      return { status: "completed", offset };
    },
  );
  fixture.post("/v1/sandboxes/sbx_fixture/files/read", async (req) => {
    const body = z
      .object({ path: z.string(), offset: z.number(), max_bytes: z.number() })
      .strict()
      .parse(req.body);
    const part = content.subarray(body.offset, body.offset + body.max_bytes);
    return {
      path: body.path,
      offset: body.offset,
      data_base64: part.toString("base64"),
      size_bytes: content.length,
      sha256: digest(content),
      eof: body.offset + part.length === content.length,
    };
  });
  fixture.post("/v1/jobs", async (req) => {
    assert.equal(req.headers["idempotency-key"], `submit:${correlation}`);
    assert.ok(submission(req.body), JSON.stringify(submission.errors));
    return job;
  });
  fixture.get("/v1/jobs/job_fixture", async () => job);
  fixture.get("/v1/jobs/job_fixture/events", async () => ({
    events: [{ event_id: "event_1", type: "job.submitted" }],
    next_cursor: null,
  }));
  fixture.post("/v1/sandboxes/sbx_fixture/stop", async () => ({
    status: "stopped",
  }));
  await fixture.listen({ port: 0, host: "127.0.0.1" });
  const address = fixture.server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const raw = JSON.parse(await readFile("private/test/config.json", "utf8"));
  const config = configSchema.parse({
    ...raw,
    users: [
      { username: "alice", owner_id: "alice", password_sha256: digest("test") },
    ],
    runtimeBundleSha256: digest("test"),
    runnerUrl: url,
    providerUrl: url,
    runnerToken: "runner-secret",
    providerToken: "provider-secret",
  });
  const client = new HttpExecutionServices(config);
  try {
    assert.equal(await client.createSandbox(correlation), "sbx_fixture");
    await client.upload(
      "sbx_fixture",
      "runtime/bundle.tar.gz",
      content,
      "upload-key",
      correlation,
    );
    await client.upload(
      "sbx_fixture",
      "runtime/bundle.tar.gz",
      content,
      "upload-key",
      correlation,
    );
    assert.equal(uploadCalls, 2);
    assert.equal(offset, content.length);
    assert.equal(
      digest(
        await client.download(
          "sbx_fixture",
          "runtime/bundle.tar.gz",
          content.length,
          correlation,
        ),
      ),
      digest(content),
    );
    const submitted = await client.submit(correlation, "sbx_fixture");
    assert.equal(submitted.job_id, "job_fixture");
    assert.equal(
      (await client.job("job_fixture", correlation)).status,
      "running",
    );
    assert.equal(
      (await client.events("job_fixture", null, correlation)).events[0]
        ?.event_id,
      "event_1",
    );
    await client.stop("sbx_fixture", correlation);
    await assert.rejects(
      () => client.job("missing", correlation),
      (e) => e instanceof RemoteError && e.code === "not_found" && !e.retryable,
    );
  } finally {
    await fixture.close();
  }
});
