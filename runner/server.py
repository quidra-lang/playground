#!/usr/bin/env python3
"""Quidra Playground remote Build/Run service.

This service never implements Quidra semantics. It writes the submitted source to
an isolated temporary directory and invokes the real `quidra build` / `quidra run`
commands. Production deployments must place the service itself in a hardened
sandbox with no secrets and no outbound network; see runner/README.md.
"""
from __future__ import annotations

import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

API_VERSION = 2
DEFAULT_MAX_SOURCE = 256 * 1024
DEFAULT_MAX_OUTPUT = 1024 * 1024
DEFAULT_TIMEOUT = 8.0
DEFAULT_CONCURRENCY = 2
MAX_ARGS = 16
MAX_ARG_BYTES = 256


def env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    raw = os.environ.get(name)
    if raw is None:
        return default
    value = int(raw)
    if not minimum <= value <= maximum:
        raise ValueError(f"{name} must be in {minimum}..{maximum}")
    return value


def env_float(name: str, default: float, minimum: float, maximum: float) -> float:
    raw = os.environ.get(name)
    if raw is None:
        return default
    value = float(raw)
    if not minimum <= value <= maximum:
        raise ValueError(f"{name} must be in {minimum}..{maximum}")
    return value


def discover_quidra(explicit: str | None = None) -> Path:
    candidate = explicit or os.environ.get("QUIDRA_BIN") or shutil.which("quidra")
    if not candidate:
        raise FileNotFoundError("set QUIDRA_BIN or put quidra on PATH")
    path = Path(candidate).expanduser().resolve()
    if not path.is_file():
        raise FileNotFoundError(f"Quidra executable not found: {path}")
    return path


def read_bounded(path: Path, maximum: int) -> tuple[str, bool]:
    with path.open("rb") as stream:
        data = stream.read(maximum + 1)
    truncated = len(data) > maximum
    return data[:maximum].decode("utf-8", errors="replace"), truncated


def parse_args(value: Any) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > MAX_ARGS:
        raise ValueError(f"args must be an array with at most {MAX_ARGS} entries")
    parsed: list[str] = []
    for item in value:
        if not isinstance(item, str):
            raise ValueError("every argument must be a string")
        if len(item.encode("utf-8")) > MAX_ARG_BYTES or "\x00" in item:
            raise ValueError(f"each argument must be at most {MAX_ARG_BYTES} bytes and contain no NUL")
        parsed.append(item)
    return parsed


def restricted_env(work: Path) -> dict[str, str]:
    # No credentials or host configuration are inherited. Only toolchain lookup
    # and loader paths required by the compiler survive.
    allowed = {
        "PATH",
        "LD_LIBRARY_PATH",
        "DYLD_LIBRARY_PATH",
        "DYLD_FALLBACK_LIBRARY_PATH",
        "QUIDRA_CLANGXX",
        "QUIDRA_CLANG",
        "QUIDRA_LLI",
        "QUIDRA_RUNTIME_LIBRARY",
        "QUIDRA_JIT_RUNTIME_LIBRARY",
        "QUIDRA_ORC_RUNTIME",
        "QUIDRA_COMPILER_RT_BUILTINS",
    }
    child = {key: value for key, value in os.environ.items() if key in allowed}
    child.update({
        "HOME": str(work),
        "TMPDIR": str(work),
        "TMP": str(work),
        "TEMP": str(work),
        "LC_ALL": "C.UTF-8",
    })
    return child


LIMITED_EXEC = Path(__file__).with_name("limited_exec.py")


