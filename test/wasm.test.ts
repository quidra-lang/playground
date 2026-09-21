// End-to-end against the real compiler.
//
// This loads the same WebAssembly artifact the browser loads and drives it
// through the same request envelope, so a change that breaks the contract is
// caught here rather than in the page. It is skipped when the artifact has not
// been staged yet (`npm run core:build`).

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { WASM_SCHEMA_VERSION } from "../src/protocol";
import type {
  CheckResponse,
  CompilerResponse,
  FormatResponse,
  InspectResponse,
  IrResponse,
  MetadataResponse,
  PatchResponse,
} from "../src/protocol";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const gluePath = join(root, "public", "wasm", "quidra-core.js");
const staged = existsSync(gluePath);

interface CoreModule {
  _quidra_wasm_invoke(request: number): number;
  _quidra_wasm_free(result: number): void;
  _free(pointer: number): void;
  stringToNewUTF8(text: string): number;
  UTF8ToString(pointer: number): string;
}

let core: CoreModule;

function invoke(request: Record<string, unknown>): CompilerResponse {
  const requestPointer = core.stringToNewUTF8(JSON.stringify(request));
  let resultPointer = 0;
  try {
    resultPointer = core._quidra_wasm_invoke(requestPointer);
    return JSON.parse(core.UTF8ToString(resultPointer)) as CompilerResponse;
  } finally {
    if (resultPointer !== 0) core._quidra_wasm_free(resultPointer);
    core._free(requestPointer);
  }
}

const VALID = 'int add(int a, int b)\n    return a + b\n\nprint(add(2, 3))\n';

