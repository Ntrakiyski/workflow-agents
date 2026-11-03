import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { CreateBucketCommand } from "@aws-sdk/client-s3";
import { configSchema, type Config } from "../src/config.js";
import { Database } from "../src/database.js";
import { S3Objects } from "../src/storage.js";
import { createApi } from "../src/api.js";
import { RequestWorker } from "../src/worker.js";
import { digest, manifest, uuid, AppError } from "../src/model.js";
import {
  RemoteError,
  type ExecutionServices,
  type Job,
} from "../src/remote.js";
import { inspectDocx, validateDelivery } from "../src/validate.js";
import { ZipFile } from "yazl";

const password = "application-integration-password";
let config: Config,
  db: Database,
  objects: S3Objects,
  api: ReturnType<typeof createApi>;
function authorization(name = "alice") {
  return `Basic ${Buffer.from(`${name}:${password}`).toString("base64")}`;
}
function headers(name = "alice") {
  return { authorization: authorization(name), origin: config.publicOrigin };
}
before(async () => {
  const raw = JSON.parse(
    await readFile(
      process.env.APPLICATION_TEST_CONFIG ?? "private/test/config.json",
      "utf8",
    ),
  );
  config = configSchema.parse({
    ...raw,
    users: raw.users.map((u: { username: string; owner_id: string }) => ({
      ...u,
      password_sha256: digest(password),
    })),
    runtimeBundleSha256: digest("test runtime"),
  });
  const target = new URL(config.databaseUrl);
  assert.equal(target.pathname, "/workflow_app_test");
  assert.ok(
    ["127.0.0.1", "localhost"].includes(target.hostname),
    "Only dedicated local application test DB",
  );
  db = new Database(config.databaseUrl);
  await db.pool.query("DROP SCHEMA IF EXISTS application CASCADE");
  await db.migrate();
  objects = new S3Objects(config);
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
  api = createApi(db, objects, config);
  await api.ready();
});
after(async () => {
  await api?.close();
  await db?.pool.end();
  objects?.close();
});
async function submit(
  instructions: string,
  key = uuid(),
  name = "alice",
  attachmentIds: string[] = [],
) {
  return api.inject({
    method: "POST",
    url: "/api/requests",
    headers: { ...headers(name), "idempotency-key": key },
    payload: { instructions, attachment_ids: attachmentIds },
  });
}
class FakeExecution implements ExecutionServices {
  files = new Map<string, Buffer>();
  jobs = new Map<string, Job>();
  creations = new Map<string, string>();
  submissions = new Map<string, string>();
  submitCalls = 0;
  stopCalls = 0;
  loseResponse = false;
  failStop = false;
  async createSandbox(requestId: string) {
    const prior = this.creations.get(requestId);
    if (prior) return prior;
    const sandbox = "sbx_" + requestId.replaceAll("-", "");
    this.creations.set(requestId, sandbox);
    return sandbox;
  }
  async upload(sandbox: string, path: string, data: Buffer) {
    const key = sandbox + "/" + path;
    const previous = this.files.get(key);
    if (previous) assert.equal(digest(previous), digest(data));
    else this.files.set(key, data);
  }
  async download(sandbox: string, path: string) {
    const file = this.files.get(sandbox + "/" + path);
    if (!file) throw new RemoteError("not_found", false, 404);
    return file;
  }
  async submit(requestId: string, sandbox: string) {
    let jobId = this.submissions.get(requestId);
    if (!jobId) {
      this.submitCalls++;
      jobId = "job_" + requestId.replaceAll("-", "");
      this.submissions.set(requestId, jobId);
      this.jobs.set(jobId, {
        job_id: jobId,
        status: "running",
        sandbox_id: sandbox,
        result: null,
        error: null,
      });
    }
    if (this.loseResponse) {
      this.loseResponse = false;
      throw new Error("simulated transport lost after side effect");
    }
    const job = this.jobs.get(jobId);
    assert.ok(job);
    return job;
  }
  async job(jobId: string) {
    const job = this.jobs.get(jobId);
    assert.ok(job);
    return job;
  }
  async events(jobId: string) {
    return {
      events: [{ event_id: jobId + ":submitted", type: "job.submitted" }],
      next_cursor: null,
    };
  }
  async stop() {
    if (this.failStop) throw new RemoteError("sandbox_busy", false, 409);
    this.stopCalls++;
  }
  complete(requestId: string, { missing = false, badHash = false } = {}) {
    const jobId = this.submissions.get(requestId),
      sandbox = this.creations.get(requestId);
    assert.ok(jobId && sandbox);
    const output = Buffer.from("Verified result file.");
    const session = Buffer.from('{"type":"session"}\n');
    const result = {
      schema_version: 1,
      request_id: requestId,
      outcome: "completed",
      text: "Your request is complete.",
      artifacts: [
        {
          path: "result.txt",
          media_type: "text/plain",
          size_bytes: output.length,
          sha256: badHash ? "0".repeat(64) : digest(output),
        },
      ],
      validations: [
        {
          category: "structural",
          status: "passed",
          code: "text_utf8",
          message: "UTF-8 structure verified.",
        },
        {
          category: "content",
          status: "not_performed",
          code: "independent_content_review",
          message: "Content accuracy has not been independently reviewed.",
        },
        {
          category: "rendered_layout",
          status: "not_performed",
          code: "not_applicable",
          message: "No layout renderer executed.",
        },
      ],
      session_files: [
        {
          path: "session.jsonl",
          sha256: digest(session),
          size_bytes: session.length,
        },
      ],
    };
    if (!missing) {
      this.files.set(
        sandbox + `/requests/${requestId}/outputs/result.json`,
        Buffer.from(JSON.stringify(result)),
      );
      this.files.set(
        sandbox + `/requests/${requestId}/outputs/result.txt`,
        output,
      );
      this.files.set(
        sandbox + `/requests/${requestId}/session/session.jsonl`,
        session,
      );
    }
    this.jobs.set(jobId, {
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
    });
  }
}
function worker(remote: ExecutionServices) {
  return new RequestWorker(db, objects, remote, config, api.log);
}

