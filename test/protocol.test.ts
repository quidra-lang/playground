import { describe, expect, it } from "vitest";

import {
  DEFAULT_FILENAME,
  WASM_SCHEMA_VERSION,
  isInitMessage,
  isOk,
  isStatusMessage,
  type CheckResponse,
  type CompilerResponse,
  type FailureResponse,
  type WorkerOutbound,
} from "../src/protocol";

describe("envelope versioning", () => {
  it("pins the request/response schema version", () => {
    // Bumping this is a protocol change: the worker, the bridge and this
    // constant move together, and the module reports its own value back.
    expect(WASM_SCHEMA_VERSION).toBe(1);
  });

  it("edits a single virtual file", () => {
    expect(DEFAULT_FILENAME).toBe("main.qui");
  });
});

describe("isOk", () => {
  const checkResponse: CheckResponse = {
    schema_version: 1,
    ok: true,
    operation: "check",
    valid: false,
    diagnostics: [
      {
        severity: "error",
        code: "UNKNOWN_NAME",
        message: "Unknown name 'zzz'.",
        span: {
          start: { offset: 8, line: 1, column: 9 },
          end: { offset: 11, line: 1, column: 12 },
        },
      },
    ],
    truncated: false,
  };

  it("narrows a matching successful response", () => {
    const response: CompilerResponse = checkResponse;
    expect(isOk<CheckResponse>(response, "check")).toBe(true);
  });

  it("rejects a different operation", () => {
    expect(isOk(checkResponse, "format")).toBe(false);
  });

  it("rejects a failure envelope", () => {
    const failure: FailureResponse = {
      schema_version: 1,
      ok: false,
      operation: "check",
      error: { kind: "invalid_request", message: "no source" },
    };
    expect(isOk(failure, "check")).toBe(false);
  });

  it("treats diagnostics as data, not as a failed call", () => {
    // A program with errors is a successful check. Only an unusable request
    // or an unusable compiler is a failure.
    expect(checkResponse.ok).toBe(true);
    expect(checkResponse.valid).toBe(false);
  });
});

describe("worker message discrimination", () => {
  it("recognises the init message by its reserved id", () => {
    expect(isInitMessage({ id: -1, glueUrl: "https://example.test/wasm/quidra-core.js" })).toBe(
      true,
    );
    expect(isInitMessage({ id: 7, request: { schema_version: 1, operation: "check" } })).toBe(
      false,
    );
  });

  it("recognises unprompted status messages by id 0", () => {
    const ready: WorkerOutbound = { id: 0, status: "ready" };
    const reply: WorkerOutbound = {
      id: 1,
      ok: true,
      response: { schema_version: 1, ok: false, operation: "check", error: { kind: "internal", message: "x" } },
    };
    expect(isStatusMessage(ready)).toBe(true);
    expect(isStatusMessage(reply)).toBe(false);
  });
});
