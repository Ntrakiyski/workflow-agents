import { test } from "node:test";
import assert from "node:assert/strict";
import { canonical, fingerprint, validate } from "../src/validation.js";
import { authenticate, loadConfig, validId } from "../src/config.js";
import { ApiError } from "../src/errors.js";
import { config, headers, submission } from "./helpers.js";

test("canonical idempotency is recursive, stable, and rejects nonfinite JSON", () => {
  assert.equal(
    canonical({ z: 1, a: { d: 2, b: 3 } }),
    '{"a":{"b":3,"d":2},"z":1}',
  );
  assert.equal(fingerprint({ a: 1, b: 2 }), fingerprint({ b: 2, a: 1 }));
  assert.throws(() => canonical(NaN), ApiError);
});
test("frozen contract rejects shell overrides, malformed dates, and invalid schedule shapes", () => {
  const j = submission();
  validate("runner", "JobSubmission", j);
  assert.throws(
    () => validate("runner", "JobSubmission", { ...j, command: "sh" }),
    ApiError,
  );
  assert.throws(
    () => validate("runner", "JobSubmission", { ...j, run_at: "tomorrow" }),
    ApiError,
  );
  assert.throws(
    () =>
      validate("runner", "ScheduleSubmission", {
        action: "stop_sandbox",
        run_at: new Date().toISOString(),
        sandbox_id: "sbx_1",
        job_id: "job_1",
      }),
    ApiError,
  );
});
test("credentials and bounded identifiers are enforced", () => {
  const c = config("postgresql://unused");
  assert.equal(
    authenticate(c, headers.authorization).owner_id,
    "fixture-owner",
  );
  assert.throws(() => authenticate(c, "Bearer bad"), ApiError);
  assert.throws(() => authenticate(c, undefined), ApiError);
  assert.equal(validId("injected\nheader"), false);
  assert.equal(validId("a".repeat(129)), false);
});
test("startup fails closed for absent/invalid external configuration", () => {
  assert.throws(() => loadConfig({}), /Missing RUNNER_AUTH_JSON/);
  const c = config("postgresql://unused");
  const env = {
    RUNNER_AUTH_JSON: JSON.stringify(c.auth),
    RUNNER_PROFILES_JSON: JSON.stringify(c.profiles),
    DATABASE_URL: c.databaseUrl,
    SANDBOX_PROVIDER_URL: c.providerUrl,
    SANDBOX_PROVIDER_TOKEN: c.providerToken,
  };
  assert.equal(loadConfig(env).maxGlobalConcurrency, 2);
  assert.throws(
    () => loadConfig({ ...env, QUEUE_CONCURRENCY: "0" }),
    /Invalid QUEUE_CONCURRENCY/,
  );
});
