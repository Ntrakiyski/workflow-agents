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
import { progress } from "../src/progress.js";
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
  startCalls = 0;
  prepareCalls = 0;
  runtimeUploads = 0;
  loseResponse = false;
  failStop = false;
  async createSandbox(requestId: string) {
    const prior = this.creations.get(requestId);
    if (prior) return prior;
    const sandbox = "sbx_" + requestId.replaceAll("-", "");
    this.creations.set(requestId, sandbox);
    return sandbox;
  }
  async createWorkspaceSandbox(workspaceId: string) {
    return this.createSandbox(workspaceId);
  }
  async inspect() {
    return { status: "running" };
  }
  async start() {
    this.startCalls++;
  }
  async prepare(workspaceId: string, sandbox: string) {
    this.prepareCalls++;
    const job: Job = {
      job_id: `job_prepare_${workspaceId}`,
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
  async upload(
    sandbox: string,
    path: string,
    data: Buffer,
    _key?: string,
    _correlation?: string,
    progress?: (uploaded: number, total: number) => Promise<void>,
  ) {
    await progress?.(data.length, data.length);
    const key = sandbox + "/" + path;
    const previous = this.files.get(key);
    if (path === "runtime/runtime-bundle.tar.gz" && !previous)
      this.runtimeUploads++;
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
      sandbox = jobId ? this.jobs.get(jobId)?.sandbox_id : null;
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
          media_type: "application/x-ndjson",
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
test("status history persists without polling duplicates, is owner scoped, and terminal timing matches the current outcome", async () => {
  const requestId = (await submit("Timeline and duration fixture")).json().id;
  const r = (await db.ownedRequest("alice", requestId))!;
  await db.transaction(async (c) => {
    await db.progress(c, r, progress.queued);
    await db.progress(c, r, progress.queued);
    await db.progress(c, r, progress.working);
    await db.progress(c, r, progress.working);
  });
  const timeline = await db.timeline("alice", requestId);
  assert.deepEqual(
    timeline.map((e) => e.message),
    [progress.working, progress.queued, "Request submitted."],
  );
  assert.equal(
    timeline[0].created_at,
    timeline[1].created_at,
    "Same timestamp uses descending event identity",
  );
  assert.ok(BigInt(timeline[0].id) > BigInt(timeline[1].id));
  assert.deepEqual(await db.timeline("bob", requestId), []);
  const newApi = createApi(db, objects, config);
  await newApi.ready();
  try {
    const reopened = await newApi.inject({
      url: `/api/requests/${requestId}`,
      headers: headers(),
    });
    assert.deepEqual(reopened.json().timeline, timeline);
    assert.equal(reopened.json().finished_at, null);
    assert.equal(
      (
        await newApi.inject({
          url: `/api/requests/${requestId}`,
          headers: headers("bob"),
        })
      ).statusCode,
      404,
    );
    await db.audit(db.pool, r, "request.progress", "application-worker", {
      message: "PRIVATE AUDIT DETAIL",
    });
    await db.audit(db.pool, r, "internal.fixture", "application-worker", {
      message: "PRIVATE AUDIT DETAIL",
    });
    assert.deepEqual(
      await db.timeline("alice", requestId),
      timeline,
      "Unrecognized audit content stays private",
    );
    const start = Date.parse(r.created_at);
    const failed = new Date(start + 2000).toISOString();
    const completed = new Date(start + 65000).toISOString();
    for (const [action, at] of [
      ["request.failed", failed],
      ["request.completed", completed],
    ]) {
      await db.pool.query(
        "INSERT INTO application.audit(request_id,owner_id,actor_id,action,correlation_id,created_at) VALUES($1,$2,'test',$3,$4,$5)",
        [r.id, r.owner_id, action, r.correlation_id, at],
      );
    }
    await db.pool.query(
      "UPDATE application.requests SET status='failed',updated_at=created_at+interval '5 minutes' WHERE id=$1",
      [r.id],
    );
    assert.equal(
      (
        await newApi.inject({
          url: `/api/requests/${requestId}`,
          headers: headers(),
        })
      ).json().finished_at,
      failed,
    );
    await db.pool.query(
      "UPDATE application.requests SET status='completed' WHERE id=$1",
      [r.id],
    );
    const completedDetail = (
      await newApi.inject({
        url: `/api/requests/${requestId}`,
        headers: headers(),
      })
    ).json();
    assert.equal(
      completedDetail.finished_at,
      completed,
      "Earlier failure and later cleanup cannot inflate completion time",
    );
    assert.equal(
      completedDetail.timeline[0].message,
      "Result files saved and ready.",
    );
    const list = (
      await newApi.inject({
        url: "/api/requests?limit=100",
        headers: headers(),
      })
    ).json().requests;
    assert.equal(
      list.find((item: { id: string }) => item.id === r.id).finished_at,
      completed,
    );
    assert.ok(
      !(await newApi.inject({ url: "/api/requests", headers: headers("bob") }))
        .json()
        .requests.some((item: { id: string }) => item.id === r.id),
    );
    const legacy = (await submit("Legacy terminal timing fixture")).json().id;
    await db.pool.query(
      "UPDATE application.requests SET status='failed',updated_at=created_at+interval '3 seconds' WHERE id=$1",
      [legacy],
    );
    const fallback = (
      await newApi.inject({
        url: `/api/requests/${legacy}`,
        headers: headers(),
      })
    ).json();
    assert.equal(
      Date.parse(fallback.finished_at) - Date.parse(fallback.created_at),
      3000,
    );
  } finally {
    await newApi.close();
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
  await db.pool.query(
    "UPDATE application.requests SET workspace_id=NULL WHERE id=$1",
    [requestId],
  );
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
  const messages = afterRestart
    .json()
    .timeline.map((e: { message: string }) => e.message);
  assert.ok(messages.includes(progress.working));
  assert.ok(messages.includes(progress.saving));
  assert.equal(messages[0], "Result files saved and ready.");
  assert.equal(afterRestart.json().finished_at, state?.finished_at);
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
    await db.pool.query(
      "UPDATE application.requests SET workspace_id=NULL WHERE id=$1",
      [requestId],
    );
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

test("login provisions once, independent requests share the prepared sandbox, and idle restart preserves installed tools", async () => {
  const sharedConfig = {
    ...config,
    idleStopSeconds: 0,
    users: [
      {
        username: "shared",
        owner_id: "shared-fixture",
        password_sha256: digest(password),
      },
    ],
  };
  const sharedApi = createApi(db, objects, sharedConfig);
  const fake = new FakeExecution();
  const runner = new RequestWorker(db, objects, fake, sharedConfig, api.log);
  const auth = {
    authorization: authorization("shared"),
    origin: config.publicOrigin,
  };
  async function create(
    instructions: string,
    prompt = "Use the assigned folder only.",
    key = uuid(),
  ) {
    const response = await sharedApi.inject({
      method: "POST",
      url: "/api/requests",
      headers: { ...auth, "idempotency-key": key },
      payload: { instructions, system_prompt: prompt },
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json().id as string;
  }
  await db.pool.query(
    "UPDATE application.requests SET next_attempt_at=now()+interval '1 day'",
  );
  // Avoid unrelated fixture workspaces stopping in this scenario.
  await db.pool.query(
    "UPDATE application.user_workspaces SET next_attempt_at=now()+interval '1 day'",
  );
  try {
    const initial = await sharedApi.inject({
      url: "/api/session?prepare=1",
      headers: auth,
    });
    assert.equal(initial.statusCode, 200);
    assert.equal(initial.json().workspace.status, "pending");
    const [a, b] = await Promise.all([
      create("Request A"),
      create("Request B"),
    ]);
    for (let i = 0; i < 4; i++) {
      await runner.tick();
      if (
        (await db.ownedRequest("shared-fixture", a))?.job_id &&
        (await db.ownedRequest("shared-fixture", b))?.job_id
      )
        break;
    }
    const ar = await db.ownedRequest("shared-fixture", a),
      br = await db.ownedRequest("shared-fixture", b);
    assert.equal(ar?.status, "running");
    assert.equal(br?.status, "running");
    assert.equal(ar?.sandbox_id, br?.sandbox_id);
    assert.notEqual(ar?.job_id, br?.job_id);
    assert.equal(fake.runtimeUploads, 1);
    assert.equal(fake.prepareCalls, 1);
    assert.equal(fake.creations.size, 1);
    const adata = JSON.parse(
      fake.files
        .get(`${ar!.sandbox_id}/requests/${a}/request.json`)!
        .toString(),
    );
    const bdata = JSON.parse(
      fake.files
        .get(`${br!.sandbox_id}/requests/${b}/request.json`)!
        .toString(),
    );
    assert.equal(adata.schema_version, 2);
    assert.equal(adata.request_id, a);
    assert.equal(bdata.request_id, b);
    assert.equal(adata.system_prompt, "Use the assigned folder only.");
    fake.complete(a);
    await runner.tick();
    assert.equal(
      (await db.ownedRequest("shared-fixture", a))?.status,
      "completed",
    );
    await runner.tick();
    assert.equal(
      fake.stopCalls,
      0,
      "An exported result cannot stop a sibling Pi session",
    );
    fake.complete(b);
    await runner.tick();
    await runner.tick();
    const stopped = await db.workspace("shared-fixture");
    assert.equal(stopped?.status, "stopped");
    assert.equal(fake.stopCalls, 1);
    assert.equal(
      (await db.ownedRequest("shared-fixture", a))?.sandbox_stopped,
      true,
    );
    // Signing in again starts the retained disk even before another request.
    await sharedApi.inject({ url: "/api/session?prepare=1", headers: auth });
    await runner.tick();
    assert.equal(fake.startCalls, 1);
    assert.equal(fake.runtimeUploads, 1);
    assert.equal(fake.prepareCalls, 1);
    const c = await create("Request C");
    for (
      let i = 0;
      i < 3 && !(await db.ownedRequest("shared-fixture", c))?.job_id;
      i++
    )
      await runner.tick();
    assert.equal(
      (await db.ownedRequest("shared-fixture", c))?.sandbox_id,
      ar?.sandbox_id,
    );
    assert.equal(fake.runtimeUploads, 1);
    assert.equal(fake.creations.size, 1);
    const evidence = await db.pool.query(
      "SELECT action FROM application.audit WHERE owner_id='shared-fixture'",
    );
    assert.ok(evidence.rows.some((row) => row.action === "workspace.ready"));
    assert.ok(evidence.rows.some((row) => row.action === "workspace.stopped"));
  } finally {
    await sharedApi.close();
  }
});

test("editable system prompts are owner scoped, snapshotted, and included in idempotency", async () => {
  const prompt = "Use a concise tone and preserve all original files.";
  const saved = await api.inject({
    method: "PUT",
    url: "/api/settings",
    headers: headers(),
    payload: { system_prompt: prompt },
  });
  assert.equal(saved.statusCode, 200);
  const session = await api.inject({ url: "/api/session", headers: headers() });
  assert.equal(session.json().system_prompt, prompt);
  const foreign = await api.inject({
    url: "/api/session",
    headers: headers("bob"),
  });
  assert.notEqual(foreign.json().system_prompt, prompt);
  const key = uuid();
  const payload = {
    instructions: "Prompt snapshot fixture",
    system_prompt: prompt,
  };
  const response = await api.inject({
    method: "POST",
    url: "/api/requests",
    headers: { ...headers(), "idempotency-key": key },
    payload,
  });
  assert.equal(response.statusCode, 201);
  const requestId = response.json().id;
  await api.inject({
    method: "PUT",
    url: "/api/settings",
    headers: headers(),
    payload: { system_prompt: "A changed default for future requests." },
  });
  assert.equal(
    (
      await api.inject({
        url: `/api/requests/${requestId}`,
        headers: headers(),
      })
    ).json().system_prompt,
    prompt,
  );
  assert.equal(
    (
      await api.inject({
        method: "POST",
        url: "/api/requests",
        headers: { ...headers(), "idempotency-key": key },
        payload,
      })
    ).json().id,
    requestId,
  );
  assert.equal(
    (
      await api.inject({
        method: "POST",
        url: "/api/requests",
        headers: { ...headers(), "idempotency-key": key },
        payload: { ...payload, system_prompt: "Changed snapshot" },
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await api.inject({
        method: "PUT",
        url: "/api/settings",
        headers: { authorization: authorization() },
        payload: { system_prompt: prompt },
      })
    ).statusCode,
    403,
  );
});

test("lost preparation acknowledgement and worker replacement retain one workspace and never dispatch before verified readiness", async () => {
  const owner = "prepare-recovery";
  const scopedConfig = {
    ...config,
    users: [
      { username: owner, owner_id: owner, password_sha256: digest(password) },
    ],
  };
  const scopedApi = createApi(db, objects, scopedConfig);
  class RecoveringExecution extends FakeExecution {
    lost = true;
    async prepare(workspaceId: string, sandbox: string) {
      const existing = this.jobs.get(`job_prepare_${workspaceId}`);
      if (existing) return existing;
      const job = await super.prepare(workspaceId, sandbox);
      job.status = "running";
      job.result = null;
      if (this.lost) {
        this.lost = false;
        throw new Error("test lost response");
      }
      return job;
    }
  }
  const fake = new RecoveringExecution();
  await db.pool.query(
    "UPDATE application.requests SET next_attempt_at=now()+interval '1 day'",
  );
  await db.pool.query(
    "UPDATE application.user_workspaces SET next_attempt_at=now()+interval '1 day'",
  );
  try {
    const auth = {
      authorization: authorization(owner),
      origin: config.publicOrigin,
    };
    const submitted = await scopedApi.inject({
      method: "POST",
      url: "/api/requests",
      headers: { ...auth, "idempotency-key": uuid() },
      payload: { instructions: "Wait for workspace verification" },
    });
    assert.equal(submitted.statusCode, 201);
    const requestId = submitted.json().id;
    const initial = new RequestWorker(db, objects, fake, scopedConfig, api.log);
    await initial.tick();
    assert.equal(fake.submitCalls, 0);
    let workspace = await db.workspace(owner);
    assert.equal(workspace?.status, "uploading");
    assert.equal(workspace?.uploaded_bytes, 12);
    await db.pool.query(
      "UPDATE application.user_workspaces SET next_attempt_at=now() WHERE owner_id=$1",
      [owner],
    );
    const replacement = new RequestWorker(
      db,
      objects,
      fake,
      scopedConfig,
      api.log,
    );
    await replacement.tick();
    workspace = await db.workspace(owner);
    assert.equal(workspace?.status, "preparing");
    assert.equal(fake.prepareCalls, 1);
    assert.equal(fake.runtimeUploads, 1);
    assert.equal(fake.creations.size, 1);
    assert.equal(fake.submitCalls, 0);
    const prepared = fake.jobs.get(workspace!.prepare_job_id!)!;
    prepared.status = "completed";
    prepared.result = {
      exit_code: 0,
      stdout: JSON.stringify({
        schema_version: 1,
        prepared: true,
        runtime_sha256: config.runtimeBundleSha256,
      }),
      stderr: "",
      output_truncated: false,
      artifacts: [],
    };
    await replacement.tick();
    await replacement.tick();
    assert.equal((await db.ownedRequest(owner, requestId))?.status, "running");
    assert.equal(fake.submitCalls, 1);
    await Promise.all([
      replacement.tick(),
      new RequestWorker(db, objects, fake, scopedConfig, api.log).tick(),
    ]);
    assert.equal(
      fake.submitCalls,
      1,
      "DB request lock preserves dispatch identity across workers",
    );
  } finally {
    await scopedApi.close();
  }
});

test("idle stop allows new admission while the next request waits for the retained sandbox", async () => {
  const owner = "idle-race";
  const scopedConfig = {
    ...config,
    idleStopSeconds: 0,
    users: [
      { username: owner, owner_id: owner, password_sha256: digest(password) },
    ],
  };
  const scopedApi = createApi(db, objects, scopedConfig);
  let signalStop!: () => void, releaseStop!: () => void;
  const stopping = new Promise<void>((resolve) => {
    signalStop = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseStop = resolve;
  });
  class StoppingExecution extends FakeExecution {
    async stop() {
      signalStop();
      await release;
      this.stopCalls++;
    }
  }
  const fake = new StoppingExecution();
  await db.pool.query(
    "UPDATE application.requests SET next_attempt_at=now()+interval '1 day'",
  );
  await db.pool.query(
    "UPDATE application.user_workspaces SET next_attempt_at=now()+interval '1 day'",
  );
  const auth = {
    authorization: authorization(owner),
    origin: config.publicOrigin,
  };
  try {
    await scopedApi.inject({ url: "/api/session", headers: auth });
    const workspace = await db.workspace(owner);
    await db.pool.query(
      "UPDATE application.user_workspaces SET status='ready',sandbox_id='sbx_idle_race',wake_requested=false WHERE owner_id=$1",
      [owner],
    );
    const runner = new RequestWorker(db, objects, fake, scopedConfig, api.log);
    const tick = runner.tick();
    await stopping;
    let admitted = false;
    const submitPromise = scopedApi
      .inject({
        method: "POST",
        url: "/api/requests",
        headers: { ...auth, "idempotency-key": uuid() },
        payload: { instructions: "Start after the idle stop" },
      })
      .then((response) => {
        admitted = true;
        return response;
      });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(admitted, true, "An in-flight stop does not block admission");
    releaseStop();
    await tick;
    const response = await submitPromise;
    assert.equal(response.statusCode, 201, response.body);
    assert.equal((await db.workspace(owner))?.status, "stopped");
    for (
      let i = 0;
      i < 3 && !(await db.ownedRequest(owner, response.json().id))?.job_id;
      i++
    )
      await runner.tick();
    const request = await db.ownedRequest(owner, response.json().id);
    assert.equal(request?.workspace_id, workspace?.id);
    assert.equal(request?.sandbox_id, "sbx_idle_race");
    assert.equal(fake.startCalls, 1);
    assert.equal(fake.runtimeUploads, 0);
    assert.equal(fake.prepareCalls, 0);
  } finally {
    releaseStop();
    await scopedApi.close();
  }
});

test("additive migration retains legacy submission idempotency without assigning its old request to a shared workspace", async () => {
  const requestId = uuid(),
    key = uuid(),
    instructions = "Legacy submission replay fixture";
  await db.pool.query(
    "INSERT INTO application.requests(id,owner_id,title,instructions,submission_key,fingerprint,correlation_id,status) VALUES($1::uuid,'alice',$2,$2,$3,$4,$1::text,'failed')",
    [
      requestId,
      instructions,
      key,
      digest(JSON.stringify({ instructions, attachment_ids: [] })),
    ],
  );
  const replay = await submit(instructions, key);
  assert.equal(replay.statusCode, 201, replay.body);
  assert.equal(replay.json().id, requestId);
  const retained = await db.ownedRequest("alice", requestId);
  assert.equal(retained?.workspace_id, null);
  assert.equal(retained?.system_prompt, "");
});

test("a Provider recovery stop is observed and resumes the same prepared disk without replay or another runtime upload", async () => {
  const owner = "transfer-recovery";
  const scopedConfig = {
    ...config,
    users: [
      { username: owner, owner_id: owner, password_sha256: digest(password) },
    ],
  };
  const scopedApi = createApi(db, objects, scopedConfig);
  class RecoveringTransfer extends FakeExecution {
    stopped = false;
    interrupted = false;
    async inspect() {
      return { status: this.stopped ? "stopped" : "running" };
    }
    async start() {
      this.stopped = false;
      this.startCalls++;
    }
    async upload(
      sandbox: string,
      path: string,
      data: Buffer,
      key?: string,
      correlation?: string,
      progress?: (uploaded: number, total: number) => Promise<void>,
    ) {
      if (path.includes("/request.json") && !this.interrupted) {
        this.interrupted = true;
        this.stopped = true;
        throw new RemoteError("sandbox_busy", false, 409);
      }
      return super.upload(sandbox, path, data, key, correlation, progress);
    }
  }
  const fake = new RecoveringTransfer();
  await db.pool.query(
    "UPDATE application.requests SET next_attempt_at=now()+interval '1 day'",
  );
  await db.pool.query(
    "UPDATE application.user_workspaces SET next_attempt_at=now()+interval '1 day'",
  );
  try {
    const auth = {
      authorization: authorization(owner),
      origin: config.publicOrigin,
    };
    const response = await scopedApi.inject({
      method: "POST",
      url: "/api/requests",
      headers: { ...auth, "idempotency-key": uuid() },
      payload: { instructions: "Recover only the stopped lifecycle" },
    });
    assert.equal(response.statusCode, 201);
    const requestId = response.json().id;
    const runner = new RequestWorker(db, objects, fake, scopedConfig, api.log);
    for (let i = 0; i < 4 && !fake.interrupted; i++) await runner.tick();
    assert.equal((await db.workspace(owner))?.status, "stopped");
    assert.equal(fake.submitCalls, 0);
    await db.pool.query(
      "UPDATE application.requests SET next_attempt_at=now() WHERE id=$1",
      [requestId],
    );
    for (
      let i = 0;
      i < 4 && !(await db.ownedRequest(owner, requestId))?.job_id;
      i++
    )
      await runner.tick();
    assert.equal((await db.ownedRequest(owner, requestId))?.status, "running");
    assert.equal(fake.creations.size, 1);
    assert.equal(fake.runtimeUploads, 1);
    assert.equal(fake.prepareCalls, 1);
    assert.equal(fake.startCalls, 1);
    assert.equal(fake.submitCalls, 1);
  } finally {
    await scopedApi.close();
  }
});
