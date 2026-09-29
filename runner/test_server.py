from __future__ import annotations

import json
import stat
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from runner.server import Runner, Server, parse_args


FAKE = r'''#!/usr/bin/env python3
import pathlib, sys
if sys.argv[1:] == ["--version"]:
    print("Quidra 0.test")
    raise SystemExit(0)
cmd = sys.argv[1]
source = pathlib.Path(sys.argv[2]).read_text()
if "compile_error" in source:
    print("compile failed", file=sys.stderr)
    raise SystemExit(2)
if cmd == "build":
    out = pathlib.Path(sys.argv[sys.argv.index("-o") + 1])
    out.write_text("artifact")
    raise SystemExit(0)
if cmd == "run":
    args = sys.argv[4:] if len(sys.argv) > 3 and sys.argv[3] == "--" else []
    print("ran:" + source.strip())
    print("args:" + ",".join(args))
    raise SystemExit(0)
raise SystemExit(3)
'''


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        fake = Path(self.tmp.name) / "quidra"
        fake.write_text(FAKE)
        fake.chmod(fake.stat().st_mode | stat.S_IXUSR)
        self.runner = Runner(fake)

    def tearDown(self):
        self.tmp.cleanup()

    def test_build_uses_real_cli_contract(self):
        result = self.runner.execute("build", 'print("x")\n', [])
        self.assertTrue(result["ok"])
        self.assertEqual(result["operation"], "build")
        self.assertEqual(result["version"], "0.test")

    def test_run_returns_stdout_and_arguments(self):
        result = self.runner.execute("run", "hello\n", ["a", "b"])
        self.assertTrue(result["ok"])
        self.assertIn("ran:hello", result["stdout"])
        self.assertIn("args:a,b", result["stdout"])

    def test_compile_failure_is_data(self):
        result = self.runner.execute("run", "compile_error\n", [])
        self.assertFalse(result["ok"])
        self.assertEqual(result["exit_code"], 2)
        self.assertIn("compile failed", result["stderr"])

    def test_argument_limits(self):
        with self.assertRaises(ValueError):
            parse_args(["x"] * 17)
        with self.assertRaises(ValueError):
            parse_args(["x" * 257])


class HttpTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        fake = Path(self.tmp.name) / "quidra"
        fake.write_text(FAKE)
        fake.chmod(fake.stat().st_mode | stat.S_IXUSR)
        self.server = Server(("127.0.0.1", 0), Runner(fake), "https://play.example")
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.tmp.cleanup()

    def request(self, path, *, method="GET", body=None, origin="https://play.example"):
        headers = {"Origin": origin}
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(self.base + path, data=data, headers=headers, method=method)
        with urllib.request.urlopen(req) as response:
            return response.status, dict(response.headers), json.loads(response.read())

    def test_meta_reports_runner_capabilities(self):
        status, headers, body = self.request("/v2/meta")
        self.assertEqual(status, 200)
        self.assertEqual(body["operations"], ["build", "run"])
        self.assertEqual(body["version"], "0.test")
        self.assertEqual(headers["Access-Control-Allow-Origin"], "https://play.example")

    def test_execute_run(self):
        status, _, body = self.request("/v2/execute", method="POST", body={
            "operation": "run", "source": "hello\n", "args": ["z"]
        })
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertIn("args:z", body["stdout"])

    def test_rejects_other_origin(self):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            self.request("/v2/meta", origin="https://evil.example")
        self.assertEqual(caught.exception.code, 403)


if __name__ == "__main__":
    unittest.main()
