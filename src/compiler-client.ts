// The page's handle on the compiler.
//
// Every call is correlated by request id, so overlapping requests cannot be
// confused for one another. If the worker dies -- a compiler trap, an
// out-of-memory -- the client rejects what was in flight, spawns a fresh
// worker and keeps going: the editor's contents live on this side, so nothing
// the user typed is lost.

import {
  DEFAULT_FILENAME,
  WASM_SCHEMA_VERSION,
  isStatusMessage,
  type CheckResponse,
  type CompilerRequest,
  type CompilerResponse,
  type FormatResponse,
  type InspectResponse,
  type IrResponse,
  type MetadataResponse,
  type Operation,
  type PatchResponse,
  type WorkerInbound,
  type WorkerOutbound,
} from "./protocol";

export type ClientStatus = "loading" | "ready" | "failed";

export interface CompilerClientOptions {
  /** Absolute URL of the Emscripten glue module. */
  glueUrl: string;
  createWorker: () => Worker;
  onStatusChange?: (status: ClientStatus, detail?: string) => void;
  /** Called when a worker died and was replaced. */
  onRestart?: (reason: string) => void;
}

interface Pending {
  resolve: (response: CompilerResponse) => void;
  reject: (error: Error) => void;
  operation: Operation;
}

export class CompilerClient {
  private worker: Worker | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private status: ClientStatus = "loading";

  constructor(private readonly options: CompilerClientOptions) {
    this.spawn();
  }

  get currentStatus(): ClientStatus {
    return this.status;
  }

  private setStatus(status: ClientStatus, detail?: string): void {
    this.status = status;
    this.options.onStatusChange?.(status, detail);
  }

  private spawn(): void {
    const worker = this.options.createWorker();
    this.worker = worker;
    this.setStatus("loading");

    worker.addEventListener("message", (event: MessageEvent<WorkerOutbound>) => {
      const message = event.data;
      if (isStatusMessage(message)) {
        if (message.status === "ready") this.setStatus("ready");
        else this.setStatus("failed", message.error);
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.ok) pending.resolve(message.response);
      else pending.reject(new Error(message.error));
    });

    // A worker that dies takes its pending work with it. Fail those calls
    // loudly rather than leaving the UI waiting forever, then replace it.
    worker.addEventListener("error", (event: ErrorEvent) => {
      this.handleDeath(event.message || "the compiler worker stopped unexpectedly");
    });

    const init: WorkerInbound = { id: -1, glueUrl: this.options.glueUrl };
    worker.postMessage(init);
  }

  private handleDeath(reason: string): void {
    const worker = this.worker;
    this.worker = null;
    worker?.terminate();

    for (const [, pending] of this.pending) {
      pending.reject(new Error(reason));
    }
    this.pending.clear();

    this.options.onRestart?.(reason);
    this.spawn();
  }

  /** Discard the current worker and start a clean one. */
  restart(reason = "restarted on request"): void {
    this.handleDeath(reason);
  }

  private send(request: CompilerRequest): Promise<CompilerResponse> {
    if (!this.worker) {
      return Promise.reject(new Error("the compiler worker is not running"));
    }
    const id = this.nextId++;
    const message: WorkerInbound = { id, request };
    return new Promise<CompilerResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, operation: request.operation });
      this.worker?.postMessage(message);
    });
  }

  private call(operation: Operation, extra: Partial<CompilerRequest> = {}) {
    return this.send({
      schema_version: WASM_SCHEMA_VERSION,
      operation,
      filename: DEFAULT_FILENAME,
      ...extra,
    });
  }

  metadata(): Promise<CompilerResponse> {
    return this.send({ schema_version: WASM_SCHEMA_VERSION, operation: "metadata" });
  }

  check(source: string): Promise<CompilerResponse> {
    return this.call("check", { source });
  }

  format(source: string): Promise<CompilerResponse> {
    return this.call("format", { source });
  }

  ir(source: string): Promise<CompilerResponse> {
    return this.call("ir", { source });
  }

  inspect(source: string): Promise<CompilerResponse> {
    return this.call("inspect", { source });
  }

  patch(source: string, patch: string): Promise<CompilerResponse> {
    return this.call("patch", { source, patch });
  }

  patchSchema(): Promise<CompilerResponse> {
    return this.send({ schema_version: WASM_SCHEMA_VERSION, operation: "patch_schema" });
  }
}

// Convenience aliases used by the UI, kept here so call sites read plainly.
export type { CheckResponse, FormatResponse, InspectResponse, IrResponse, MetadataResponse, PatchResponse };
