#!/usr/bin/env node
/** HTTP-only real-runtime acceptance, with an operator-retained restart record.
 * Run in Runner. No service imports, SDK, database access or runtime fallback.
 * prepare: create fixtures and emit record; verify: check after app replacement;
 * cleanup: explicitly remove only the validated recorded fixture sandboxes.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";

const root = process.env.QA_APP_ROOT || "/app";
const require = createRequire(root + "/package.json");
const Ajv2020 = require("ajv/dist/2020.js").default;
const ajv = new Ajv2020({ strict: false, allErrors: false });
require("ajv-formats")(ajv);
const contracts = {
  runner: JSON.parse(readFileSync(root + "/openapi.json", "utf8")),
  provider: JSON.parse(readFileSync(root + "/provider.openapi.json", "utf8")),
};
for (const [service, contract] of Object.entries(contracts)) ajv.addSchema(contract, service);
const phase = process.env.QA_PHASE || process.argv[3] || "prepare";
const sourceBase = process.argv[2];
const invocation = process.env.QA_INVOCATION_ID || process.argv[4] || "gcc-phase1-migration-v1";
const trace = "qa_gcc_" + randomUUID().replaceAll("-", "");
const checks = [];
const schemas = new Map();
const terminal = new Set(["completed", "failed", "cancelled", "timed_out"]);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const future = (seconds) => new Date(Date.now() + seconds * 1000).toISOString();
const expect = (condition, label) => assert(condition, label);
const pass = (check, fields = {}) => checks.push({ check, outcome: "pass", ...fields });
const pointer = (value) => value.replaceAll("~", "~0").replaceAll("/", "~1");
let stage = "configuration";
let record = null;
let recordValidated = false;
let identity, other, credentials, urls;
let cachePath, ownsInvocation = false, replayedOutput = null;

async function claimInvocation() {
  expect(/^[A-Za-z0-9_.:-]{1,128}$/.test(invocation), "Invalid operator invocation identifier");
  // Coolify's one-off task uses cron and can launch again before its first run
  // finishes. Serialize the same operator invocation and replay its result.
  // A changed retained record/owner/source is a distinct invocation, so cached
  // success can never bypass validation of different cleanup targets.
  const key = sha256(JSON.stringify({ version: 1, phase, invocation, owner: identity.owner_id, sourceBase,
    record: process.env.QA_RECORD_JSON || process.env.QA_RECORD_URL || "" }));
  const base = "/tmp/workflow-gcc-qa-results";
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const lock = base + "/" + key;
  cachePath = lock + "/result.json";
  try { mkdirSync(lock, { mode: 0o700 }); ownsInvocation = true; return null; }
  catch (failure) { if (failure.code !== "EEXIST") throw failure; }
  const until = Date.now() + 900000;
  while (Date.now() < until) {
    try { return JSON.parse(readFileSync(cachePath, "utf8")); }
    catch (failure) { if (failure.code !== "ENOENT") throw failure; }
    await sleep(500);
  }
  throw new Error("An existing invocation did not produce its result inside the operator bound");
}

function validate(service, method, path, status, payload) {
  const actual = path.split("?")[0].split("/");
  const route = Object.keys(contracts[service].paths).find((candidate) => {
    const parts = candidate.split("/");
    return parts.length === actual.length && parts.every((p, i) => /^\{[^}]+\}$/.test(p) || p === actual[i]);
  });
  let ref;
  if (!route && actual.join("/") === "/metrics" && status >= 400) ref = `${service}#/components/schemas/Error`;
  else {
    expect(route, "Unknown response contract route");
    expect(contracts[service].paths[route][method.toLowerCase()]?.responses[String(status)], "Undocumented response status");
    ref = `${service}#/paths/${pointer(route)}/${method.toLowerCase()}/responses/${status}/content/application~1json/schema`;
  }
  if (!schemas.has(ref)) schemas.set(ref, ajv.compile({ $ref: ref }));
  expect(schemas.get(ref)(payload), "Response violates frozen OpenAPI schema");
}

async function request(service, method, path, options = {}) {
  const { body, key, expected = 200, anonymous = false, token, owner = identity.owner_id, text = false, extraHeaders = {} } = options;
  const headers = { "X-Correlation-ID": trace, ...extraHeaders };
  if (!anonymous) headers.Authorization = "Bearer " + (token ?? credentials[service]);
  if (service === "provider" && !anonymous) headers["X-Owner-ID"] = owner;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (key) headers["Idempotency-Key"] = key;
  let response;
  try {
    response = await fetch(urls[service] + path, { method, headers,
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  } catch { throw new Error("Bounded HTTP request failed"); }
  expect((Array.isArray(expected) ? expected : [expected]).includes(response.status), `Unexpected ${service} HTTP status ${response.status}`);
  expect(response.headers.get("x-correlation-id") === trace, "Correlation response header mismatch");
  const raw = await response.text();
  expect(Buffer.byteLength(raw) <= 131072, "Response exceeded probe bound");
  if (text) {
    expect(response.headers.get("content-type")?.startsWith("text/plain"), "Unexpected metrics content type");
    return raw;
  }
  let payload;
  try { payload = JSON.parse(raw); } catch { throw new Error("Non-JSON response"); }
  validate(service, method, path, response.status, payload);
  return payload;
}

async function pollJob(id, seconds = 330) {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    const job = await request("runner", "GET", "/v1/jobs/" + id);
    if (terminal.has(job.status)) return job;
    await sleep(500);
  }
  throw new Error("Job did not reach a terminal state within the operator bound");
}

async function audit(service, id) {
  const events = [];
  let cursor;
  for (let page = 0; page < 20; page++) {
    const base = service === "runner" ? `/v1/jobs/${id}/events` : `/v1/sandboxes/${id}/events`;
    const response = await request(service, "GET", base + (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""));
    events.push(...response.events);
    if (!response.next_cursor) {
      expect(events.every((e) => e.owner_id === identity.owner_id && e.actor_id && e.correlation_id), "Audit identity absent or cross-owner event leaked");
      const serialized = JSON.stringify(events);
      expect([credentials.runner, credentials.provider, other.token].every((v) => !serialized.includes(v)), "Audit contains a configured credential");
      expect(!/"(?:arguments|stdout|stderr)"/.test(serialized), "Audit contains execution payload or output");
      return events;
    }
    expect(response.next_cursor !== cursor, "Audit pagination failed to progress");
    cursor = response.next_cursor;
  }
  throw new Error("Audit pagination exceeded the operator bound");
}

function submission(ownerRef, workload) {
  return { client_reference: ownerRef, workload,
    sandbox: { mode: "ensure", owner_ref: ownerRef, profile: "minimal-linux:v1", persistent: true },
    limits: { max_duration_seconds: 30, max_attempts: 1, retry_backoff_seconds: 1, deadline_at: future(300) } };
}

async function completedRead(sourceJob, markerHash, key) {
  const accepted = await request("runner", "POST", `/v1/jobs/${sourceJob}/resume`, {
    body: { workload: { profile: "fixture-read-file:v1", arguments: { file: "hello-world.txt" } },
      limits: { max_duration_seconds: 30, max_attempts: 1, deadline_at: future(120) } },
    key, expected: 202 });
  const job = await pollJob(accepted.job_id, 150);
  expect(job.status === "completed" && job.result?.exit_code === 0, "Retained marker read did not complete successfully");
  expect(sha256(job.result.stdout) === markerHash, "Retained marker checksum differs");
  return job;
}

async function stop(id) {
  const box = await request("provider", "POST", `/v1/sandboxes/${id}/stop`, { body: {} });
  expect(box.status === "stopped", "Sandbox did not stop without destruction");
}

async function health() {
  for (const service of ["runner", "provider"]) {
    const live = await request(service, "GET", "/health/live", { anonymous: true });
    expect(live.status === "ok", "Liveness failed");
    const ready = await request(service, "GET", "/health/ready", { anonymous: true, expected: [200, 503] });
    expect(ready.status === "ok" && ready.checks.database === "ok", "Service is not ready");
    expect(service === "runner" ? ready.checks.queue === "ok" : ready.checks.runtime === "ok", "Real runtime or queue is unavailable; no fallback is permitted");
    const missing = service === "runner" ? "/v1/jobs/qa_missing" : "/v1/sandboxes/qa_missing";
    await request(service, "GET", missing, { anonymous: true, expected: 401 });
    await request(service, "GET", missing, { token: "qa_invalid_credential_000000000000", expected: 401 });
    await request(service, "GET", "/metrics", { anonymous: true, expected: 401 });
    await request(service, "GET", "/metrics", { text: true });
    pass(service + ".ready_authentication_metrics");
  }
}

async function prepare() {
  const runId = "gccqa_" + randomUUID().replaceAll("-", "");
  const marker = "gcc-marker-" + randomUUID();
  record = { version: 1, run_id: runId, owner_id: identity.owner_id, prepared_correlation_id: trace,
    owner_ref_a: "gcc-qa:" + runId + ":a", owner_ref_b: "gcc-qa:" + runId + ":b", marker_sha256: sha256(marker) };
  recordValidated = true; // All values are generated generic QA metadata here.
  const write = submission(record.owner_ref_a, { profile: "fixture-write-file:v1", arguments: { file: "hello-world.txt", text: marker } });
  stage = "negative_boundaries";
  await request("runner", "POST", "/v1/jobs", { body: { ...write, unexpected: true }, key: runId + "_strict", expected: 422 });
  await request("runner", "POST", "/v1/jobs", { body: { ...write, workload: { profile: "denied:v1", arguments: {} } }, key: runId + "_denied", expected: 403 });
  await request("runner", "GET", "/v1/jobs/qa_missing", { extraHeaders: { "X-Owner-ID": other.owner_id }, expected: 403 });
  await request("provider", "POST", "/v1/sandboxes", { body: { owner_ref: runId, profile: "denied:v1", persistent: true }, key: runId + "_provider_denied", expected: 403 });
  pass("strict_schema_denied_profiles_owner_spoof");

  stage = "future_cancellation";
  const delayedBody = { ...write, run_at: future(120) };
  const delayed = await request("runner", "POST", "/v1/jobs", { body: delayedBody, key: runId + "_delayed", expected: 202 });
  record.cancelled_job_id = delayed.job_id;
  await sleep(600);
  const pending = await request("runner", "GET", `/v1/jobs/${delayed.job_id}`);
  expect(pending.status === "scheduled" && pending.attempt_count === 0 && !pending.sandbox_id, "Future job dispatched early");
  const cancelled = await request("runner", "POST", `/v1/jobs/${delayed.job_id}/cancel`, { body: { reason: "GCC independent QA future cancellation" }, expected: 202 });
  expect(cancelled.status === "cancelled", "Future cancellation did not reach terminal state");
  const cancellationEvents = await audit("runner", delayed.job_id);
  expect(["job.submitted", "job.cancellation_requested", "job.cancelled"].every((type) => cancellationEvents.some((e) => e.type === type)), "Future cancellation audit incomplete");
  const schedule = await request("runner", "POST", "/v1/schedules", {
    body: { run_at: future(120), action: "submit_job", job: write }, key: runId + "_schedule", expected: 201 });
  record.cancelled_schedule_id = schedule.schedule_id;
  expect(schedule.status === "pending" && !schedule.job_id, "Future schedule fired early");
  const cancelledSchedule = await request("runner", "DELETE", `/v1/schedules/${schedule.schedule_id}`);
  expect(cancelledSchedule.status === "cancelled", "Future schedule cancellation failed");
  pass("future_job_schedule_cancellation_and_durable_audit");

  stage = "real_write_duplicate_admission";
  const opts = { body: write, key: runId + "_write", expected: 202 };
  const [accepted, replay] = await Promise.all([request("runner", "POST", "/v1/jobs", opts), request("runner", "POST", "/v1/jobs", opts)]);
  expect(accepted.job_id === replay.job_id, "Concurrent duplicate admission created another job");
  record.write_job_id = accepted.job_id;
  await request("runner", "POST", "/v1/jobs", { ...opts, body: { ...write, client_reference: runId + "_changed" }, expected: 409 });
  const done = await pollJob(accepted.job_id);
  expect(done.status === "completed" && done.result?.exit_code === 0 && done.sandbox_id && done.attempt_count === 1, "Real write failed or duplicate workload attempt observed");
  record.sandbox_a = done.sandbox_id;
  const replayDone = await request("runner", "POST", "/v1/jobs", opts);
  expect(replayDone.job_id === done.job_id && replayDone.attempt_count === 1, "Completed duplicate submission changed execution identity");
  pass("real_write_concurrent_dedupe_changed_payload_conflict", { attempts: done.attempt_count });

  stage = "same_sandbox_stop_start";
  await stop(record.sandbox_a);
  await request("provider", "POST", `/v1/sandboxes/${record.sandbox_a}/start`, { body: {} });
  const read = await completedRead(record.write_job_id, record.marker_sha256, runId + "_read");
  expect(read.sandbox_id === record.sandbox_a, "Resume selected a different sandbox");
  record.read_job_id = read.job_id;
  await stop(record.sandbox_a);
  pass("real_marker_stop_start_same_public_sandbox", { marker_sha256: record.marker_sha256 });

  stage = "two_sandbox_isolation";
  const isolated = await request("runner", "POST", "/v1/jobs", {
    body: submission(record.owner_ref_b, { profile: "fixture-read-file:v1", arguments: { file: "hello-world.txt" } }), key: runId + "_isolation", expected: 202 });
  record.isolation_job_id = isolated.job_id;
  const isolatedDone = await pollJob(isolated.job_id);
  expect(isolatedDone.status === "failed" && isolatedDone.sandbox_id && isolatedDone.result?.exit_code !== 0 && isolatedDone.result?.exit_code != null,
    "Second sandbox isolation requires a real command failure, not setup failure");
  expect(isolatedDone.sandbox_id !== record.sandbox_a && isolatedDone.attempt_count === 1, "Isolation did not execute once in a distinct sandbox");
  record.sandbox_b = isolatedDone.sandbox_id;
  pass("real_second_sandbox_cannot_read_first_marker");

  stage = "cancellation_fence";
  const executionRef = runId + "_fenced";
  const fence = await request("provider", "POST", `/v1/sandboxes/${record.sandbox_b}/runs/cancel-by-reference`, { body: { execution_ref: executionRef }, expected: 202 });
  expect(fence.status === "fenced" && fence.run_id === null, "Unseen execution was not fenced");
  const rejected = await request("provider", "POST", `/v1/sandboxes/${record.sandbox_b}/execute`, {
    body: { execution_ref: executionRef, profile: "fixture-read-file:v1", arguments: { file: "hello-world.txt" }, timeout_seconds: 30 },
    key: runId + "_late_execute", expected: 409 });
  expect(rejected.code === "execution_cancelled", "Late execute failed for a reason other than the cancellation fence");
  await stop(record.sandbox_b);
  pass("durable_cancellation_fence_prevents_late_execute");

  stage = "retained_record";
  for (const id of [record.write_job_id, record.read_job_id, record.isolation_job_id]) {
    await request("runner", "GET", `/v1/jobs/${id}`, { token: other.token, expected: 404 });
    await request("runner", "GET", `/v1/jobs/${id}/events`, { token: other.token, expected: 404 });
  }
  for (const id of [record.sandbox_a, record.sandbox_b]) {
    await request("provider", "GET", `/v1/sandboxes/${id}`, { owner: other.owner_id, expected: 404 });
    await request("provider", "GET", `/v1/sandboxes/${id}/events`, { owner: other.owner_id, expected: 404 });
  }
  record.write_event_ids = (await audit("runner", record.write_job_id)).map((e) => e.event_id);
  const aEvents = await audit("provider", record.sandbox_a);
  expect(["sandbox.created", "sandbox.stopped", "sandbox.resumed", "run.completed"].every((type) => aEvents.some((e) => e.type === type)), "Real lifecycle audit incomplete");
  expect(aEvents.filter((e) => e.type === "run.started").length === 2, "Duplicate Provider execution was observed for write/read");
  record.sandbox_a_event_ids = aEvents.map((e) => e.event_id);
  record.sandbox_b_event_ids = (await audit("provider", record.sandbox_b)).map((e) => e.event_id);
  pass("owner_boundaries_and_retained_audit_record");
}

async function loadRecord() {
  if (process.env.QA_RECORD_JSON) record = JSON.parse(process.env.QA_RECORD_JSON);
  else {
    const url = process.env.QA_RECORD_URL || (sourceBase && sourceBase.replace(/\/$/, "") + "/docs/phase1/GCC-RETAINED-RECORD.json");
    expect(url && url.startsWith("https://"), "Explicit immutable HTTPS record URL or QA_RECORD_JSON required");
    const response = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: "error" });
    expect(response.ok, "Retained record could not be loaded");
    const raw = await response.text();
    expect(Buffer.byteLength(raw) <= 32768, "Retained record exceeds bound");
    record = JSON.parse(raw);
  }
  expect(record.version === 1 && /^gccqa_[a-f0-9]{32}$/.test(record.run_id), "Unrecognized retained record");
  const allowed = new Set(["version", "run_id", "owner_id", "prepared_correlation_id", "owner_ref_a", "owner_ref_b", "marker_sha256",
    "cancelled_job_id", "cancelled_schedule_id", "write_job_id", "sandbox_a", "read_job_id", "isolation_job_id", "sandbox_b",
    "write_event_ids", "sandbox_a_event_ids", "sandbox_b_event_ids"]);
  expect(Object.keys(record).every((key) => allowed.has(key)), "Retained record contains an unsupported field");
  expect(/^qa_gcc_[a-f0-9]{32}$/.test(record.prepared_correlation_id), "Retained correlation identifier is invalid");
  expect(record.owner_id === identity.owner_id && /^[a-f0-9]{64}$/.test(record.marker_sha256), "Retained owner or marker checksum mismatch");
  expect(record.owner_ref_a === "gcc-qa:" + record.run_id + ":a" && record.owner_ref_b === "gcc-qa:" + record.run_id + ":b", "Retained fixture references are invalid");
  for (const field of ["sandbox_a", "sandbox_b", "write_job_id", "read_job_id", "isolation_job_id", "cancelled_job_id", "cancelled_schedule_id"]) {
    expect(typeof record[field] === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(record[field]), "Retained identifier is invalid");
  }
  expect(record.sandbox_a !== record.sandbox_b, "Retained sandboxes are not distinct");
  for (const field of ["write_event_ids", "sandbox_a_event_ids", "sandbox_b_event_ids"]) {
    expect(Array.isArray(record[field]) && record[field].length > 0 && record[field].every((id) => typeof id === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(id)), "Retained event list is invalid");
  }
  // Validate all live ownership/reference anchors before any start/stop/destroy.
  for (const suffix of ["a", "b"]) {
    const sandbox = await request("provider", "GET", "/v1/sandboxes/" + record["sandbox_" + suffix]);
    expect(sandbox.owner_ref === record["owner_ref_" + suffix] && sandbox.profile === "minimal-linux:v1" && sandbox.persistent, "Recorded sandbox is not the expected QA fixture");
    expect(sandbox.active_run_id === null, "Recorded QA sandbox has an active run");
  }
  const write = await request("runner", "GET", "/v1/jobs/" + record.write_job_id);
  const isolated = await request("runner", "GET", "/v1/jobs/" + record.isolation_job_id);
  expect(write.client_reference === record.owner_ref_a && write.sandbox_id === record.sandbox_a && write.status === "completed", "Recorded write job anchor mismatch");
  expect(isolated.client_reference === record.owner_ref_b && isolated.sandbox_id === record.sandbox_b && isolated.status === "failed", "Recorded isolation job anchor mismatch");
  recordValidated = true;
}

async function verify() {
  stage = "retained_record_validation";
  await loadRecord();
  const originalRead = await request("runner", "GET", "/v1/jobs/" + record.read_job_id);
  expect(originalRead.status === "completed" && originalRead.sandbox_id === record.sandbox_a && sha256(originalRead.result.stdout) === record.marker_sha256, "Completed read result was not retained");
  const cancelled = await request("runner", "GET", "/v1/jobs/" + record.cancelled_job_id);
  const schedule = await request("runner", "GET", "/v1/schedules/" + record.cancelled_schedule_id);
  expect(cancelled.status === "cancelled" && schedule.status === "cancelled", "Cancelled job/schedule state was not retained");
  for (const [service, id, field] of [["runner", record.write_job_id, "write_event_ids"], ["provider", record.sandbox_a, "sandbox_a_event_ids"], ["provider", record.sandbox_b, "sandbox_b_event_ids"]]) {
    const retained = await audit(service, id);
    const ids = new Set(retained.map((e) => e.event_id));
    expect(record[field].every((id) => ids.has(id)), "Original audit event identities were not retained");
    if (service === "provider") expect(retained.some((e) => e.type === "sandbox.recovered"), "Provider replacement recovery audit absent");
  }
  pass("completed_jobs_cancelled_schedule_original_audit_ids_retained");
  stage = "post_replacement_marker_read";
  await request("provider", "POST", `/v1/sandboxes/${record.sandbox_a}/start`, { body: {} });
  const read = await completedRead(record.write_job_id, record.marker_sha256, trace + "_post_replacement");
  expect(read.sandbox_id === record.sandbox_a, "Post-replacement read changed sandbox identity");
  await stop(record.sandbox_a);
  pass("post_provider_runner_replacement_real_marker_retained", { read_job_id: read.job_id, marker_sha256: record.marker_sha256 });
  for (const id of [record.sandbox_a, record.sandbox_b]) await request("provider", "GET", `/v1/sandboxes/${id}`, { owner: other.owner_id, expected: 404 });
  pass("post_replacement_owner_boundary");
}

async function cleanup() {
  expect(process.env.QA_ALLOW_DESTROY === "1", "Cleanup requires explicit QA_ALLOW_DESTROY=1");
  stage = "cleanup_record_validation";
  await loadRecord();
  stage = "explicit_fixture_destruction";
  for (const id of [record.sandbox_a, record.sandbox_b]) {
    const sandbox = await request("provider", "GET", `/v1/sandboxes/${id}`);
    if (sandbox.status !== "destroyed") {
      if (sandbox.status !== "stopped") await stop(id);
      const removed = await request("provider", "POST", `/v1/sandboxes/${id}/destroy`, {
        body: { confirm: true, reason: "Explicit cleanup of validated GCC acceptance fixture" } });
      expect(removed.status === "destroyed", "Explicit fixture deletion did not reach tombstone");
    }
    const events = await audit("provider", id);
    expect(events.some((e) => e.type === "sandbox.destroyed"), "Explicit destruction audit absent");
  }
  pass("explicit_recorded_fixture_destruction_and_durable_audit");
}

let error = null;
try {
  expect(["prepare", "verify", "cleanup"].includes(phase), "Unknown operator phase");
  const auth = JSON.parse(process.env.RUNNER_AUTH_JSON);
  identity = auth.find((p) => ["job:submit", "job:read", "job:cancel", "schedule:write"].every((scope) => p.permissions.includes(scope)) && ["fixture-write-file:v1", "fixture-read-file:v1"].every((p2) => p.workload_profiles.includes(p2)) && p.allow_resume);
  expect(identity, "Fixture-capable resume-authorized Runner principal is required");
  other = auth.find((p) => p.owner_id !== identity.owner_id && p.permissions.includes("job:read"));
  expect(other, "Independent second owner is required");
  credentials = { runner: identity.token, provider: process.env.SANDBOX_PROVIDER_TOKEN };
  expect(credentials.provider, "Provider delegation credential is required");
  urls = { runner: (process.env.QA_RUNNER_URL || "http://127.0.0.1:" + (process.env.PORT || 8080)).replace(/\/$/, ""),
    provider: process.env.SANDBOX_PROVIDER_URL.replace(/\/$/, "") };
  stage = "operator_invocation";
  replayedOutput = await claimInvocation();
  if (!replayedOutput) {
    stage = "real_runtime_readiness";
    await health();
    if (phase === "prepare") await prepare();
    if (phase === "verify") await verify();
    if (phase === "cleanup") await cleanup();
    stage = "complete";
  }
} catch (failure) {
  // Render only constant assertions authored here, never third-party/HTTP errors.
  error = failure instanceof assert.AssertionError ? failure.message : "Probe could not complete its current stage";
}
let output = replayedOutput || { probe: "gcc-real-http-v1", phase, invocation_id: invocation, correlation_id: trace, stage,
  runtime_proof: error ? "incomplete" : phase === "cleanup" ? "explicit_fixture_cleanup" : "real_marker_proof_requires_real_deployed_adapter",
  checks, retained_record: recordValidated ? record : null, error };
if ([credentials?.runner, credentials?.provider, other?.token].filter(Boolean).some((value) => JSON.stringify(output).includes(value))) {
  output = { probe: "gcc-real-http-v1", phase, stage: "output_validation", checks: [], retained_record: null, error: "Probe output failed credential redaction" };
}
if (ownsInvocation) {
  try {
    writeFileSync(cachePath + ".tmp", JSON.stringify(output), { mode: 0o600 });
    renameSync(cachePath + ".tmp", cachePath);
  } catch { output.error = "Operator invocation result could not be cached"; }
}
console.log(JSON.stringify({ ...output, invocation_replay: Boolean(replayedOutput) }));
process.exitCode = output.error ? 1 : 0;
