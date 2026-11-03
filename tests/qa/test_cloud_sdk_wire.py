"""Installed SDK to loopback HTTP stub only; never Cloud or microVM evidence.

Run with the Provider QA venv. The token is an inert local test value. These
tests do not import Provider code and independently observe SDK0.11.0 wire
lifecycle semantics, exact resource/retention intent and failure retries.
"""
import asyncio
import json
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import boxlite


class CloudWire(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.calls = []
        self.state = "configured"
        self.create_error = False
        self.create_delay = 0
        self.identity_mismatch = False
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def handle_request(self):
                length = int(self.headers.get("Content-Length", 0))
                raw = self.rfile.read(length) if length else b""
                body = json.loads(raw) if raw else None
                outer.calls.append((self.command, self.path, body, self.headers.get("Authorization")))
                status, result = 200, outer.info()
                if self.path == "/v1/config":
                    result = {"capabilities": {}}
                elif self.path.endswith("/start"):
                    outer.state = "running"
                    result = outer.info()
                elif self.path.endswith("/stop"):
                    outer.state = "stopped"
                    result = outer.info()
                elif self.command == "POST" and self.path == "/v1/qa-scope/boxes":
                    time.sleep(outer.create_delay)
                    if outer.create_error:
                        status, result = 503, {"message": "local injected create failure", "code": "unavailable"}
                elif self.command == "DELETE":
                    status, result = 204, None
                if outer.identity_mismatch and self.path.endswith("/start"):
                    result["box_id"] = "unexpected-replacement-id"
                encoded = b"" if result is None else json.dumps(result).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                try:
                    self.wfile.write(encoded)
                except (BrokenPipeError, ConnectionResetError):
                    pass  # Deliberately cancelled request in the ambiguity test.

            do_GET = do_POST = do_DELETE = handle_request

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.runtime = boxlite.Boxlite.rest(boxlite.BoxliteRestOptions(
            url="http://127.0.0.1:" + str(self.server.server_address[1]),
            credential=boxlite.ApiKeyCredential("qa-loopback-inert-credential"), path_prefix="qa-scope"))

    def info(self):
        return {"box_id": "cloud-wire-box-identity", "name": "qa-wire", "status": self.state,
                "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z",
                "pid": None, "image": "python", "cpus": 1, "memory_mib": 256, "labels": {},
                "auto_stop": 0, "auto_delete": 0, "auto_resume": False}

    def options(self, **overrides):
        values = {"image": "python", "cpus": 1, "memory_mib": 256, "disk_size_gb": 1,
                  "auto_remove": False, "auto_stop": 0, "auto_delete": 0, "auto_resume": False,
                  "detach": True, "network": boxlite.NetworkSpec(
                      outbound=boxlite.OutboundNetworkSpec(mode="disabled"),
                      inbound=boxlite.InboundNetworkSpec(mode="disabled"))}
        values.update(overrides)
        return boxlite.BoxOptions(**values)

    def tearDown(self):
        self.runtime.close()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    async def test_explicit_retention_resources_network_and_stop_are_sent_without_delete(self):
        self.assertEqual(boxlite.__version__, "0.11.0")
        box = await self.runtime.create(self.options(), name="qa-wire")
        await box.start()
        await box.stop()
        info = await self.runtime.get_info("cloud-wire-box-identity")
        self.assertEqual(info.id, "cloud-wire-box-identity")
        self.assertEqual(info.auto_delete, 0)
        self.assertEqual(info.auto_stop, 0)
        self.assertFalse(info.auto_resume)
        self.runtime.close()
        mutations = [(method, path, body) for method, path, body, _ in self.calls if method != "GET"]
        self.assertEqual([x[:2] for x in mutations], [
            ("POST", "/v1/qa-scope/boxes"),
            ("POST", "/v1/qa-scope/boxes/cloud-wire-box-identity/start"),
            ("POST", "/v1/qa-scope/boxes/cloud-wire-box-identity/stop")])
        sent = mutations[0][2]
        for key, value in {"name": "qa-wire", "image": "python", "cpus": 1, "memory_mib": 256,
                           "disk_size_gb": 1, "auto_stop": 0, "auto_delete": 0, "auto_resume": False,
                           "detach": True}.items():
            self.assertEqual(sent[key], value, key)
        # With both directions disabled the SDK uses its documented legacy
        # outbound representation; it must not mean enabled+empty allowlist.
        self.assertEqual(sent["network"], {"mode": "disabled"})
        self.assertTrue(all(auth == "Bearer qa-loopback-inert-credential" for _, _, _, auth in self.calls))
        self.assertFalse(any("qa-loopback-inert-credential" in path for _, path, _, _ in self.calls))

    async def test_auto_remove_false_alone_does_not_send_explicit_cloud_retention(self):
        await self.runtime.create(boxlite.BoxOptions(image="python", auto_remove=False), name="qa-wire")
        sent = next(body for method, path, body, _ in self.calls if method == "POST" and path.endswith("/boxes"))
        self.assertNotIn("auto_remove", sent)
        self.assertNotIn("auto_delete", sent)

    async def test_create_server_failure_is_not_automatically_replayed(self):
        self.create_error = True
        with self.assertRaises(Exception):
            await asyncio.wait_for(self.runtime.create(self.options(), name="qa-wire"), timeout=5)
        self.assertEqual(sum(method == "POST" and path.endswith("/boxes") for method, path, _, _ in self.calls), 1)

    async def test_timeout_after_create_transmission_requires_lookup_not_another_create(self):
        self.create_delay = .5
        with self.assertRaises(TimeoutError):
            await asyncio.wait_for(self.runtime.create(self.options(), name="qa-wire"), timeout=.15)
        self.assertEqual(sum(method == "POST" and path.endswith("/boxes") for method, path, _, _ in self.calls), 1)
        # The independent stub has committed its identity before withholding
        # the reply. A timed-out client therefore cannot infer no allocation.
        found = await self.runtime.get_info("qa-wire")
        self.assertEqual(found.id, "cloud-wire-box-identity")
        self.assertEqual(sum(method == "POST" and path.endswith("/boxes") for method, path, _, _ in self.calls), 1)

    async def test_handle_rejects_changed_runtime_identity_and_explicit_remove_uses_delete(self):
        box = await self.runtime.create(self.options(), name="qa-wire")
        self.identity_mismatch = True
        with self.assertRaises(Exception):
            await box.start()
        self.identity_mismatch = False
        await self.runtime.remove("cloud-wire-box-identity", force=False)
        self.assertEqual(sum(method == "DELETE" for method, _, _, _ in self.calls), 1)
        self.assertIn(("DELETE", "/v1/qa-scope/boxes/cloud-wire-box-identity"),
                      [(method, path) for method, path, _, _ in self.calls])


if __name__ == "__main__":
    unittest.main(verbosity=2)
