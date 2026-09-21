// The worker transport, tested against a fake worker.
//
// What matters here is not that a compiler runs -- test/wasm.test.ts does that
// -- but that overlapping requests stay correlated and that the death of a
// worker is survivable, because the source the user typed lives on this side.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { CompilerClient, type ClientStatus } from "../src/compiler-client";
import type { CompilerResponse, WorkerInbound, WorkerOutbound } from "../src/protocol";

class FakeWorker implements Pick<Worker, "postMessage" | "terminate"> {
  static instances: FakeWorker[] = [];

  readonly sent: WorkerInbound[] = [];
  terminated = false;
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor() {
    FakeWorker.instances.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  postMessage(message: WorkerInbound): void {
    this.sent.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Simulate the worker answering. */
  emit(message: WorkerOutbound): void {
    for (const listener of this.listeners.get("message") ?? []) {
      listener({ data: message });
    }
  }

  /** Simulate the worker dying, the way a Wasm trap surfaces. */
  die(message = "wasm trap"): void {
    for (const listener of this.listeners.get("error") ?? []) {
      listener({ message });
    }
  }

  get requests(): { id: number; operation: string }[] {
    return this.sent
      .filter((entry): entry is Extract<WorkerInbound, { request: unknown }> => "request" in entry)
      .map((entry) => ({ id: entry.id, operation: entry.request.operation }));
  }
}

function makeClient(onStatusChange?: (status: ClientStatus, detail?: string) => void) {
  FakeWorker.instances = [];
  const client = new CompilerClient({
    glueUrl: "https://example.test/wasm/quidra-core.js",
    createWorker: () => new FakeWorker() as unknown as Worker,
    onStatusChange,
  });
  const worker = FakeWorker.instances[0];
  if (!worker) throw new Error("no worker was created");
  return { client, worker };
}

function reply(id: number, response: CompilerResponse): WorkerOutbound {
  return { id, ok: true, response };
}

const checkOk: CompilerResponse = {
  schema_version: 1,
  ok: true,
  operation: "check",
  valid: true,
  diagnostics: [],
  truncated: false,
};

describe("CompilerClient", () => {
  beforeEach(() => {
    FakeWorker.instances = [];
  });

  it("hands the worker its module URL before anything else", () => {
    const { worker } = makeClient();
    expect(worker.sent[0]).toEqual({
      id: -1,
      glueUrl: "https://example.test/wasm/quidra-core.js",
    });
  });

  it("sends the schema version and the virtual filename with each request", async () => {
    const { client, worker } = makeClient();
    void client.check("print(1)\n");
    const sent = worker.sent.at(-1);
    expect(sent && "request" in sent && sent.request).toMatchObject({
      schema_version: 1,
      operation: "check",
      filename: "main.qui",
      source: "print(1)\n",
    });
  });

  it("keeps overlapping requests correlated by id", async () => {
    const { client, worker } = makeClient();
    const first = client.check("a");
    const second = client.format("b");
    const third = client.ir("c");

    const ids = worker.requests;
    expect(ids.map((entry) => entry.operation)).toEqual(["check", "format", "ir"]);
    expect(new Set(ids.map((entry) => entry.id)).size).toBe(3);

    // Answer out of order; each promise must still get its own answer.
    const formatResponse: CompilerResponse = {
      schema_version: 1, ok: true, operation: "format", source: "b", changed: false,
    };
    const irResponse: CompilerResponse = {
      schema_version: 1, ok: true, operation: "ir", text: "ir", ir_version: "1",
    };
    worker.emit(reply(ids[2]!.id, irResponse));
    worker.emit(reply(ids[0]!.id, checkOk));
    worker.emit(reply(ids[1]!.id, formatResponse));

    await expect(first).resolves.toMatchObject({ operation: "check" });
    await expect(second).resolves.toMatchObject({ operation: "format" });
    await expect(third).resolves.toMatchObject({ operation: "ir" });
  });

  it("reports readiness from the worker's own status message", () => {
    const statuses: ClientStatus[] = [];
    const { client, worker } = makeClient((status) => statuses.push(status));
    expect(client.currentStatus).toBe("loading");
    worker.emit({ id: 0, status: "ready" });
    expect(client.currentStatus).toBe("ready");
    expect(statuses).toContain("ready");
  });

  it("surfaces a module that fails to load", () => {
    const details: (string | undefined)[] = [];
    const { client, worker } = makeClient((_status, detail) => details.push(detail));
    worker.emit({ id: 0, status: "failed", error: "fetch failed" });
    expect(client.currentStatus).toBe("failed");
    expect(details).toContain("fetch failed");
  });

  it("rejects in-flight work when the worker dies, and replaces it", async () => {
    const onRestart = vi.fn();
    FakeWorker.instances = [];
    const client = new CompilerClient({
      glueUrl: "https://example.test/wasm/quidra-core.js",
      createWorker: () => new FakeWorker() as unknown as Worker,
      onRestart,
    });
    const worker = FakeWorker.instances[0]!;

    const pending = client.check("deep source");
    worker.die("out of memory");

    await expect(pending).rejects.toThrow(/out of memory/);
    expect(onRestart).toHaveBeenCalledOnce();
    expect(worker.terminated).toBe(true);

    // A fresh worker took over and is usable immediately.
    expect(FakeWorker.instances).toHaveLength(2);
    const replacement = FakeWorker.instances[1]!;
    expect(replacement.sent[0]).toMatchObject({ id: -1 });

    const next = client.check("print(1)\n");
    const id = replacement.requests.at(-1)!.id;
    replacement.emit(reply(id, checkOk));
    await expect(next).resolves.toMatchObject({ ok: true, operation: "check" });
  });

  it("propagates a worker-side error for a single request without killing the client", async () => {
    const { client, worker } = makeClient();
    const pending = client.inspect("x");
    const id = worker.requests.at(-1)!.id;
    worker.emit({ id, ok: false, error: "module not initialised" });
    await expect(pending).rejects.toThrow(/module not initialised/);
    expect(worker.terminated).toBe(false);
  });

  it("ignores an answer to a request it does not know about", () => {
    const { worker } = makeClient();
    expect(() => worker.emit(reply(4242, checkOk))).not.toThrow();
  });
});
