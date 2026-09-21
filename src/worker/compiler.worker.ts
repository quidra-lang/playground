// The only place the Quidra compiler runs.
//
// The WebAssembly module is loaded and called here, never on the UI thread, so
// a long check or a pathological input cannot freeze the editor. If the module
// traps, this worker dies and the page starts a new one; nothing on the main
// thread shares its memory.

import {
  isInitMessage,
  type CompilerResponse,
  type WorkerInbound,
  type WorkerOutbound,
} from "../protocol";

interface QuidraCoreModule {
  _quidra_wasm_invoke(request: number): number;
  _quidra_wasm_free(result: number): void;
  _free(pointer: number): void;
  stringToNewUTF8(text: string): number;
  UTF8ToString(pointer: number): string;
}

type CoreFactory = (options?: {
  locateFile?: (path: string) => string;
}) => Promise<QuidraCoreModule>;

function post(message: WorkerOutbound): void {
  self.postMessage(message);
}

let modulePromise: Promise<QuidraCoreModule> | null = null;

// The glue and the .wasm are copied verbatim into public/wasm by
// scripts/prepare-core.mjs and served as plain static files. The page resolves
// their URL and sends it in, so this file never has to guess how deep it was
// bundled or what subpath the site is served from.
function startLoading(glueUrl: string): Promise<QuidraCoreModule> {
  if (modulePromise) return modulePromise;
  modulePromise = (async () => {
    const glue = (await import(/* @vite-ignore */ glueUrl)) as { default: CoreFactory };
    return glue.default({
      locateFile: (path: string) => new URL(path, glueUrl).href,
    });
  })();
  modulePromise.then(
    () => post({ id: 0, status: "ready" }),
    (error: unknown) =>
      post({
        id: 0,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      }),
  );
  return modulePromise;
}

/**
 * One call across the WebAssembly boundary. The module owns the result buffer
 * until we free it, and the request buffer is ours; both are released even when
 * parsing the answer throws.
 */
function invoke(core: QuidraCoreModule, request: unknown): CompilerResponse {
  const requestPointer = core.stringToNewUTF8(JSON.stringify(request));
  let resultPointer = 0;
  try {
    resultPointer = core._quidra_wasm_invoke(requestPointer);
    if (resultPointer === 0) {
      throw new Error("the compiler could not allocate a result");
    }
    return JSON.parse(core.UTF8ToString(resultPointer)) as CompilerResponse;
  } finally {
    if (resultPointer !== 0) core._quidra_wasm_free(resultPointer);
    core._free(requestPointer);
  }
}

self.addEventListener("message", (event: MessageEvent<WorkerInbound>) => {
  const message = event.data;
  if (isInitMessage(message)) {
    void startLoading(message.glueUrl);
    return;
  }
  const { id, request } = message;
  void (async () => {
    try {
      if (!modulePromise) {
        throw new Error("the compiler module was used before it was initialised");
      }
      const core = await modulePromise;
      post({ id, ok: true, response: invoke(core, request) });
    } catch (error) {
      post({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  })();
});
