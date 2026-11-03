#!/usr/bin/env node
/** Migration inspection only. No successful mutation, SDK/runtime operation or
 * database write is requested. Negative POST routes reject before DB/runtime
 * in the reviewed service source. Run inside Runner with production deps.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

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
const validators = new Map();
const trace = "qa_migration_" + randomUUID().replaceAll("-", "");
const checks = [];
const expect = (condition, label) => assert(condition, label);
const pass = (check, fields = {}) => checks.push({ check, outcome: "pass", ...fields });
const pointer = (value) => value.replaceAll("~", "~0").replaceAll("/", "~1");
let stage = "configuration", identity, other, credentials, urls, history;
let crossDbDenied = false;

function validate(service, method, path, status, payload) {
  const actual = path.split("?")[0].split("/");
  const route = Object.keys(contracts[service].paths).find((candidate) => {
    const parts = candidate.split("/");
    return parts.length === actual.length && parts.every((p, i) => /^\{[^}]+\}$/.test(p) || p === actual[i]);
  });
  let ref;
  if (!route && path === "/metrics" && status >= 400) ref = `${service}#/components/schemas/Error`;
  else {
    expect(route, "Unknown response contract route");
    expect(contracts[service].paths[route][method.toLowerCase()]?.responses[String(status)], "Undocumented response status");
    ref = `${service}#/paths/${pointer(route)}/${method.toLowerCase()}/responses/${status}/content/application~1json/schema`;
  }
  if (!validators.has(ref)) validators.set(ref, ajv.compile({ $ref: ref }));
  expect(validators.get(ref)(payload), "Response violates frozen OpenAPI schema");
}

async function request(service, method, path, options = {}) {
  const { body, expected = 200, anonymous = false, token, owner = identity.owner_id,
    text = false, extraHeaders = {} } = options;
  // Keep the side-effect boundary encoded: only these fail-before-storage
  // create routes may receive a negative request. No lifecycle/run/job action.
  expect(method === "GET" || (method === "POST" && expected >= 400 &&
    ((service === "runner" && path === "/v1/jobs") || (service === "provider" && path === "/v1/sandboxes"))),
  "Probe attempted an unauthorized mutation route");
  const headers = { "X-Correlation-ID": trace, ...extraHeaders };
  if (!anonymous) headers.Authorization = "Bearer " + (token ?? credentials[service]);
  if (service === "provider" && !anonymous) headers["X-Owner-ID"] = owner;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    headers["Idempotency-Key"] = trace + "_negative";
  }
  let response;
  try {
    response = await fetch(urls[service] + path, { method, headers,
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  } catch { throw new Error("Bounded HTTP request failed"); }
  expect((Array.isArray(expected) ? expected : [expected]).includes(response.status), `Unexpected ${service} HTTP status ${response.status}`);
  expect(response.headers.get("x-correlation-id") === trace, "Correlation response header mismatch");
  const raw = await response.text();
  expect(Buffer.byteLength(raw) <= 131072, "Response exceeded inspection bound");
  if (text) {
    expect(response.headers.get("content-type")?.startsWith("text/plain"), "Unexpected metrics content type");
    return raw;
  }
  let payload;
  try { payload = JSON.parse(raw); } catch { throw new Error("Non-JSON response"); }
  validate(service, method, path, response.status, payload);
  return { status: response.status, payload };
}

async function reference(base, file) {
  const url = new URL(base);
  expect(url.protocol === "https:" && !url.username && !url.password &&
    url.hostname === "raw.githubusercontent.com" &&
    /^\/Ntrakiyski\/workflow-agents\/[a-f0-9]{7,40}$/.test(url.pathname), "Reference requires an immutable repository commit URL");
  const response = await fetch(base + "/docs/phase1/" + file, { signal: AbortSignal.timeout(10000) });
  expect(response.ok, "Historical immutable reference unavailable");
  const raw = await response.text();
  expect(Buffer.byteLength(raw) <= 131072, "Historical reference exceeds inspection bound");
  return JSON.parse(raw);
}

async function events(service, id) {
  const path = service === "runner" ? `/v1/jobs/${id}/events` : `/v1/sandboxes/${id}/events`;
  const all = [];
  let cursor;
  for (let page = 0; page < 10; page++) {
    const { payload } = await request(service, "GET", path + (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""));
    all.push(...payload.events);
    if (!payload.next_cursor) break;
    expect(payload.next_cursor !== cursor && page < 9, "Audit pagination failed to terminate");
    cursor = payload.next_cursor;
  }
  expect(all.length > 0 && all.every(e => e.owner_id === identity.owner_id && e.actor_id && e.correlation_id && e.event_id),
    "Historical audit owner or identity is absent");
  const encoded = JSON.stringify(all);
  expect([credentials.runner, credentials.provider, other.token].every(v => !encoded.includes(v)), "Audit contains a configured credential");
  expect(!/"(?:arguments|stdout|stderr)"/.test(encoded), "Audit includes workload payload or output");
  return all;
}

async function main() {
  const auth = JSON.parse(process.env.RUNNER_AUTH_JSON);
  identity = auth.find(p => ["job:submit", "job:read"].every(s => p.permissions.includes(s)) &&
    p.workload_profiles.includes("fixture-write-file:v1") && !p.workload_profiles.includes("denied:v1"));
  expect(identity, "Historical fixture principal missing");
  other = auth.find(p => p.owner_id !== identity.owner_id && p.permissions.includes("job:read"));
  expect(other, "Second configured owner missing");
  credentials = { runner: identity.token, provider: process.env.SANDBOX_PROVIDER_TOKEN };
  expect(credentials.provider, "Provider delegation credential missing");
  urls = { runner: (process.env.QA_RUNNER_URL || `http://127.0.0.1:${process.env.PORT || 8080}`).replace(/\/$/, ""),
    provider: process.env.SANDBOX_PROVIDER_URL.replace(/\/$/, "") };
  const sourceBase = process.argv[2];
  history = await reference(sourceBase, "DEPLOYED-QA-EVIDENCE.json");
  const retained = await reference(sourceBase, "DEPLOYED-RETENTION-EVIDENCE.json");
  expect(history.error === null && history.runtime_kind === "unavailable", "Original historical evidence is not the expected unavailable-runtime run");
  for (const id of [history.resources.delayed_job_id, history.resources.runtime_job_id, history.provider_failed_sandbox_id])
    expect(typeof id === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(id), "Historical resource anchor malformed");
  stage = "health_auth_metrics";
  for (const service of ["runner", "provider"]) {
    const { payload: live } = await request(service, "GET", "/health/live", { anonymous: true });
    expect(live.status === "ok", "Liveness failed");
    const ready = await request(service, "GET", "/health/ready", { anonymous: true, expected: [200, 503] });
    expect(ready.payload.checks.database === "ok", "Database readiness failed");
    if (service === "runner") expect(ready.status === 200 && ready.payload.checks.queue === "ok", "Runner queue readiness failed");
    pass(service + ".health_contract", { readiness_http: ready.status, checks: ready.payload.checks,
      ...(service === "provider" ? { microvm_qualified: false, interpretation: "Prerequisites only; native create failed AppArmor userns preflight" } : {}) });
    const missing = service === "runner" ? "/v1/jobs/qa_missing" : "/v1/sandboxes/qa_missing";
    await request(service, "GET", missing, { anonymous: true, expected: 401 });
    await request(service, "GET", missing, { token: "qa_invalid_credential_000000000000", expected: 401 });
    await request(service, "GET", "/metrics", { anonymous: true, expected: 401 });
    await request(service, "GET", "/metrics", { text: true });
    pass(service + ".authentication_and_metrics");
  }
  stage = "schema_profile_negatives";
  const invalid = { workload: { profile: "denied:v1", arguments: {} },
    sandbox: { mode: "ensure", owner_ref: trace, profile: "denied:v1", persistent: true },
    limits: { max_duration_seconds: 1, max_attempts: 1 } };
  await request("runner", "POST", "/v1/jobs", { body: { ...invalid, unexpected: true }, expected: 422 });
  await request("runner", "POST", "/v1/jobs", { body: invalid, expected: 403 });
  await request("runner", "GET", "/v1/jobs/qa_missing", { extraHeaders: { "X-Owner-ID": other.owner_id }, expected: 403 });
  await request("provider", "POST", "/v1/sandboxes", { body: { owner_ref: trace, profile: "denied:v1", persistent: true, owner_id: "spoof" }, expected: 422 });
  await request("provider", "POST", "/v1/sandboxes", { body: { owner_ref: trace, profile: "denied:v1", persistent: true }, expected: 403 });
  pass("strict_schema_profile_denials_and_owner_spoof");
  stage = "historical_rows_and_audits";
  const anchors = [[history.resources.delayed_job_id, "cancelled", ["job.submitted", "job.cancelled"]],
    [history.resources.runtime_job_id, "timed_out", ["job.submitted", "job.dispatched", "job.timed_out"]]];
  for (const [id, status, required] of anchors) {
    const { payload: job } = await request("runner", "GET", "/v1/jobs/" + id);
    expect(job.status === status && job.attempt_count === 0, "Historical terminal job changed");
    const audits = await events("runner", id);
    expect(required.every(type => audits.some(e => e.type === type && e.correlation_id === history.correlation_id)), "Historical job audit anchor missing");
    await request("runner", "GET", "/v1/jobs/" + id, { token: other.token, expected: 404 });
    await request("runner", "GET", `/v1/jobs/${id}/events`, { token: other.token, expected: 404 });
    pass("historical_job_and_owner_denials", { job_id: id, status, event_ids: audits.map(e => e.event_id) });
  }
  const sid = history.provider_failed_sandbox_id;
  const { payload: box } = await request("provider", "GET", "/v1/sandboxes/" + sid);
  expect(box.status === "creating" && box.error?.code === "runtime_unavailable", "Historical sandbox creation intent changed");
  const audits = await events("provider", sid);
  const originalAudit = retained.before.result.first_audit_id;
  expect(typeof originalAudit === "string" && audits.some(e => e.event_id === originalAudit), "Original Provider audit ID missing");
  await request("provider", "GET", "/v1/sandboxes/" + sid, { owner: other.owner_id, expected: 404 });
  await request("provider", "GET", `/v1/sandboxes/${sid}/events`, { owner: other.owner_id, expected: 404 });
  pass("historical_sandbox_audit_and_owner_denials", { sandbox_id: sid, status: box.status, event_ids: audits.map(e => e.event_id), original_audit_id: originalAudit });
  stage = "cross_database_credential_denial";
  const target = process.env.QA_OTHER_DATABASE_TARGET || process.argv[3];
  expect(typeof target === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z_][A-Za-z0-9_]*$/.test(target), "Explicit target database host/name required");
  const [host, database] = target.split("/");
  const own = new URL(process.env.DATABASE_URL);
  expect(host !== own.hostname, "Cross-database target must differ from Runner database");
  const { Client } = require("pg");
  const client = new Client({ host, database, port: 5432, user: decodeURIComponent(own.username),
    password: decodeURIComponent(own.password), connectionTimeoutMillis: 10000, application_name: "phase1-readonly-auth-denial" });
  try { await client.connect(); }
  catch (error) { crossDbDenied = ["28P01", "28000"].includes(error.code); }
  finally { await client.end().catch(() => {}); }
  expect(crossDbDenied, "Runner credential was not explicitly denied by target database authentication");
  pass("cross_database_authentication_denial", { cross_db_denied: true });
  stage = "complete";
}

let error = null;
try { await main(); }
catch (failure) { error = failure instanceof assert.AssertionError ? failure.message : "Inspection could not complete its current stage"; }
console.log(JSON.stringify({ probe: "independent-migration-readonly-v1", correlation_id: trace, stage,
  outcome: error ? "failed" : "passed", checks, cross_db_denied: crossDbDenied,
  runtime_acceptance: "blocked-apparmor-userns; no microvm executed", error,
  side_effect_scope: "Read-only API/metrics inspection and fail-before-storage schema/profile negatives; one denied DB login; no accepted resource mutation, SDK call or SQL statement" }));
process.exitCode = error ? 1 : 0;
