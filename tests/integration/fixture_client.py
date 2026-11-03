#!/usr/bin/env python3
"""An external generic v1 consumer. Uses only HTTP and published wire schemas.

No service imports or database access. Credentials are environment variables.
Exit 2 means a prerequisite is blocked, never a successful real-runtime test.
"""
import argparse
import json
import os
from pathlib import Path
import sys
import time
import urllib.error
import urllib.request
import uuid

from jsonschema import Draft202012Validator, FormatChecker

ROOT = Path(__file__).resolve().parents[2]
TERMINAL = {"completed", "failed", "cancelled", "timed_out"}


class Client:
    def __init__(self, service, url, token, owner=None):
        self.service, self.url, self.token, self.owner = service, url.rstrip("/"), token, owner
        self.contract = json.loads((ROOT / "contracts" / "v1" / f"{service}-v1.openapi.json").read_text())
        self.correlation = "fixture-" + uuid.uuid4().hex
        self.calls = 0

    def call(self, method, path, template=None, body=None, key=None, expected=200, token=None):
        headers = {"Authorization": "Bearer " + (self.token if token is None else token),
                   "Content-Type": "application/json", "X-Correlation-ID": self.correlation}
        if self.owner:
            headers["X-Owner-ID"] = self.owner
        if key:
            headers["Idempotency-Key"] = key
        request = urllib.request.Request(self.url + path, data=None if body is None else json.dumps(body).encode(),
                                         headers=headers, method=method)
        try:
            response = urllib.request.urlopen(request, timeout=30)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            status, data = response.code, json.loads(response.read(131072))
            assert response.headers.get("X-Correlation-ID") == self.correlation, "Missing response correlation header"
        assert status == expected, f"{self.service} {method} {template or path}: HTTP {status}, expected {expected}; code={data.get('code')}"
        schema = self.contract["paths"][template or path][method.lower()]["responses"][str(status)]["content"]["application/json"]["schema"]
        # Local references resolve within an embedded root; no network schema fetch.
        root = {"$ref": "#/response", "response": schema, "components": self.contract["components"]}
        Draft202012Validator(root, format_checker=FormatChecker()).validate(data)
        self.calls += 1
        return data

    def wait(self, path, template, statuses=TERMINAL, budget=150):
        deadline = time.monotonic() + budget
        while time.monotonic() < deadline:
            resource = self.call("GET", path, template)
            if resource["status"] in statuses:
                return resource
            time.sleep(.25)
        raise AssertionError(f"Timed out waiting for {self.service} {template}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--allow-mocked-runtime", action="store_true", help="Label output mocked; cannot pass real BoxLite gate")
    parser.add_argument("--keep-sandbox", action="store_true", help="Retain the first disposable sandbox for a restart check")
    parser.add_argument("--state-file", type=Path, help="Write safe IDs for restart/recovery verification")
    parser.add_argument("--recover", action="store_true", help="Read state-file after independently restarting services")
    args = parser.parse_args()
    runner = Client("runner", os.environ["RUNNER_URL"], os.environ["RUNNER_TOKEN"])
    provider = Client("provider", os.environ["PROVIDER_URL"], os.environ["PROVIDER_TOKEN"], os.environ.get("PROVIDER_OWNER_ID"))
    provider.correlation = runner.correlation
    evidence = {"mode": "mocked-runtime" if args.allow_mocked_runtime else "real-boxlite-required", "correlation_id": runner.correlation, "checks": []}

    def check(label):
        evidence["checks"].append(label)
        print(json.dumps({"check": label, "outcome": "passed", "mode": evidence["mode"]}), flush=True)

    health = provider.call("GET", "/health/ready", expected=200 if args.allow_mocked_runtime else 200)
    assert health["checks"].get("runtime") == "ok", "Provider runtime readiness unavailable"
    runner.call("GET", "/health/ready")
    check("health and strict response contracts")
    suffix = uuid.uuid4().hex
    marker = "hello-world-" + suffix
    filename = "hello-world.txt"

    def submission(workload, sandbox):
        return {"client_reference": "generic-fixture-" + suffix, "workload": workload,
                "sandbox": sandbox, "limits": {"max_duration_seconds": 30, "max_attempts": 2}}

    if args.recover:
        assert args.state_file, "--recover requires --state-file"
        saved = json.loads(args.state_file.read_text())
        sid, marker, filename = saved["sandbox_id"], saved["marker"], saved["filename"]
        old = runner.call("GET", "/v1/jobs/" + saved["job_id"], "/v1/jobs/{job_id}")
        assert old["status"] == "completed" and old["sandbox_id"] == sid
        provider.call("POST", f"/v1/sandboxes/{sid}/start", "/v1/sandboxes/{sandbox_id}/start", {})
        resumed = runner.call("POST", f"/v1/jobs/{old['job_id']}/resume", "/v1/jobs/{job_id}/resume",
                              {"workload": {"profile": "fixture-read-file:v1", "arguments": {"file": filename}},
                               "limits": {"max_duration_seconds": 30, "max_attempts": 1}}, key="recover-" + suffix, expected=202)
        job = runner.wait("/v1/jobs/" + resumed["job_id"], "/v1/jobs/{job_id}")
        assert job["status"] == "completed" and job["result"]["stdout"] == marker, "Retained marker missing after service restart"
        check("service restart preserved durable job and same sandbox filesystem")
    else:
        workload = {"profile": "fixture-write-file:v1", "arguments": {"file": filename, "text": marker}}
        body = submission(workload, {"mode": "ensure", "owner_ref": "fixture-" + suffix, "profile": "minimal-linux:v1", "persistent": True})
        job = runner.call("POST", "/v1/jobs", body=body, key=suffix, expected=202)
        repeated = runner.call("POST", "/v1/jobs", body=body, key=suffix, expected=202)
        assert repeated["job_id"] == job["job_id"], "Duplicate submission created a second job"
        changed = json.loads(json.dumps(body)); changed["workload"]["arguments"]["text"] = "changed"
        runner.call("POST", "/v1/jobs", body=changed, key=suffix, expected=409)
        check("duplicate submission and changed-payload conflict")
        job = runner.wait("/v1/jobs/" + job["job_id"], "/v1/jobs/{job_id}")
        assert job["status"] == "completed" and job["result"]["exit_code"] == 0, "Generic write job failed"
        sid = job["sandbox_id"]
        check("Runner queued generic workload through Provider HTTP")
        schedule = runner.call("POST", "/v1/schedules", body={"run_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time()+2)), "action": "stop_sandbox", "sandbox_id": sid}, key="stop-" + suffix, expected=201)
        schedule = runner.wait("/v1/schedules/" + schedule["schedule_id"], "/v1/schedules/{schedule_id}", {"fired", "failed", "skipped", "cancelled"})
        assert schedule["status"] == "fired", "Delayed stop did not fire"
        box = provider.call("GET", f"/v1/sandboxes/{sid}", "/v1/sandboxes/{sandbox_id}")
        assert box["status"] == "stopped", "Stop schedule did not stop sandbox"
        provider.call("POST", f"/v1/sandboxes/{sid}/start", "/v1/sandboxes/{sandbox_id}/start", {})
        resumed = runner.call("POST", f"/v1/jobs/{job['job_id']}/resume", "/v1/jobs/{job_id}/resume",
                              {"workload": {"profile": "fixture-read-file:v1", "arguments": {"file": filename}},
                               "limits": {"max_duration_seconds": 30, "max_attempts": 1}}, key="read-" + suffix, expected=202)
        read_job = runner.wait("/v1/jobs/" + resumed["job_id"], "/v1/jobs/{job_id}")
        assert read_job["status"] == "completed" and read_job["sandbox_id"] == sid and read_job["result"]["stdout"] == marker
        check("non-destructive delayed stop, same sandbox restart and retained marker")
        provider.call("POST", f"/v1/sandboxes/{sid}/execute", "/v1/sandboxes/{sandbox_id}/execute",
                      {"execution_ref": "denied-" + suffix, "profile": "unapproved:v1", "arguments": {}, "timeout_seconds": 5}, key="denied-" + suffix, expected=403)
        runner.call("GET", "/v1/jobs/" + job["job_id"], "/v1/jobs/{job_id}", token="invalid-fixture-token", expected=401)
        check("unauthorized credential and denied workload")
        second = provider.call("POST", "/v1/sandboxes", body={"owner_ref": "isolation-"+suffix,"profile":"minimal-linux:v1","persistent":True}, key="isolation-"+suffix, expected=201)
        sid2 = second["sandbox_id"]
        missing = provider.call("POST", f"/v1/sandboxes/{sid2}/execute", "/v1/sandboxes/{sandbox_id}/execute",
                                {"execution_ref":"isolation-"+suffix,"profile":"fixture-read-file:v1","arguments":{"file":filename},"timeout_seconds":10}, key="isolation-read-"+suffix, expected=202)
        missing = provider.wait(f"/v1/sandboxes/{sid2}/runs/{missing['run_id']}", "/v1/sandboxes/{sandbox_id}/runs/{run_id}")
        assert missing["status"] == "failed" and missing["result"]["exit_code"] != 0
        provider.call("POST", f"/v1/sandboxes/{sid2}/destroy", "/v1/sandboxes/{sandbox_id}/destroy", {"confirm":True,"reason":"Disposable integration fixture cleanup"})
        check("two sandbox filesystem isolation and explicit destruction")

    events = runner.call("GET", "/v1/jobs/"+job["job_id"]+"/events", "/v1/jobs/{job_id}/events")
    assert any(e["type"] == "job.completed" for e in events["events"]), "Missing completion audit"
    events = provider.call("GET", f"/v1/sandboxes/{sid}/events", "/v1/sandboxes/{sandbox_id}/events")
    assert any(e["type"] == "run.completed" for e in events["events"]), "Missing Provider execution audit"
    assert all(e.get("owner_id") and e.get("actor_id") for e in events["events"])
    check("durable actor and owner audit events through published APIs")
    if args.state_file:
        args.state_file.write_text(json.dumps({"job_id":job["job_id"],"sandbox_id":sid,"marker":marker,"filename":filename},indent=2)+"\n")
    if args.keep_sandbox:
        provider.call("POST", f"/v1/sandboxes/{sid}/stop", "/v1/sandboxes/{sandbox_id}/stop", {})
    else:
        provider.call("POST", f"/v1/sandboxes/{sid}/destroy", "/v1/sandboxes/{sandbox_id}/destroy", {"confirm":True,"reason":"Disposable integration fixture cleanup"})
    evidence.update({"outcome":"passed","runner_http_calls":runner.calls,"provider_http_calls":provider.calls})
    print(json.dumps(evidence,indent=2))


if __name__ == "__main__":
    try:
        main()
    except (urllib.error.URLError, KeyError) as error:
        print(json.dumps({"outcome":"blocked","reason":type(error).__name__,"detail":"Required endpoint/configuration unavailable"}),file=sys.stderr)
        sys.exit(2)
    except Exception as error:
        print(json.dumps({"outcome":"failed","reason":str(error)}),file=sys.stderr)
        sys.exit(1)
