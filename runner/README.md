# Quidra Playground runner

This is the execution half of the public Playground. It does **not** implement a
second Quidra interpreter. Every request is written to a temporary `main.qui`
and delegated to the native Quidra CLI:

- `build` -> `quidra build main.qui -o program`
- `run` -> `quidra run main.qui`

The generated executable and source directory are deleted after the request.
The HTTP response contains only exit status, stdout/stderr, timing and the exact
compiler identity.

## Run locally

Build Quidra first, then:

```bash
QUIDRA_BIN=../quidra/build/quidra \
QUIDRA_CORE_COMMIT="$(git -C ../quidra rev-parse HEAD)" \
QUIDRA_PLAYGROUND_ORIGIN=http://localhost:5173 \
python3 -m runner.server
```

Then start the frontend with:

```bash
VITE_QUIDRA_RUNNER_URL=http://localhost:8080 npm run dev
```

The frontend refuses Build/Run when either the runner's `version` or
`core_commit` differs from the WebAssembly frontend's language version or Core
commit. That prevents a Playground page from checking with one Quidra revision
and executing with another.

## Container

`runner/Dockerfile` builds the native compiler from `QUIDRA_CORE_REF` and records
the resolved Core SHA in the image. Example:

```bash
docker build -f runner/Dockerfile \
  --build-arg QUIDRA_CORE_REF=develop \
  -t quidra-playground-runner .

docker run --rm -p 8080:8080 \
  -e QUIDRA_PLAYGROUND_ORIGIN=http://localhost:5173 \
  quidra-playground-runner
```

## Production isolation

The service executes untrusted native code. The process limits in `limited_exec.py`
are defense in depth, **not** a security boundary. Do not expose a plain Docker
container directly to the Internet.

A production deployment must put every runner instance inside a sandboxed
container/microVM boundary and enforce at least:

- no credentials, cloud metadata access, Docker socket, host mounts or other
  secrets in the runner;
- outbound network denied for executed programs;
- read-only root filesystem, with only the per-request temporary directory
  writable;
- non-privileged execution, no host PID namespace, no host IPC namespace and no
  device access;
- memory/CPU/process/file limits at the container or microVM layer in addition
  to the per-process limits here;
- request rate limiting and an upper bound on concurrent instances at the edge;
- automatic destruction/recycling of the sandbox after untrusted execution.

Set `QUIDRA_PLAYGROUND_ORIGIN` to the page's browser origin (for GitHub Pages,
`https://quidra-lang.github.io`, without `/playground/`). CORS only limits browser
callers. It is not authentication and is not a sandbox.

### Cloudflare Sandbox

The production adapter in [`cloudflare/`](cloudflare/) satisfies the isolation
boundary above with Cloudflare Sandbox VMs. It creates a fresh Sandbox for every
Build/Run, sets `enableInternet = false`, rate-limits requests at the Worker,
drops the Quidra child process to uid/gid 10001, and destroys the Sandbox in a
`finally` block. The deploy workflow injects the same exact Core SHA into both
the Sandbox image and the API metadata.

The generic Python HTTP runner remains useful for local development and for
other hardened microVM/container platforms. It should not be exposed directly
as the public security boundary.

## API

`GET /v2/meta` reports `api_version`, the plain `MAJOR.MINOR.PATCH` language
`version`, supported operations, source limits, and the exact Core commit.

`POST /v2/execute` accepts:

```json
{"operation":"run","source":"print(42)\nprint(NL)\n","args":[]}
```

`operation` is `build` or `run`. `args` is optional and is accepted only for
`run`.
