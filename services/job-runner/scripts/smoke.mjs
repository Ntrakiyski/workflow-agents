// Read-only internal connectivity probe. Credentials are read from runtime env.
const provider = process.env.SANDBOX_PROVIDER_URL;
const runner =
  process.env.RUNNER_URL ?? `http://127.0.0.1:${process.env.PORT ?? "8080"}`;
const results = [];
for (const [service, endpoint] of [
  ["job-runner", runner],
  ["sandbox-provider", provider],
]) {
  if (!endpoint) throw new Error("Missing configured service endpoint");
  for (const kind of ["live", "ready"]) {
    try {
      const response = await fetch(`${endpoint}/health/${kind}`, {
        signal: AbortSignal.timeout(5000),
      });
      const body = await response.json();
      results.push({
        service,
        check: kind,
        status_code: response.status,
        status: body.status,
        version: body.version,
        checks: body.checks,
      });
    } catch {
      results.push({ service, check: kind, status: "unreachable" });
    }
  }
}
console.log(JSON.stringify({ service: "phase1-probe", results }));
if (results.some((result) => result.check === "live" && result.status !== "ok"))
  process.exitCode = 1;