test("authentication, origin checks, owner scoped idempotency, and pagination retain all requests", async () => {
  assert.equal((await api.inject({ url: "/api/requests" })).statusCode, 401);
  assert.equal(
    (
      await api.inject({
        method: "POST",
        url: "/api/requests",
        headers: { authorization: authorization(), "idempotency-key": uuid() },
        payload: { instructions: "Missing origin" },
      })
    ).statusCode,
    403,
  );
  const key = uuid();
  const first = await submit("A persistent request", key);
  assert.equal(first.statusCode, 201);
  const id = first.json().id;
  assert.equal((await submit("A persistent request", key)).json().id, id);
  assert.equal((await submit("Changed request", key)).statusCode, 409);
  assert.equal(
    (await api.inject({ url: `/api/requests/${id}`, headers: headers("bob") }))
      .statusCode,
    404,
  );
  for (let i = 0; i < 4; i++)
    assert.equal((await submit(`Page request ${i}`)).statusCode, 201);
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const response = await api.inject({
      url: "/api/requests?limit=2" + (cursor ? "&cursor=" + cursor : ""),
      headers: headers(),
    });
    assert.equal(response.statusCode, 200);
    const page = response.json();
    for (const r of page.requests) seen.add(r.id);
    cursor = page.next_cursor;
  } while (cursor);
  assert.ok(seen.size >= 5);
  assert.equal(
    (
      await api.inject({
        url: "/api/requests?cursor=malformed",
        headers: headers(),
      })
    ).statusCode,
    400,
  );
});
test("pagination preserves every same-millisecond request and timestamp tie", async () => {
  const owner = "cursor-fixture";
  const entries = ["123900", "123800", "123800", "123700"].map((fraction) => ({
    id: uuid(),
    at: `2026-01-02T03:04:05.${fraction}Z`,
  }));
  for (const entry of [
    ...entries,
    { id: uuid(), at: "2026-01-02T03:04:05.123850Z", foreign: true },
  ]) {
    await db.pool.query(
      `INSERT INTO application.requests
      (id,owner_id,title,instructions,status,submission_key,fingerprint,correlation_id,created_at)
      VALUES ($1::uuid,$2,'Cursor fixture','Synthetic pagination fixture','failed',$1::text,$3,$1::text,$4::timestamptz)`,
      [
        entry.id,
        "foreign" in entry ? "cursor-foreign" : owner,
        digest(entry.id),
        entry.at,
      ],
    );
  }
  const pager = createApi(db, objects, {
    ...config,
    users: [
      ...config.users,
      { username: "pager", owner_id: owner, password_sha256: digest(password) },
    ],
  });
  try {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let pageNumber = 0; pageNumber < 6; pageNumber++) {
      const response = await pager.inject({
        url: "/api/requests?limit=1" + (cursor ? "&cursor=" + cursor : ""),
        headers: headers("pager"),
      });
      assert.equal(response.statusCode, 200);
      const page = response.json();
      seen.push(...page.requests.map((row: { id: string }) => row.id));
      cursor = page.next_cursor;
      if (!cursor) break;
    }
    const expected = [...entries]
      .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id))
      .map((entry) => entry.id);
    assert.deepEqual(seen, expected);
    assert.equal(new Set(seen).size, entries.length);
    assert.equal(cursor, null);
  } finally {
    await pager.close();
  }
});
test("immutable real S3 writes reject changed content and tolerate exact replay", async () => {
  const key = "test/immutable/" + uuid();
  await objects.put(
    key,
    Buffer.from("original"),
    "text/plain",
    digest("original"),
  );
  await objects.put(
    key,
    Buffer.from("original"),
    "text/plain",
    digest("original"),
  );
  await assert.rejects(() =>
    objects.put(key, Buffer.from("changed"), "text/plain", digest("changed")),
  );
  assert.equal((await objects.get(key, 100)).toString(), "original");
});
test("input ownership, original protection, byte limits, and authorized downloads", async () => {
  const boundary = "application-test-boundary";
  const payload = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="notes.txt"\r\nContent-Type: text/plain\r\n\r\nOriginal evidence\r\n--${boundary}--\r\n`,
  );
  const uploaded = await api.inject({
    method: "POST",
    url: "/api/attachments",
    headers: {
      ...headers(),
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
    payload,
  });
  assert.equal(uploaded.statusCode, 201, uploaded.body);
  const fileId = uploaded.json().id;
  assert.equal(
    (await submit("Steal input", uuid(), "bob", [fileId])).statusCode,
    404,
  );
  const admitted = await submit("Use my original input", uuid(), "alice", [
    fileId,
  ]);
  assert.equal(admitted.statusCode, 201);
  assert.equal(
    (await submit("Reuse attached original", uuid(), "alice", [fileId]))
      .statusCode,
    404,
  );
  assert.equal(
    (
      await api.inject({
        url: `/api/files/${fileId}/download`,
        headers: headers("bob"),
      })
    ).statusCode,
    404,
  );
  const download = await api.inject({
    url: `/api/files/${fileId}/download`,
    headers: headers(),
  });
  assert.equal(download.statusCode, 200);
  assert.equal(download.body, "Original evidence");
  assert.match(download.headers["content-disposition"] ?? "", /attachment/);
});
test("durable dispatch reconciles lost submit response without a second execution, exports before stop, persists across restart", async () => {
  const created = await submit("Create a verified text result");
  const requestId = created.json().id;
  const fake = new FakeExecution();
  fake.loseResponse = true;
  const firstWorker = worker(fake);
  await db.pool.query(
    "UPDATE application.requests SET next_attempt_at=now()+interval '1 day' WHERE id<>$1",
    [requestId],
  );
  await firstWorker.tick();
  assert.equal(fake.submitCalls, 1);
  await db.pool.query(
    "UPDATE application.requests SET next_attempt_at=now() WHERE id=$1",
    [requestId],
  );
  const restartedWorker = worker(fake);
  await restartedWorker.tick();
  assert.equal(fake.submitCalls, 1);
  fake.complete(requestId);
  await restartedWorker.tick();
  const state = await db.ownedRequest("alice", requestId);
  assert.equal(state?.status, "completed");
  assert.equal(state?.sandbox_stopped, false);
  assert.equal(fake.stopCalls, 0, "No stop before durable export");
  const files = await db.files(requestId);
  assert.ok(
    files.some((f) => f.kind === "checkpoint" && f.name === "session.jsonl"),
  );
  assert.ok(files.some((f) => f.kind === "output"));
  fake.failStop = true;
  await restartedWorker.tick();
  assert.equal(
    (await db.ownedRequest("alice", requestId))?.status,
    "completed",
    "A stop failure cannot revoke an exported result",
  );
  assert.equal(
    (await db.ownedRequest("alice", requestId))?.sandbox_stopped,
    false,
  );
  fake.failStop = false;
  await db.pool.query(
    "UPDATE application.requests SET next_attempt_at=now() WHERE id=$1",
    [requestId],
  );
  await restartedWorker.tick();
  assert.ok(fake.stopCalls >= 1);
  assert.equal(
    (await db.ownedRequest("alice", requestId))?.sandbox_stopped,
    true,
  );
  const output = files.find((f) => f.kind === "output");
  assert.ok(output);
  assert.equal(
    (
      await api.inject({
        url: `/api/files/${output.id}/download`,
        headers: headers("bob"),
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await api.inject({
        url: `/api/files/${output.id}/download`,
        headers: headers(),
      })
    ).body,
    "Verified result file.",
  );
  const newApi = createApi(db, objects, config);
  await newApi.ready();
  const afterRestart = await newApi.inject({
    url: `/api/requests/${requestId}`,
    headers: headers(),
  });
  assert.equal(afterRestart.json().status, "completed");
  assert.equal(afterRestart.json().final_text, "Your request is complete.");
  await newApi.close();
  const events = await db.pool.query(
    "SELECT count(*)::int AS count FROM application.runner_events WHERE request_id=$1",
    [requestId],
  );
  assert.equal(events.rows[0].count, 1);
  const audits = await db.pool.query(
    "SELECT action FROM application.audit WHERE request_id=$1 ORDER BY event_id",
    [requestId],
  );
  assert.ok(audits.rows.some((r) => r.action === "request.completed"));
  assert.ok(audits.rows.some((r) => r.action === "sandbox.stopped"));
  await assert.rejects(() =>
    db.pool.query("DELETE FROM application.audit WHERE request_id=$1", [
      requestId,
    ]),
  );
});
test("zero exit with absent manifest and checksum mismatch cannot deliver success", async () => {
  for (const options of [{ missing: true }, { badHash: true }]) {
    const created = await submit(
      "Safety validation " + JSON.stringify(options),
    );
    const requestId = created.json().id;
    const fake = new FakeExecution();
    const runner = worker(fake);
    await db.pool.query(
      "UPDATE application.requests SET next_attempt_at=now()+interval '1 day' WHERE id<>$1",
      [requestId],
    );
    await runner.tick();
    fake.complete(requestId, options);
    await runner.tick();
    const state = await db.ownedRequest("alice", requestId);
    assert.equal(state?.status, "failed");
    assert.equal(state?.export_complete, false);
    const view = await api.inject({
      url: `/api/requests/${requestId}`,
      headers: headers(),
    });
    assert.equal(view.json().final_text, null);
    assert.equal(
      view.json().files.filter((f: { kind: string }) => f.kind === "output")
        .length,
      0,
    );
  }
});
test("DOCX controller validates actual ZIP/XML and refuses malformed structures", async () => {
  const zip = new ZipFile();
  zip.addBuffer(
    Buffer.from(
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
    "[Content_Types].xml",
  );
  zip.addBuffer(
    Buffer.from(
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ),
    "_rels/.rels",
  );
  zip.addBuffer(
    Buffer.from(
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>',
    ),
    "word/document.xml",
  );
  const chunks: Buffer[] = [];
  zip.outputStream.on("data", (b: Buffer) => chunks.push(b));
  const finished = new Promise<Buffer>((resolve, reject) => {
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on("error", reject);
  });
  zip.end();
  await inspectDocx(await finished);
  await assert.rejects(() => inspectDocx(Buffer.from("not a document")));
  const result = manifest.parse({
    schema_version: 1,
    request_id: uuid(),
    outcome: "completed",
    text: "",
    artifacts: [],
    validations: [],
    session_files: [],
  });
  await assert.rejects(() => validateDelivery(result, new Map()), AppError);
});