class Runner:
    def __init__(self, executable: Path):
        self.executable = executable
        self.max_source = env_int("QUIDRA_RUNNER_MAX_SOURCE", DEFAULT_MAX_SOURCE, 1024, 1024 * 1024)
        self.max_output = env_int("QUIDRA_RUNNER_MAX_OUTPUT", DEFAULT_MAX_OUTPUT, 1024, 8 * 1024 * 1024)
        self.timeout = env_float("QUIDRA_RUNNER_TIMEOUT", DEFAULT_TIMEOUT, 0.1, 30.0)
        concurrency = env_int("QUIDRA_RUNNER_CONCURRENCY", DEFAULT_CONCURRENCY, 1, 16)
        self.slots = threading.BoundedSemaphore(concurrency)
        self.version = self._version()
        self.core_commit = os.environ.get("QUIDRA_CORE_COMMIT", "") or self._installed_commit()

    def _installed_commit(self) -> str:
        path = Path("/opt/quidra/share/quidra/core-commit")
        try:
            value = path.read_text(encoding="utf-8").strip()
        except OSError:
            return "unknown"
        return value or "unknown"

    def _version(self) -> str:
        try:
            result = subprocess.run(
                [str(self.executable), "--version"],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                timeout=3,
                check=False,
                env=restricted_env(Path(tempfile.gettempdir())),
            )
        except (OSError, subprocess.SubprocessError):
            return "unknown"
        value = result.stdout.decode("utf-8", errors="replace").strip()
        if not value:
            return "unknown"
        parts = value.split()
        if len(parts) >= 2 and parts[0].lower() == "quidra":
            return parts[1]
        return value

    def execute(self, operation: str, source: str, args: list[str]) -> dict[str, Any]:
        if operation not in {"build", "run"}:
            raise ValueError("operation must be 'build' or 'run'")
        encoded = source.encode("utf-8")
        if len(encoded) > self.max_source:
            raise ValueError(f"source exceeds {self.max_source} bytes")
        if operation == "build" and args:
            raise ValueError("build does not accept program arguments")

        with self.slots, tempfile.TemporaryDirectory(prefix="quidra-playground-runner-") as tmp:
            work = Path(tmp)
            source_path = work / "main.qui"
            output_path = work / "program"
            source_path.write_bytes(encoded)
            if operation == "build":
                command = [str(self.executable), "build", str(source_path), "-o", str(output_path)]
            else:
                command = [str(self.executable), "run", str(source_path)]
                if args:
                    command += ["--", *args]

            stdout_path = work / "stdout.txt"
            stderr_path = work / "stderr.txt"
            started = time.monotonic()
            with stdout_path.open("wb") as stdout_file, stderr_path.open("wb") as stderr_file:
                process = subprocess.Popen(
                    [sys.executable, str(LIMITED_EXEC), *command],
                    cwd=work,
                    env=restricted_env(work),
                    stdin=subprocess.DEVNULL,
                    stdout=stdout_file,
                    stderr=stderr_file,
                )
                timed_out = False
                try:
                    process.wait(timeout=self.timeout)
                except subprocess.TimeoutExpired:
                    timed_out = True
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except (ProcessLookupError, PermissionError):
                        if process.poll() is None:
                            process.kill()
                    process.wait()

            stdout, stdout_truncated = read_bounded(stdout_path, self.max_output)
            stderr, stderr_truncated = read_bounded(stderr_path, self.max_output)
            elapsed_ms = int((time.monotonic() - started) * 1000)
            if timed_out:
                suffix = f"Timed out after {self.timeout:g}s."
                stderr = f"{stderr}\n{suffix}" if stderr else suffix

            exit_code = None if timed_out else process.returncode
            return {
                "api_version": API_VERSION,
                "operation": operation,
                "ok": not timed_out and exit_code == 0,
                "exit_code": exit_code,
                "stdout": stdout,
                "stderr": stderr,
                "stdout_truncated": stdout_truncated,
                "stderr_truncated": stderr_truncated,
                "elapsed_ms": elapsed_ms,
                "timed_out": timed_out,
                "version": self.version,
                "core_commit": self.core_commit,
            }


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address: tuple[str, int], runner: Runner, allowed_origin: str):
        super().__init__(address, Handler)
        self.runner = runner
        self.allowed_origin = allowed_origin.rstrip("/")


class Handler(BaseHTTPRequestHandler):
    server_version = "QuidraPlaygroundRunner/2"

    @property
    def app(self) -> Server:
        return self.server  # type: ignore[return-value]

    def log_message(self, fmt: str, *args: object) -> None:
        print(f"[runner] {fmt % args}")

    def _origin_allowed(self) -> bool:
        origin = self.headers.get("Origin", "").rstrip("/")
        return not origin or self.app.allowed_origin == "*" or origin == self.app.allowed_origin

    def _cors(self) -> None:
        origin = self.headers.get("Origin", "").rstrip("/")
        if self.app.allowed_origin == "*":
            self.send_header("Access-Control-Allow-Origin", "*")
        elif origin == self.app.allowed_origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")

    def end_headers(self) -> None:
        self._cors()
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        super().end_headers()

    def do_OPTIONS(self) -> None:  # noqa: N802
        if self.path != "/v2/execute" or not self._origin_allowed():
            self.send_error(HTTPStatus.FORBIDDEN)
            return
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Max-Age", "600")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/healthz":
            self._json(HTTPStatus.OK, {"ok": True})
            return
        if self.path == "/v2/meta":
            if not self._origin_allowed():
                self._json(HTTPStatus.FORBIDDEN, {"error": "origin not allowed"})
                return
            runner = self.app.runner
            self._json(HTTPStatus.OK, {
                "api_version": API_VERSION,
                "operations": ["build", "run"],
                "version": runner.version,
                "core_commit": runner.core_commit,
                "max_source_bytes": runner.max_source,
                "timeout_seconds": runner.timeout,
            })
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/v2/execute":
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        if not self._origin_allowed():
            self._json(HTTPStatus.FORBIDDEN, {"error": "origin not allowed"})
            return
        if self.headers.get_content_type() != "application/json":
            self._json(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, {"error": "expected application/json"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            maximum = self.app.runner.max_source + 8192
            if not 1 <= length <= maximum:
                raise ValueError(f"request must be 1..{maximum} bytes")
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict):
                raise ValueError("request body must be an object")
            operation = body.get("operation")
            source = body.get("source")
            if not isinstance(operation, str) or not isinstance(source, str):
                raise ValueError("operation and source must be strings")
            args = parse_args(body.get("args"))
            result = self.app.runner.execute(operation, source, args)
        except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as error:
            self._json(HTTPStatus.BAD_REQUEST, {"error": str(error)})
            return
        except OSError as error:
            self._json(HTTPStatus.INTERNAL_SERVER_ERROR, {"error": str(error)})
            return
        self._json(HTTPStatus.OK, result)

    def _json(self, status: HTTPStatus, value: dict[str, Any]) -> None:
        data = (json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main() -> int:
    executable = discover_quidra()
    origin = os.environ.get("QUIDRA_PLAYGROUND_ORIGIN", "http://localhost:5173")
    host = os.environ.get("HOST", "0.0.0.0")
    port = env_int("PORT", 8080, 1, 65535)
    runner = Runner(executable)
    server = Server((host, port), runner, origin)
    print(f"Quidra Playground runner on http://{host}:{port}")
    print(f"Quidra: {runner.version}")
    print(f"Allowed origin: {origin}")
    try:
        server.serve_forever(0.2)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
