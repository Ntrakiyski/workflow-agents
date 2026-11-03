#!/usr/bin/env node
/** HTTP-only policy observations in the exact retained acceptance fixture A.
 * Fixed operator-approved profile, no arbitrary code/arguments from clients.
 * Requires the same retained record/profile as gcc_probe; allocates no box.
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
const contracts = { runner: JSON.parse(readFileSync(root + "/openapi.json", "utf8")),
  provider: JSON.parse(readFileSync(root + "/provider.openapi.json", "utf8")) };
for (const [service, contract] of Object.entries(contracts)) ajv.addSchema(contract, service);
const validators = new Map();
const profile = process.env.QA_SANDBOX_PROFILE || "cloud-minimal-linux:v1";
const invocation = process.env.QA_INVOCATION_ID || process.argv[3] || "cloud-policy-v1";
const trace = "qa_cloud_policy_" + randomUUID().replaceAll("-", "");
const expect = (condition, label) => assert(condition, label);
const sha = value => createHash("sha256").update(value).digest("hex");
const ptr = value => value.replaceAll("~", "~0").replaceAll("/", "~1");
let stage = "configuration", identity, other, credentials, urls, record;
let started = false, jobId = null, observation = null, cached = null, owns = false, cachePath = null;

async function request(service, method, path, body, expected = 200) {
  const headers = { Authorization: "Bearer " + credentials[service], "X-Correlation-ID": trace };
  if (service === "provider") headers["X-Owner-ID"] = identity.owner_id;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    headers["Idempotency-Key"] = trace;
  }
  const response = await fetch(urls[service] + path, { method, headers,
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  expect(response.status === expected, `Unexpected ${service} HTTP status ${response.status}`);
  expect(response.headers.get("x-correlation-id") === trace, "Correlation response header mismatch");
  const raw = await response.text();
  expect(Buffer.byteLength(raw) <= 131072, "Response exceeded inspection bound");
  const payload = JSON.parse(raw);
  const actual = path.split("?")[0].split("/");
  const route = Object.keys(contracts[service].paths).find(candidate => {
    const parts = candidate.split("/");
    return parts.length === actual.length && parts.every((p, i) => /^\{[^}]+\}$/.test(p) || p === actual[i]);
  });
  expect(route && contracts[service].paths[route][method.toLowerCase()]?.responses[String(response.status)], "Undocumented response route/status");
  const ref = `${service}#/paths/${ptr(route)}/${method.toLowerCase()}/responses/${response.status}/content/application~1json/schema`;
  if (!validators.has(ref)) validators.set(ref, ajv.compile({ $ref: ref }));
  expect(validators.get(ref)(payload), "Response violates frozen OpenAPI schema");
  return payload;
}

async function loadRecord() {
  if (process.env.QA_RECORD_JSON) record = JSON.parse(process.env.QA_RECORD_JSON);
  else {
    const base = process.argv[2];
    const source = new URL(process.env.QA_RECORD_URL || base + "/docs/phase1/GCC-RETAINED-RECORD.json");
    expect(source.protocol === "https:" && !source.username && !source.password && source.hostname === "raw.githubusercontent.com" &&
      /^\/Ntrakiyski\/workflow-agents\/[a-f0-9]{7,40}\/docs\/phase1\/[A-Za-z0-9_.-]+\.json$/.test(source.pathname), "Record requires an immutable repository URL");
    const response = await fetch(source, { signal: AbortSignal.timeout(15000), redirect: "error" });
    expect(response.ok, "Retained record unavailable");
    const raw = await response.text();
    expect(Buffer.byteLength(raw) <= 32768, "Retained record exceeds bound");
    record = JSON.parse(raw);
  }
  const allowed = new Set(["version", "run_id", "owner_id", "prepared_correlation_id", "owner_ref_a", "owner_ref_b", "marker_sha256",
    "cancelled_job_id", "cancelled_schedule_id", "write_job_id", "sandbox_a", "read_job_id", "isolation_job_id", "sandbox_b",
    "write_event_ids", "sandbox_a_event_ids", "sandbox_b_event_ids"]);
  expect(record.version === 1 && /^gccqa_[a-f0-9]{32}$/.test(record.run_id) && Object.keys(record).every(k => allowed.has(k)), "Unrecognized retained record");
  expect(record.owner_id === identity.owner_id && /^[a-f0-9]{64}$/.test(record.marker_sha256) &&
    /^qa_gcc_[a-f0-9]{32}$/.test(record.prepared_correlation_id), "Retained owner or marker anchor mismatch");
  expect(record.owner_ref_a === "gcc-qa:" + record.run_id + ":a" && record.owner_ref_b === "gcc-qa:" + record.run_id + ":b", "Retained fixture references mismatch");
  for (const field of ["sandbox_a", "sandbox_b", "write_job_id", "read_job_id", "isolation_job_id", "cancelled_job_id", "cancelled_schedule_id"])
    expect(typeof record[field] === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(record[field]), "Retained identifier malformed");
  expect(record.sandbox_a !== record.sandbox_b, "Retained sandbox identities are equal");
  for (const field of ["write_event_ids", "sandbox_a_event_ids", "sandbox_b_event_ids"])
    expect(Array.isArray(record[field]) && record[field].length > 0 && record[field].every(id => typeof id === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(id)), "Retained audit IDs malformed");
}

async function validateLiveRecord() {
  for (const suffix of ["a", "b"]) {
    const box = await request("provider", "GET", "/v1/sandboxes/" + record["sandbox_" + suffix]);
    expect(box.owner_ref === record["owner_ref_" + suffix] && box.profile === profile && box.persistent &&
      box.status === "stopped" && box.active_run_id === null, "Retained fixture is not the expected stopped owned environment");
  }
  const write = await request("runner", "GET", "/v1/jobs/" + record.write_job_id);
  const isolated = await request("runner", "GET", "/v1/jobs/" + record.isolation_job_id);
  expect(write.status === "completed" && write.client_reference === record.owner_ref_a && write.sandbox_id === record.sandbox_a,
    "Original write job anchor mismatch");
  expect(isolated.status === "failed" && isolated.client_reference === record.owner_ref_b && isolated.sandbox_id === record.sandbox_b,
    "Original isolation job anchor mismatch");
  for (const [service, id, key] of [["runner", record.write_job_id, "write_event_ids"],
    ["provider", record.sandbox_a, "sandbox_a_event_ids"], ["provider", record.sandbox_b, "sandbox_b_event_ids"]]) {
    const page = await request(service, "GET", (service === "runner" ? "/v1/jobs/" : "/v1/sandboxes/") + id + "/events");
    expect(record[key].every(id => page.events.some(e => e.event_id === id && e.owner_id === identity.owner_id)), "Original audit identity anchor missing");
  }
}

async function claim() {
  expect(/^[A-Za-z0-9_.:-]{1,128}$/.test(invocation), "Invalid invocation identifier");
  const base = "/tmp/workflow-cloud-policy-qa";
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const key = sha(JSON.stringify({ version: 1, record, profile, invocation, source: process.argv[2] }));
  const directory = base + "/" + key;
  cachePath = directory + "/result.json";
  try { mkdirSync(directory, { mode: 0o700 }); owns = true; return; }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  const until = Date.now() + 210000;
  while (Date.now() < until) {
    try { cached = JSON.parse(readFileSync(cachePath, "utf8")); return; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    await sleep(500);
  }
  throw new Error("Existing inspection did not finish inside bound");
}

async function main() {
  const auth = JSON.parse(process.env.RUNNER_AUTH_JSON);
  identity = auth.find(p => p.permissions.includes("job:submit") && p.permissions.includes("job:read") && p.allow_resume &&
    p.sandbox_profiles.includes(profile) && p.workload_profiles.includes("fixture-runtime-policy:v1"));
  expect(identity, "Policy-fixture principal missing");
  other = auth.find(p => p.owner_id !== identity.owner_id);
  credentials = { runner: identity.token, provider: process.env.SANDBOX_PROVIDER_TOKEN };
  expect(credentials.provider, "Provider delegation credential missing");
  urls = { runner: (process.env.QA_RUNNER_URL || "http://127.0.0.1:" + (process.env.PORT || 8080)).replace(/\/$/, ""),
    provider: process.env.SANDBOX_PROVIDER_URL.replace(/\/$/, "") };
  stage = "retained_record_validation";
  await loadRecord();
  stage = "invocation_serialization";
  await claim();
  if (cached) return;
  stage = "live_fixture_validation";
  await validateLiveRecord();
  stage = "start_owned_fixture";
  started = true; // An ambiguous start reply still requires exact-fixture stop.
  const box = await request("provider", "POST", `/v1/sandboxes/${record.sandbox_a}/start`, {});
  expect(box.status === "running", "Retained fixture did not start");
  stage = "approved_policy_workload";
  const accepted = await request("runner", "POST", `/v1/jobs/${record.write_job_id}/resume`, {
    workload: { profile: "fixture-runtime-policy:v1", arguments: {} },
    limits: { max_duration_seconds: 15, max_attempts: 1, deadline_at: new Date(Date.now() + 120000).toISOString() } }, 202);
  jobId = accepted.job_id;
  let done;
  const until = Date.now() + 150000;
  while (Date.now() < until) {
    done = await request("runner", "GET", "/v1/jobs/" + jobId);
    if (["completed", "failed", "cancelled", "timed_out"].includes(done.status)) break;
    await sleep(500);
  }
  expect(done?.status === "completed" && done.sandbox_id === record.sandbox_a && done.attempt_count === 1 &&
    done.result?.exit_code === 0 && !done.result.output_truncated, "Policy workload failed or changed sandbox identity");
  expect(Buffer.byteLength(done.result.stdout) <= 4096, "Policy result exceeds bound");
  observation = JSON.parse(done.result.stdout);
  expect(Object.keys(observation).sort().join(",") === "cpu_count,external_tcp_attempts,interfaces,memory_total_bytes,rootfs_capacity_bytes", "Policy result shape unexpected");
  expect(observation.cpu_count === 1, "Guest CPU capacity differs from approved profile");
  expect(Number.isInteger(observation.memory_total_bytes) && observation.memory_total_bytes >= 900 * 1024 * 1024 &&
    observation.memory_total_bytes <= 1024 * 1024 * 1024, "Guest memory capacity differs from approved profile");
  expect(Number.isInteger(observation.rootfs_capacity_bytes) && observation.rootfs_capacity_bytes > 0 &&
    observation.rootfs_capacity_bytes <= 1024 * 1024 * 1024, "Guest rootfs capacity exceeds approved disk allocation");
  expect(Array.isArray(observation.interfaces) && observation.interfaces.includes("lo") &&
    observation.interfaces.every(name => ["lo", "dummy0"].includes(name)), "Unexpected guest network interface");
  expect(Array.isArray(observation.external_tcp_attempts) && observation.external_tcp_attempts.length === 2 &&
    observation.external_tcp_attempts.every(a => Object.keys(a).sort().join(",") === "connected,errno" &&
      a.connected === false && [101, 113].includes(a.errno)), "External TCP was not denied specifically by missing route");
  stage = "complete";
}

let error = null, stopError = null;
try { await main(); }
catch (failure) { error = failure instanceof assert.AssertionError ? failure.message : "Inspection could not complete its current stage"; }
finally {
  if (started) {
    try {
      const box = await request("provider", "POST", `/v1/sandboxes/${record.sandbox_a}/stop`, {});
      expect(box.status === "stopped", "Inspected fixture did not stop");
    } catch { stopError = "Owned fixture could not be confirmed stopped"; }
  }
}
let output = cached || { probe: "cloud-owned-fixture-policy-v1", correlation_id: trace, invocation_id: invocation,
  stage, outcome: error || stopError ? "failed" : "passed", sandbox_id: record?.sandbox_a || null, job_id: jobId,
  observations: error ? null : observation, error, stop_error: stopError,
  scope: "Observed provisioned guest capacity and absent-route TCP denial; no stress quota, general escape, hostname allowlist, artifact export or backup claim" };
if ([credentials?.runner, credentials?.provider, other?.token].filter(Boolean).some(value => JSON.stringify(output).includes(value)))
  output = { probe: "cloud-owned-fixture-policy-v1", outcome: "failed", error: "Output failed credential validation" };
if (owns) {
  try { writeFileSync(cachePath + ".tmp", JSON.stringify(output), { mode: 0o600 }); renameSync(cachePath + ".tmp", cachePath); }
  catch { output.outcome = "failed"; output.error = "Inspection result could not be cached"; }
}
console.log(JSON.stringify({ ...output, invocation_replay: Boolean(cached) }));
process.exitCode = output.outcome === "passed" ? 0 : 1;
