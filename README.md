# Quidra Playground

The official [Quidra](https://github.com/quidra-lang/quidra) playground: the
real Quidra compiler frontend, compiled to WebAssembly and running in your
browser tab.

There is no backend. Your source is never uploaded, never logged and never
leaves the page — once the site has loaded, it works offline.

## What it does

| | |
| --- | --- |
| **Check** | Type-checks the source and reports the compiler's own diagnostics, with codes and exact ranges, marked in the editor. |
| **Format** | Rewrites the source with `quidra::format_source`, the same formatter `quidra fmt` uses. |
| **IR** | Lowers a checked program to typed Quidra IR. |
| **Inspect** | Shows the compiler's structural view: node ids, kinds, spans, content hashes and inferred types. |
| **Patch** | Applies a structured edit keyed by node id and content hash, and refuses any patch whose result would not compile. |

## Why there is no Run button

Quidra Playground exposes Quidra's compiler tooling directly in the browser.
Program execution is intentionally excluded until a browser execution model can
preserve Quidra's native semantics and safety guarantees.

Concretely: running a Quidra program needs LLVM, the native runtime archive and
operating-system process facilities. The frontend carries none of them. Adding
a Run button here would mean writing a second execution engine whose behaviour
is not Quidra's — a program that behaved differently in the playground than on
your machine would be worse than no Run button at all.

If you want to run Quidra, [install it](https://github.com/quidra-lang/quidra)
and use `quidra run`. The Quidra repository also ships a local, developer-facing
playground (`python3 playground/server.py`) that drives the real binary and
therefore does offer Run and LLVM IR.

## Architecture

```
  index.html + src/main.ts            the page: editor, panes, diagnostics
          │
          │  postMessage {id, request}        structured, correlated by id
          ▼
  src/worker/compiler.worker.ts       a Web Worker; the only place the
          │                           compiler runs, so the UI never blocks
          │  quidra_wasm_invoke(json)
          ▼
  public/wasm/quidra-core.wasm        quidra_core, built from
                                      quidra-lang/quidra by CI
```

The WebAssembly module exposes exactly two C functions:

```c
char* quidra_wasm_invoke(const char* request_json);
void  quidra_wasm_free(char* result);
```

Requests and responses are JSON envelopes. Every response carries
`schema_version`, `ok` and `operation`; failures carry a structured `error`
object rather than a string anyone has to parse. No C++ exception crosses the
boundary.

```json
{ "schema_version": 1, "operation": "check", "filename": "main.qui", "source": "…" }
```

**This repository contains no compiler.** There is no parser, no checker, no
formatter and no IR here. Every answer on screen comes from `quidra::check`,
`quidra::format_source`, `quidra::ir::lower`, `quidra::inspect_source_json` and
`quidra::apply_source_patch` in the Quidra repository. Even the keyword list
used for syntax highlighting is extracted from the Core checkout at build time,
so it cannot drift from the compiler by hand. Highlighting is lexical only; it
never decides what a program means.

### Versions

The playground has **no product version of its own**. Its version is the version
of the Quidra Core it was built from:

```
Quidra Playground 0.2.1
Core 0.2.1 @ 5bc4911
```

`project.toml` in Quidra Core is the single source of truth.
`scripts/prepare-core.mjs` reads it, `scripts/sync-version.mjs` copies it into
`package.json`, and CI fails on any drift. The version shown in the page is not
read from `package.json` at all — it is whatever the loaded WebAssembly module
reports from its `metadata` operation, so the page can never display a version
the compiler does not agree with.

Two things are versioned independently, exactly as `abi` and `ir` are in Core:

| | |
| --- | --- |
| WASM bridge protocol | `schema_version` in every request and response |
| Patch document | `schema_version` inside the patch JSON itself |

## Local development

Requires Node 20+, CMake, and the
[Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html) on
your `PATH`.

```bash
npm install
npm run core:build     # clone Quidra Core, build the frontend to WebAssembly
npm run dev            # http://localhost:5173
```

To build against a Core checkout you already have, or a specific revision:

```bash
QUIDRA_CORE_DIR=../quidra npm run core:build
QUIDRA_CORE_REF=v0.2.1   npm run core:build
```

`npm run core:build` writes `public/wasm/quidra-core.{js,wasm}`,
`src/generated/`, and `.core-build/core-metadata.json`. All of it is generated
and none of it is committed.

## Build and test

```bash
npm run typecheck      # tsc --noEmit
npm test               # protocol, worker transport, version sync, page contract,
                       #   and the real compiler through the real envelope
npm run build          # version check, typecheck, production bundle into dist/
```

`npm test` runs against the actual WebAssembly artifact when one has been
staged, so a change that breaks the request contract fails here rather than in
the browser. The tests that need it are skipped when it is absent.

## Deployment

`npm run build` produces a fully static `dist/`. Assets are referenced
relatively, so the same build works at a domain root and under a subpath such
as `/playground/`.

`.github/workflows/deploy.yml` builds and publishes to GitHub Pages on every
push to `develop`, which is the branch this repository advances on. There is no
backend, no database and no secret to configure.

Pages has to be switched on once by a repository admin — Settings › Pages,
source **GitHub Actions**. The workflow token is not allowed to create the site
itself, so that step cannot be automated away.

The published site is <https://quidra-lang.github.io/playground/>.

## What this is not

No Run, REPL, JIT or any other execution. No multi-file editing, package
manager, or package download. No server-side compilation and no remote compiler
API. No accounts, login, cloud save or collaboration. No AI assistant and no LLM
API. No telemetry and no analytics.

The editor keeps your source in `localStorage` so a reload does not lose it.
That is the only thing stored anywhere, and it stays in your browser.

## License

MIT, matching Quidra Core.
