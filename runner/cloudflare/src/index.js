import { Sandbox as BaseSandbox, getSandbox } from "@cloudflare/sandbox";

const API_VERSION = 2;
const MAX_SOURCE_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const EXECUTION_TIMEOUT_SECONDS = 8;
const REQUEST_OVERHEAD_BYTES = 8192;
const CONTROL_DIR = "/workspace/.quidra-playground-control";
const WORK_DIR = "/workspace/quidra-playground";
const SOURCE_PATH = `${WORK_DIR}/main.qui`;
const PROGRAM_PATH = `${WORK_DIR}/program`;
const STDOUT_PATH = `${CONTROL_DIR}/stdout.txt`;
const STDERR_PATH = `${CONTROL_DIR}/stderr.txt`;
const TIMEOUT_MARKER = `${CONTROL_DIR}/timed-out`;
const SCRIPT_PATH = `${CONTROL_DIR}/execute.sh`;

export class Sandbox extends BaseSandbox {
  enableInternet = false;
  interceptHttps = true;
}

function normaliseOrigin(value) {
  return String(value ?? "").replace(/\/+$/, "");
}

function originAllowed(request, env) {
  const origin = normaliseOrigin(request.headers.get("Origin"));
  const allowed = normaliseOrigin(env.QUIDRA_PLAYGROUND_ORIGIN);
  return origin === "" || allowed === "*" || origin === allowed;
}

function responseHeaders(request, env) {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  const origin = normaliseOrigin(request.headers.get("Origin"));
  const allowed = normaliseOrigin(env.QUIDRA_PLAYGROUND_ORIGIN);
  if (allowed === "*") {
    headers.set("Access-Control-Allow-Origin", "*");
  } else if (origin !== "" && origin === allowed) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
  }
  return headers;
}

function json(request, env, status, value) {
  return new Response(JSON.stringify(value) + "\n", {
    status,
    headers: responseHeaders(request, env),
  });
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function parseArgs(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 16) {
    throw new Error("args must be an array with at most 16 entries");
  }
  return value.map((item) => {
    if (typeof item !== "string") throw new Error("every argument must be a string");
    if (new TextEncoder().encode(item).length > 256 || item.includes("\0")) {
      throw new Error("each argument must be at most 256 bytes and contain no NUL");
    }
    return item;
  });
}

async function readBounded(sandbox, path) {
  const sizeResult = await sandbox.exec(`wc -c < ${shellQuote(path)}`, { timeout: 1000 });
  const size = Number.parseInt(sizeResult.stdout.trim(), 10);
  const dataResult = await sandbox.exec(
    `head -c ${MAX_OUTPUT_BYTES} ${shellQuote(path)}`,
    { timeout: 3000 },
  );
  return {
    text: dataResult.stdout,
    truncated: Number.isFinite(size) && size > MAX_OUTPUT_BYTES,
  };
}

function executionScript(operation, args) {
  const source = shellQuote(SOURCE_PATH);
  const output = shellQuote(PROGRAM_PATH);
  let quidra;
  if (operation === "build") {
    quidra = `/opt/quidra/bin/quidra build ${source} -o ${output}`;
  } else {
    const suffix = args.length === 0 ? "" : ` -- ${args.map(shellQuote).join(" ")}`;
    quidra = `/opt/quidra/bin/quidra run ${source}${suffix}`;
  }

  return `#!/bin/bash
set +e
rm -f ${shellQuote(TIMEOUT_MARKER)}
timeout --signal=TERM --kill-after=1s ${EXECUTION_TIMEOUT_SECONDS}s \
  env -i \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    HOME=${shellQuote(WORK_DIR)} TMPDIR=${shellQuote(WORK_DIR)} TMP=${shellQuote(WORK_DIR)} TEMP=${shellQuote(WORK_DIR)} \
    LC_ALL=C.UTF-8 \
    QUIDRA_CLANGXX=/usr/bin/clang++-15 QUIDRA_CLANG=/usr/bin/clang-15 QUIDRA_LLI=/usr/bin/lli-15 \
    QUIDRA_RUNTIME_LIBRARY=/opt/quidra/lib/quidra/libquidra_runtime.a \
    QUIDRA_JIT_RUNTIME_LIBRARY=/opt/quidra/lib/quidra/libquidra_runtime_jit.so \
    QUIDRA_RUNNER_UID=10001 QUIDRA_RUNNER_GID=10001 \
    /usr/bin/python3 /app/runner/limited_exec.py ${quidra} \
  >${shellQuote(STDOUT_PATH)} 2>${shellQuote(STDERR_PATH)}
code=$?
if [ "$code" -eq 124 ]; then
  : > ${shellQuote(TIMEOUT_MARKER)}
fi
exit "$code"
`;
}

