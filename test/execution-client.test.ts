import { afterEach, describe, expect, it, vi } from "vitest";

import { ExecutionClient } from "../src/execution-client";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ExecutionClient", () => {
  it("reads runner metadata", async () => {
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) =>
      new Response(
        JSON.stringify({
          api_version: 2,
          operations: ["build", "run"],
          version: "0.4.0",
          core_commit: "abc1234",
          max_source_bytes: 262144,
          timeout_seconds: 8,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new ExecutionClient("https://runner.example");
    const metadata = await client.metadata();

    expect(metadata.core_commit).toBe("abc1234");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://runner.example/v2/meta",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("posts source only to the explicit execution endpoint", async () => {
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) =>
      new Response(
        JSON.stringify({
          api_version: 2,
          operation: "run",
          ok: true,
          exit_code: 0,
          stdout: "42\n",
          stderr: "",
          stdout_truncated: false,
          stderr_truncated: false,
          elapsed_ms: 4,
          timed_out: false,
          version: "0.4.0",
          core_commit: "abc1234",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new ExecutionClient("https://runner.example/");
    const result = await client.execute("run", "print(42)\n");

    expect(result.stdout).toBe("42\n");
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      operation: "run",
      source: "print(42)\n",
      args: [],
    });
  });

  it("allows sandbox startup time without changing the native execution limit", async () => {
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            api_version: 2,
            operation: "run",
            ok: true,
            exit_code: 0,
            stdout: "",
            stderr: "",
            stdout_truncated: false,
            stderr_truncated: false,
            elapsed_ms: 1,
            timed_out: false,
            version: "0.4.0",
            core_commit: "abc1234",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      ),
    );

    const client = new ExecutionClient("https://runner.example");
    await client.execute("run", "print(42)\n");

    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 45_000);
  });

  it("surfaces structured runner errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "origin not allowed" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    const client = new ExecutionClient("https://runner.example");
    await expect(client.metadata()).rejects.toThrow("origin not allowed");
  });
});
