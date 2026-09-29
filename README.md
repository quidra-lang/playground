# Quidra Playground

The official [Quidra](https://github.com/quidra-lang/quidra) playground.

The page keeps Quidra's compiler frontend in WebAssembly for fast local tooling,
and uses a separate native runner for the two operations that cannot honestly be
implemented by the frontend alone:

| Operation | Execution path |
| --- | --- |
| **Check** | Browser-local Quidra Core WebAssembly |
| **Format** | Browser-local Quidra Core WebAssembly |
| **IR** | Browser-local Quidra Core WebAssembly |
| **Inspect** | Browser-local Quidra Core WebAssembly |
| **Patch** | Browser-local Quidra Core WebAssembly |
| **Build** | Native runner -> real `quidra build` -> LLVM/native linker/runtime |
| **Run** | Native runner -> real `quidra run` -> LLVM/native linker/runtime |

There is still no second Quidra interpreter in this repository.

## Build and Run

Build/Run are intentionally separate from the WebAssembly frontend. Quidra's
native semantics depend on LLVM, the native runtime archive and OS process
facilities; pretending those exist in the browser would create a second
execution engine with different behaviour.

Instead, the browser sends the source to the runner **only when Build or Run is
pressed**. The runner writes a temporary `main.qui`, invokes the real native
Quidra CLI, captures stdout/stderr and destroys the temporary directory.

The page refuses to enable Build/Run unless the runner reports the same
language version and exact same Core commit as the loaded WebAssembly compiler.
A stale runner therefore fails
closed instead of executing source under a different language revision.

The runner implementation and deployment requirements are documented in
[`runner/README.md`](runner/README.md).

## Architecture

```
editor
  |
  +-- Check / Format / IR / Inspect / Patch
  |       |
  |       v
  |   Web Worker
  |       |
  |       v
  |   quidra-core.wasm
  |       |
  |       v
  |   Quidra Core frontend
  |
  +-- Build / Run (explicit only)
          |
          v
      HTTPS runner API
          |
          +-- quidra build main.qui -o program
          |
          +-- quidra run main.qui
                  |
                  v
            LLVM + native runtime
```

The WebAssembly bridge remains frontend-only and exposes:

```c
char* quidra_wasm_invoke(const char* request_json);
void  quidra_wasm_free(char* result);
```

Its request/response schema is independent of the runner API schema.

## Privacy

Check, Format, IR, Inspect and Patch remain entirely in the browser. Their source
never leaves the page.

Build and Run necessarily send the current source to the configured native
runner. The provided runner does not log source, stores it only in a
per-request temporary directory and removes that directory after completion.

## Version identity

The Playground has no independent language version. `project.toml` in Quidra
Core remains the source of truth.

At page build time, `scripts/prepare-core.mjs` records the exact Core SHA and
builds the WebAssembly frontend from it. The deployment workflow builds the
runner image from that **same SHA** and tags it both as `main` and
`core-<sha>`.

At runtime, the page compares both the language version and Core SHA reported by
the WebAssembly module with `GET /v2/meta` from the runner. Build/Run stay
disabled on any mismatch.

## Local development

Frontend tooling requires Node 20+, CMake and Emscripten. Cloudflare runner deployment requires Node 22+ (CI uses Node 24):

```bash
npm install
QUIDRA_CORE_DIR=../quidra npm run core:build
npm run dev
```

To use native Build/Run locally, build Quidra and start the runner in another
terminal:

```bash
QUIDRA_BIN=../quidra/build/quidra \
QUIDRA_CORE_COMMIT="$(git -C ../quidra rev-parse HEAD)" \
QUIDRA_PLAYGROUND_ORIGIN=http://localhost:5173 \
python3 -m runner.server
```

Then start Vite with the runner URL:

```bash
VITE_QUIDRA_RUNNER_URL=http://localhost:8080 npm run dev
```

The Core checkout used for `npm run core:build` and the runner must report the
same language version and resolve to the same commit or Build/Run will remain
disabled.

## Tests

```bash
npm run typecheck
npm test
npm run test:runner
npm run build
```

The TypeScript tests cover the browser/compiler and runner-client contracts. The
Python tests exercise the runner HTTP API and verify that Build/Run delegate to
the native CLI contract rather than reimplementing language semantics.

## Deployment

Work lands directly on `develop`. Publishing remains a deliberate
fast-forward of `main` to `develop`.

The Pages workflow:

1. builds the WebAssembly frontend from a resolved Core SHA;
2. builds the page with the repository variable `QUIDRA_RUNNER_URL`;
3. publishes `ghcr.io/quidra-lang/playground-runner` from that same Core SHA;
4. deploys the static page to GitHub Pages.

A production Cloudflare Sandbox adapter is included in
[`runner/cloudflare/`](runner/cloudflare/). When the repository has
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets, the deploy
workflow builds that sandbox from the **same Core SHA** as the page and deploys
it automatically. Set `QUIDRA_RUNNER_URL` to the deployed Worker's HTTPS base
URL. Build/Run still fail closed until its reported language version and Core
SHA match the WebAssembly frontend.

The adapter creates one VM-isolated Sandbox per Build/Run, disables outbound
Internet access, rate-limits execution, drops the Quidra process to an
unprivileged uid/gid, and destroys the Sandbox after the request. A plain
Internet-exposed Docker container remains intentionally unsupported for public
untrusted execution.

The published page is <https://quidra-lang.github.io/playground/>.

## Scope

The Playground is single-file. It does not provide accounts, cloud save,
collaboration, package installation or a browser-side JIT. Source persistence in
the editor uses `localStorage`.

## License

MIT, matching Quidra Core.