async function executeInSandbox(env, operation, source, args) {
  const sandbox = getSandbox(env.Sandbox, `execution-${crypto.randomUUID()}`, {
    transport: "rpc",
    enableDefaultSession: false,
  });
  const started = Date.now();
  try {
    await sandbox.exec(
      `rm -rf ${shellQuote(CONTROL_DIR)} ${shellQuote(WORK_DIR)} && ` +
        `install -d -m 0700 ${shellQuote(CONTROL_DIR)} && ` +
        `install -d -m 0770 -o 10001 -g 10001 ${shellQuote(WORK_DIR)}`,
      { timeout: 2000 },
    );
    await sandbox.writeFile(SOURCE_PATH, source);
    await sandbox.writeFile(SCRIPT_PATH, executionScript(operation, args));
    await sandbox.exec(`chmod 0700 ${shellQuote(SCRIPT_PATH)}`, { timeout: 1000 });

    let execResult;
    try {
      execResult = await sandbox.exec(SCRIPT_PATH, {
        cwd: WORK_DIR,
        timeout: (EXECUTION_TIMEOUT_SECONDS + 3) * 1000,
      });
    } catch (error) {
      return {
        api_version: API_VERSION,
        operation,
        ok: false,
        exit_code: null,
        stdout: "",
        stderr: `Sandbox execution failed: ${error instanceof Error ? error.message : String(error)}`,
        stdout_truncated: false,
        stderr_truncated: false,
        elapsed_ms: Date.now() - started,
        timed_out: true,
        version: env.QUIDRA_VERSION || "unknown",
        core_commit: env.QUIDRA_CORE_COMMIT || "unknown",
      };
    }

    const [stdout, stderr, timeoutProbe] = await Promise.all([
      readBounded(sandbox, STDOUT_PATH),
      readBounded(sandbox, STDERR_PATH),
      sandbox.exec(`test -f ${shellQuote(TIMEOUT_MARKER)}`, { timeout: 1000 }),
    ]);
    const timedOut = timeoutProbe.success;
    const stderrText = timedOut
      ? (stderr.text ? `${stderr.text.replace(/\s+$/, "")}\n` : "") +
        `Timed out after ${EXECUTION_TIMEOUT_SECONDS}s.`
      : stderr.text;

    return {
      api_version: API_VERSION,
      operation,
      ok: !timedOut && execResult.exitCode === 0,
      exit_code: timedOut ? null : execResult.exitCode,
      stdout: stdout.text,
      stderr: stderrText,
      stdout_truncated: stdout.truncated,
      stderr_truncated: stderr.truncated,
      elapsed_ms: Date.now() - started,
      timed_out: timedOut,
      version: env.QUIDRA_VERSION || "unknown",
      core_commit: env.QUIDRA_CORE_COMMIT || "unknown",
    };
  } finally {
    try {
      await sandbox.destroy();
    } catch (error) {
      console.error("failed to destroy execution sandbox", error);
    }
  }
}

async function handleExecute(request, env) {
  if (!originAllowed(request, env)) {
    return json(request, env, 403, { error: "origin not allowed" });
  }
  const clientKey = request.headers.get("CF-Connecting-IP") || "unknown";
  const rate = await env.RUNNER_RATE_LIMIT.limit({ key: clientKey });
  if (!rate.success) {
    return json(request, env, 429, { error: "too many execution requests" });
  }
  if (request.headers.get("Content-Type")?.split(";", 1)[0].trim() !== "application/json") {
    return json(request, env, 415, { error: "expected application/json" });
  }

  const maximum = MAX_SOURCE_BYTES + REQUEST_OVERHEAD_BYTES;
  const declared = Number.parseInt(request.headers.get("Content-Length") || "0", 10);
  if (Number.isFinite(declared) && declared > maximum) {
    return json(request, env, 413, { error: `request exceeds ${maximum} bytes` });
  }

  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > maximum) {
    return json(request, env, 413, { error: `request exceeds ${maximum} bytes` });
  }

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(request, env, 400, { error: "request body must be JSON" });
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return json(request, env, 400, { error: "request body must be an object" });
  }

  const operation = body.operation;
  const source = body.source;
  if (operation !== "build" && operation !== "run") {
    return json(request, env, 400, { error: "operation must be 'build' or 'run'" });
  }
  if (typeof source !== "string") {
    return json(request, env, 400, { error: "source must be a string" });
  }
  if (new TextEncoder().encode(source).length > MAX_SOURCE_BYTES) {
    return json(request, env, 400, { error: `source exceeds ${MAX_SOURCE_BYTES} bytes` });
  }

  let args;
  try {
    args = parseArgs(body.args);
  } catch (error) {
    return json(request, env, 400, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (operation === "build" && args.length !== 0) {
    return json(request, env, 400, { error: "build does not accept program arguments" });
  }

  try {
    return json(request, env, 200, await executeInSandbox(env, operation, source, args));
  } catch (error) {
    console.error("runner infrastructure failure", error);
    return json(request, env, 500, { error: "runner infrastructure failure" });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS" && url.pathname === "/v2/execute") {
      if (!originAllowed(request, env)) {
        return json(request, env, 403, { error: "origin not allowed" });
      }
      const headers = responseHeaders(request, env);
      headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
      headers.set("Access-Control-Allow-Headers", "Content-Type");
      headers.set("Access-Control-Max-Age", "600");
      headers.delete("Content-Type");
      return new Response(null, { status: 204, headers });
    }

    if (request.method === "GET" && url.pathname === "/healthz") {
      return json(request, env, 200, {
        ok: Boolean(env.QUIDRA_CORE_COMMIT && env.QUIDRA_CORE_COMMIT !== "unknown"),
      });
    }

    if (request.method === "GET" && url.pathname === "/v2/meta") {
      if (!originAllowed(request, env)) {
        return json(request, env, 403, { error: "origin not allowed" });
      }
      return json(request, env, 200, {
        api_version: API_VERSION,
        operations: ["build", "run"],
        version: env.QUIDRA_VERSION || "unknown",
        core_commit: env.QUIDRA_CORE_COMMIT || "unknown",
        max_source_bytes: MAX_SOURCE_BYTES,
        timeout_seconds: EXECUTION_TIMEOUT_SECONDS,
      });
    }

    if (request.method === "POST" && url.pathname === "/v2/execute") {
      return handleExecute(request, env);
    }

    return json(request, env, 404, { error: "not found" });
  },
};