describe.runIf(staged)("the real compiler, through the browser's own contract", () => {
  beforeAll(async () => {
    const glue = (await import(pathToFileURL(gluePath).href)) as {
      default: () => Promise<CoreModule>;
    };
    core = await glue.default();
  });

  it("reports a schema version this build understands", () => {
    const response = invoke({ schema_version: WASM_SCHEMA_VERSION, operation: "metadata" });
    expect(response.ok).toBe(true);
    const metadata = (response as MetadataResponse).metadata;
    expect(metadata.wasm_schema_version).toBe(WASM_SCHEMA_VERSION);
    expect(metadata.core_commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("reports the same product version project.toml declares", () => {
    const metadataPath = join(root, ".core-build", "core-metadata.json");
    if (!existsSync(metadataPath)) return;
    const { coreVersion } = JSON.parse(readFileSync(metadataPath, "utf8")) as {
      coreVersion: string;
    };
    const response = invoke({ schema_version: WASM_SCHEMA_VERSION, operation: "metadata" });
    expect((response as MetadataResponse).metadata.product_version).toBe(coreVersion);
  });

  it("checks a valid program", () => {
    const response = invoke({
      schema_version: WASM_SCHEMA_VERSION, operation: "check", source: VALID,
    }) as CheckResponse;
    expect(response.ok).toBe(true);
    expect(response.valid).toBe(true);
    expect(response.diagnostics).toEqual([]);
  });

  it("returns a structured diagnostic with a usable range", () => {
    const response = invoke({
      schema_version: WASM_SCHEMA_VERSION, operation: "check", source: "int x = zzz\n",
    }) as CheckResponse;
    expect(response.valid).toBe(false);
    const [first] = response.diagnostics;
    expect(first?.code).toBe("UNKNOWN_NAME");
    expect(first?.span.start.line).toBe(1);
    expect(first?.span.end.offset).toBeGreaterThan(first!.span.start.offset);
  });

  it("formats, and reports a second format as unchanged", () => {
    const first = invoke({
      schema_version: WASM_SCHEMA_VERSION, operation: "format", source: "int    x   =   1\n",
    }) as FormatResponse;
    expect(first.ok).toBe(true);
    expect(first.changed).toBe(true);

    const second = invoke({
      schema_version: WASM_SCHEMA_VERSION, operation: "format", source: first.source,
    }) as FormatResponse;
    expect(second.changed).toBe(false);
  });

  it("lowers to typed IR", () => {
    const response = invoke({
      schema_version: WASM_SCHEMA_VERSION, operation: "ir", source: VALID,
    }) as IrResponse;
    expect(response.ok).toBe(true);
    expect(response.text.length).toBeGreaterThan(0);
  });

  it("refuses IR for a program that does not check, and says why", () => {
    const response = invoke({
      schema_version: WASM_SCHEMA_VERSION, operation: "ir", source: "int x = zzz\n",
    });
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error.kind).toBe("compile_failed");
    expect(response.error.diagnostics?.length).toBeGreaterThan(0);
  });

  it("inspects, and the inspection keys a patch that applies", () => {
    const inspected = invoke({
      schema_version: WASM_SCHEMA_VERSION, operation: "inspect", source: VALID,
    }) as InspectResponse;
    expect(inspected.ok).toBe(true);
    const { revision, nodes } = inspected.inspection;
    expect(revision).toMatch(/^[0-9a-f]{64}$/);

    const target = nodes.find((node) => node.source === "2");
    expect(target, "expected an integer literal node").toBeDefined();

    const patch = JSON.stringify({
      schema_version: 2,
      base_revision: revision,
      operations: [{
        op: "replace_node",
        node_id: target!.node_id,
        expected_hash: target!.source_hash,
        expected_kind: target!.kind,
        replacement: "9",
      }],
    });

    const applied = invoke({
      schema_version: WASM_SCHEMA_VERSION, operation: "patch", source: VALID, patch,
    }) as PatchResponse;
    expect(applied.ok).toBe(true);
    expect(applied.base_revision).toBe(revision);
    expect(applied.revision).not.toBe(revision);
    expect(applied.source).toContain("9");
  });

  it("refuses a patch whose result would not compile, leaving the source alone", () => {
    const inspected = invoke({
      schema_version: WASM_SCHEMA_VERSION, operation: "inspect", source: VALID,
    }) as InspectResponse;
    const target = inspected.inspection.nodes.find((node) => node.source === "2")!;
    const patch = JSON.stringify({
      schema_version: 2,
      base_revision: inspected.inspection.revision,
      operations: [{
        op: "replace_node",
        node_id: target.node_id,
        expected_hash: target.source_hash,
        expected_kind: target.kind,
        replacement: "nonexistent_name",
      }],
    });
    const response = invoke({
      schema_version: WASM_SCHEMA_VERSION, operation: "patch", source: VALID, patch,
    });
    expect(response.ok).toBe(false);
    expect(response).not.toHaveProperty("source");
  });

  it("does not offer execution", () => {
    const response = invoke({
      schema_version: WASM_SCHEMA_VERSION, operation: "run", source: VALID,
    });
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error.kind).toBe("unknown_operation");
  });

  it("refuses a schema version it does not speak", () => {
    const response = invoke({ schema_version: 999, operation: "check", source: VALID });
    expect(response.ok).toBe(false);
    if (response.ok) return;
    expect(response.error.kind).toBe("unsupported_schema_version");
  });

  it("turns a pathologically deep program into a diagnostic, not a trap", () => {
    const deep = `int x = 1${" + 1".repeat(2000)}\n`;
    const response = invoke({
      schema_version: WASM_SCHEMA_VERSION, operation: "check", source: deep,
    }) as CheckResponse;
    expect(response.ok).toBe(true);
    expect(response.valid).toBe(false);
    expect(response.diagnostics.some((d) => d.code === "NESTING_DEPTH")).toBe(true);

    // And the module is still usable.
    const after = invoke({
      schema_version: WASM_SCHEMA_VERSION, operation: "check", source: VALID,
    }) as CheckResponse;
    expect(after.valid).toBe(true);
  });

  it("carries non-ASCII source across the boundary intact", () => {
    const source = 'string s = "こんにちは 🌸"\nprint(s)\n';
    const response = invoke({
      schema_version: WASM_SCHEMA_VERSION, operation: "format", source,
    }) as FormatResponse;
    expect(response.ok).toBe(true);
    expect(response.source).toContain("こんにちは 🌸");
  });
});
