#!/usr/bin/env node
/** Independent HTTP-only staging acceptance probe. Run inside the Runner image.
 * Reads existing runtime credentials without printing them; no service imports.
 * QA_APP_ROOT may point at a local Runner service directory for a dry run.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

const root = process.env.QA_APP_ROOT || "/app";
const require = createRequire(root + "/package.json");
const Ajv2020 = require("ajv/dist/2020.js").default;
const addFormats = require("ajv-formats");
const ajv = new Ajv2020({ strict: false, validateFormats: true, allErrors: false });
addFormats(ajv);
const contracts = {
  runner: JSON.parse(readFileSync(root + "/openapi.json", "utf8")),
  provider: JSON.parse(readFileSync(root + "/provider.openapi.json", "utf8")),
};
for (const [name, contract] of Object.entries(contracts)) ajv.addSchema(contract, name);
const validators = new Map();
const trace = "qa_staging_" + randomUUID().replaceAll("-", "");
const results = [];
const resources = {};
let runtimeKind = "unverified";
let stage = "configuration";
const record = (check, detail = {}) => results.push({ check, outcome: "pass", ...detail });
const expect = (condition, label) => assert(condition, label);
const pointer = (value) => value.replaceAll("~", "~0").replaceAll("/", "~1");
const future = (seconds) => new Date(Date.now() + seconds * 1000).toISOString();
const terminal = new Set(["completed", "failed", "cancelled", "timed_out"]);
let identity, otherIdentity, urls, credentials;

function validate(service, method, path, status, payload) {
  const clean = path.split("?")[0];
  const template = Object.keys(contracts[service].paths).find((candidate) => {
    const parts = candidate.split("/");
    const actual = clean.split("/");
    return parts.length === actual.length && parts.every((p, i) => /^\{[^}]+\}$/.test(p) || p === actual[i]);
  });
  let ref;
  if (!template && clean === "/metrics" && status >= 400) ref = `${service}#/components/schemas/Error`;
  else {
    expect(template, "Response route absent from frozen contract");
    expect(contracts[service].paths[template][method.toLowerCase()]?.responses[String(status)], "Undocumented response status");
    ref = `${service}#/paths/${pointer(template)}/${method.toLowerCase()}/responses/${status}/content/application~1json/schema`;
  }
  if (!validators.has(ref)) validators.set(ref, ajv.compile({ $ref: ref }));
  expect(validators.get(ref)(payload), "Response violates frozen OpenAPI schema");
}

async function request(service, method, path, options = {}) {
  const { body, expected = 200, anonymous = false, token, key, extraHeaders = {}, text = false } = options;
  const headers = { "X-Correlation-ID": trace, ...extraHeaders };
  if (!anonymous) headers.Authorization = "Bearer " + (token ?? credentials[service]);
  if (service === "provider" && !anonymous) headers["X-Owner-ID"] = identity.owner_id;
  if (key) headers["Idempotency-Key"] = key;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let response;
  try {
    response = await fetch(urls[service] + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
  } catch { throw new Error("HTTP request failed or exceeded ten-second bound"); }
  expect((Array.isArray(expected) ? expected : [expected]).includes(response.status), `Unexpected ${service} HTTP status ${response.status}`);
  expect(response.headers.get("x-correlation-id") === trace, "Correlation response header mismatch");
  const raw = await response.text();
  expect(Buffer.byteLength(raw) <= 131072, "Response exceeds probe output bound");
  if (text) {
    expect(response.headers.get("content-type")?.startsWith("text/plain"), "Metrics content type mismatch");
    return raw;
  }
  let payload;
  try { payload = JSON.parse(raw); } catch { throw new Error("Response is not JSON"); }
  validate(service, method, path, response.status, payload);
  return { status: response.status, payload };
}

async function pollJob(id, seconds = 35) {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    const { payload } = await request("runner", "GET", "/v1/jobs/" + id);
    if (terminal.has(payload.status)) return payload;
    await sleep(250);
  }
  throw new Error("Job failed to terminate inside probe bound");
}

async function events(id, required) {
  const { payload } = await request("runner", "GET", `/v1/jobs/${id}/events`);
  const types = new Set(payload.events.map((event) => event.type));
  expect(required.every((type) => types.has(type)), "Expected durable job audit events absent");
  expect(payload.events.every((event) => event.owner_id === identity.owner_id && event.actor_id === identity.actor_id && event.correlation_id === trace), "Job audit identity/correlation mismatch");
  const serialized = JSON.stringify(payload);
  const secrets = [credentials.runner, credentials.provider, otherIdentity.token];
  expect(secrets.every((secret) => !serialized.includes(secret)), "Audit contains a configured credential");
  expect(!serialized.includes("\"arguments\"") && !serialized.includes("\"stdout\""), "Audit contains execution payload/output");
  return [...types];
}

function submission(unique) {
  return {
    client_reference: "independent-staging-qa:" + unique,
    workload: { profile: "fixture-write-file:v1", arguments: { file: "hello-world.txt", text: "hello-world-" + unique } },
    sandbox: { mode: "ensure", owner_ref: "independent-staging-qa:" + unique, profile: "minimal-linux:v1", persistent: true },
    limits: { max_duration_seconds: 5, max_attempts: 2, retry_backoff_seconds: 1 },
  };
}

async function main() {
  const auth = JSON.parse(process.env.RUNNER_AUTH_JSON);
  identity = auth.find((p) => ["job:submit", "job:read", "job:cancel", "schedule:write"].every((scope) => p.permissions.includes(scope)) && p.workload_profiles.includes("fixture-write-file:v1"));
  expect(identity, "Fixture-capable Runner principal missing");
  otherIdentity = auth.find((p) => p.owner_id !== identity.owner_id && p.permissions.includes("job:read"));
  expect(otherIdentity, "Second configured owner needed for isolation check");
  credentials = { runner: identity.token, provider: process.env.SANDBOX_PROVIDER_TOKEN };
  expect(credentials.provider, "Provider delegation credential missing");
  urls = {
    runner: (process.env.QA_RUNNER_URL || `http://127.0.0.1:${process.env.PORT || 8080}`).replace(/\/$/, ""),
    provider: process.env.SANDBOX_PROVIDER_URL.replace(/\/$/, ""),
  };
  stage = "health_and_auth";
  for (const service of ["runner", "provider"]) {
    const live = await request(service, "GET", "/health/live", { anonymous: true });
    expect(live.payload.status === "ok", "Liveness status incorrect");
    const ready = await request(service, "GET", "/health/ready", { anonymous: true, expected: [200, 503] });
    expect(ready.payload.checks.database === "ok", "Database readiness failed");
    if (service === "runner") {
      expect(ready.status === 200 && ready.payload.checks.queue === "ok", "Runner not ready");
    } else {
      runtimeKind = ready.status === 200 && ready.payload.checks.runtime === "ok" ? "boxlite_pending_proof" : "unavailable";
      expect(runtimeKind !== "unavailable" || (ready.status === 503 && ready.payload.status === "unavailable" && ready.payload.checks.runtime === "unavailable"), "Unavailable runtime readiness is untruthful");
    }
    record(service + ".health_contract", { readiness_http: ready.status, checks: ready.payload.checks });
    const path = service === "runner" ? "/v1/jobs/qa_missing" : "/v1/sandboxes/qa_missing";
    await request(service, "GET", path, { anonymous: true, expected: 401 });
    await request(service, "GET", path, { token: "qa_invalid_credential_000000000000", expected: 401 });
    await request(service, "GET", "/metrics", { anonymous: true, expected: 401 });
    await request(service, "GET", "/metrics", { text: true });
    record(service + ".authentication_and_metrics");
  }
  stage = "negative_boundaries";
  const base = submission(randomUUID());
  await request("runner", "POST", "/v1/jobs", { body: { ...base, unexpected: true }, key: trace + "_strict", expected: 422 });
  await request("runner", "POST", "/v1/jobs", { body: { ...base, workload: { profile: "denied:v1", arguments: {} } }, key: trace + "_denied", expected: 403 });
  await request("runner", "GET", "/v1/jobs/qa_missing", { extraHeaders: { "X-Owner-ID": otherIdentity.owner_id }, expected: 403 });
  await request("provider", "POST", "/v1/sandboxes", { body: { owner_ref: trace, profile: "minimal-linux:v1", persistent: true, owner_id: "spoof" }, key: trace + "_p_strict", expected: 422 });
  await request("provider", "POST", "/v1/sandboxes", { body: { owner_ref: trace, profile: "denied:v1", persistent: true }, key: trace + "_p_denied", expected: 403 });
  record("strict_schemas_denied_profiles_and_owner_spoof");
  stage = "future_job";
  const delayedBody = { ...base, run_at: future(120) };
  const opts = { body: delayedBody, key: trace + "_future", expected: 202 };
  const first = (await request("runner", "POST", "/v1/jobs", opts)).payload;
  resources.delayed_job_id = first.job_id;
  const replay = (await request("runner", "POST", "/v1/jobs", opts)).payload;
  expect(first.job_id === replay.job_id, "Duplicate submission created another job");
  await request("runner", "POST", "/v1/jobs", { ...opts, body: { ...delayedBody, client_reference: trace + "_changed" }, expected: 409 });
  await request("runner", "GET", "/v1/jobs/" + first.job_id, { token: otherIdentity.token, expected: 404 });
  await request("runner", "GET", `/v1/jobs/${first.job_id}/events`, { token: otherIdentity.token, expected: 404 });
  await sleep(600);
  const waiting = (await request("runner", "GET", "/v1/jobs/" + first.job_id)).payload;
  expect(waiting.status === "scheduled" && waiting.attempt_count === 0 && !waiting.sandbox_id, "Future job dispatched early");
  const cancelled = (await request("runner", "POST", `/v1/jobs/${first.job_id}/cancel`, { body: { reason: "Independent staging QA" }, expected: 202 })).payload;
  expect(cancelled.status === "cancelled", "Future cancellation failed");
  const types = await events(first.job_id, ["job.submitted", "job.cancellation_requested", "job.cancelled"]);
  record("future_job_idempotency_owner_isolation_cancel_audit", { event_types: types });
  stage = "future_schedule";
  const schedule = (await request("runner", "POST", "/v1/schedules", {
    body: { run_at: future(120), action: "submit_job", job: submission(randomUUID()) }, key: trace + "_schedule", expected: 201,
  })).payload;
  resources.schedule_id = schedule.schedule_id;
  expect(schedule.status === "pending" && !schedule.job_id, "Future schedule fired early");
  await request("runner", "GET", "/v1/schedules/" + schedule.schedule_id, { token: otherIdentity.token, expected: 404 });
  const deleted = (await request("runner", "DELETE", "/v1/schedules/" + schedule.schedule_id)).payload;
  expect(deleted.status === "cancelled", "Future schedule cancellation failed");
  record("future_schedule_and_cancellation");
  stage = "runtime_dispatch";
  const immediate = submission(randomUUID());
  // Cold real image creation is setup, not the five-second workload budget.
  // Retain the short unavailable-runtime bound; real setup gets a finite 5min.
  const setupSeconds = runtimeKind === "unavailable" ? 18 : 300;
  immediate.limits.deadline_at = future(setupSeconds);
  const accepted = (await request("runner", "POST", "/v1/jobs", { body: immediate, key: trace + "_runtime", expected: 202 })).payload;
  resources.runtime_job_id = accepted.job_id;
  const done = await pollJob(accepted.job_id, setupSeconds + 30);
  if (runtimeKind === "unavailable") {
    // Setup can fail before the first workload attempt is allocated.
    expect(["failed", "timed_out"].includes(done.status) && done.result === null && done.error && done.attempt_count >= 0 && done.attempt_count <= 2, "Unavailable runtime returned success or unbounded attempts");
    const failureTypes = await events(done.job_id, ["job.submitted", "job.dispatched"]);
    expect(failureTypes.some((type) => ["job.failed", "job.timed_out"].includes(type)), "Terminal failure audit absent");
    record("unavailable_runtime_bounded_failure", { status: done.status, attempts: done.attempt_count, error_code: done.error.code, event_types: failureTypes });
    results.push({ check: "real_boxlite_marker_stop_start_isolation_recovery", outcome: "blocked", reason: "Provider reports runtime unavailable; no mock workload is substituted" });
  } else {
    expect(done.status === "completed" && done.result?.exit_code === 0 && done.sandbox_id, "Real fixture write failed");
    resources.sandbox_id = done.sandbox_id;
    const box = done.sandbox_id;
    await request("provider", "POST", `/v1/sandboxes/${box}/stop`, { body: {} });
    const stopped = (await request("provider", "GET", `/v1/sandboxes/${box}`)).payload;
    expect(stopped.status === "stopped", "Real sandbox did not stop");
    await request("provider", "POST", `/v1/sandboxes/${box}/start`, { body: {} });
    const resumed = (await request("runner", "POST", `/v1/jobs/${done.job_id}/resume`, {
      body: { workload: { profile: "fixture-read-file:v1", arguments: { file: "hello-world.txt" } }, limits: { max_duration_seconds: 10, max_attempts: 1 } }, key: trace + "_resume", expected: 202,
    })).payload;
    const read = await pollJob(resumed.job_id);
    expect(read.status === "completed" && read.sandbox_id === box && read.result?.stdout === immediate.workload.arguments.text, "Real same-sandbox retained marker proof failed");
    runtimeKind = "boxlite_actual_marker_proof";
    record("real_boxlite_marker_stop_start_same_disk");
    const audited = (await request("provider", "GET", `/v1/sandboxes/${box}/events`)).payload;
    expect(audited.events.every((event) => event.owner_id === identity.owner_id && event.actor_id && event.correlation_id), "Provider audit identity absent");
    expect(["sandbox.created", "sandbox.stopped"].every((type) => audited.events.some((event) => event.type === type)), "Provider lifecycle audit absent");
    await request("provider", "POST", `/v1/sandboxes/${box}/stop`, { body: {} });
    record("provider_real_lifecycle_audit_and_safe_stop");
  }
  stage = "complete";
}

let error = null;
try { await main(); }
catch (failure) {
  // Only assertions authored here are rendered. Never include third-party errors,
  // request headers/bodies, environment values or URLs in scheduled-task logs.
  error = failure instanceof assert.AssertionError ? failure.message : "Probe could not complete its current stage";
}
console.log(JSON.stringify({ probe: "independent-private-http-v1", correlation_id: trace, stage, runtime_kind: runtimeKind, checks: results, resources, error }));
process.exitCode = error ? 1 : 0;
