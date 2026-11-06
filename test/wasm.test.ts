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

const VALID = `int add(int a, int b := 3)
    return a + b

string greet(label := "hello")
    return label

answer := add(2)
answer = add(answer, b = 1)
println(answer)
println(greet())

tensor<real32>{nat H, W := H * 2} image := tensor.zeros([32, 64])
`;

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

  it("reports the same Quidra version project.toml declares", () => {
    const metadataPath = join(root, ".core-build", "core-metadata.json");
    if (!existsSync(metadataPath)) return;
    const { coreVersion } = JSON.parse(readFileSync(metadataPath, "utf8")) as {
      coreVersion: string;
    };
    const response = invoke({ schema_version: WASM_SCHEMA_VERSION, operation: "metadata" });
    expect((response as MetadataResponse).metadata.version).toBe(coreVersion);
  });

  it("checks a valid program", () => {
    const response = invoke({
      schema_version: WASM_SCHEMA_VERSION, operation: "check", source: VALID,
    }) as CheckResponse;
    expect(response.ok).toBe(true);
    expect(response.valid).toBe(true);
    expect(response.diagnostics).toEqual([]);
  });

  it("checks type-call conversions and length members", () => {
    const source = `int | error parse_and_measure(string input)
    value := try int(input)
    bits := try bin("101")
    string decimal := string(value)
    string hexadecimal := value.B16
    nat characters := decimal.len()
    nat bit_count := bits.len()
    nat elements := [value].len()
    println("{decimal}, {hexadecimal}, {characters}, {bit_count}, {elements}")
    return value
`;
    const response = invoke({
      schema_version: WASM_SCHEMA_VERSION, operation: "check", source,
    }) as CheckResponse;
    expect(response.ok).toBe(true);
    expect(response.valid).toBe(true);
    expect(response.diagnostics).toEqual([]);
  });

  it.each([
    "3", "3.", "03.", ".0", ".2", ".02", "03.2", ":3", "03.2:3", "3:3",
    "base=16", "base=16,upper",
  ])("checks compact numeric interpolation with %s", (format) => {
    const response = invoke({
      schema_version: WASM_SCHEMA_VERSION,
      operation: "check",
      source: `value := 12345\nprintln("{value:${format}}")\n`,
    }) as CheckResponse;
    expect(response.ok).toBe(true);
    expect(response.valid).toBe(true);
    expect(response.diagnostics).toEqual([]);
  });

  it.each([
    "03", "0", "0.", ".",
    "int=3", "frac=2", "sig=3", "group=3", "zero",
    "group=3,frac=2", "group=3,int=12,zero",
  ])("rejects invalid or abolished numeric interpolation option %s", (format) => {
    const response = invoke({
      schema_version: WASM_SCHEMA_VERSION,
      operation: "check",
      source: `value := 12345\nprintln("{value:${format}}")\n`,
    }) as CheckResponse;
    expect(response.ok).toBe(true);
    expect(response.valid).toBe(false);
    expect(response.diagnostics.length).toBeGreaterThan(0);
  });

  it("defaults numeric literals and keeps contextual integer widths", () => {
    const source = `integer := 5 + 6
int integer_copy := integer
fraction := 1.5
real fraction_copy := fraction
imaginary := 2.0i
com imaginary_copy := imaginary
nat natural := 5
int32 narrow := 5 + 6
contextual := narrow + 1
int32 contextual_copy := contextual
`;
    const response = invoke({
      schema_version: WASM_SCHEMA_VERSION, operation: "check", source,
    }) as CheckResponse;
    expect(response.ok).toBe(true);
    expect(response.valid).toBe(true);
    expect(response.diagnostics).toEqual([]);
  });

  it("chooses widths only from the highest numeric family", () => {
    const source = `nat64 unsigned := 5
nat arbitrary_natural := 5
int32 signed := 6
mixed := unsigned + signed
int32 mixed_copy := mixed
int32 arbitrary_mixed := arbitrary_natural + signed
int32 signed_copy := signed
nat64 unsigned_copy := unsigned
real16 half := 1.5
real16 real_result := signed + half
real16b bhalf := 1.5
real32 half_result := half + bhalf
real64 wide := 2.0
com16 imaginary := 1.0i
com16 complex_result := wide + imaginary
bool ordered := signed < unsigned
`;
    const response = invoke({
      schema_version: WASM_SCHEMA_VERSION, operation: "check", source,
    }) as CheckResponse;
    expect(response.ok).toBe(true);
    expect(response.valid).toBe(true);
    expect(response.diagnostics).toEqual([]);
  });

  it("still requires explicit destination conversions in assignments", () => {
    const response = invoke({
      schema_version: WASM_SCHEMA_VERSION,
      operation: "check",
      source: "int32 integer := 5\nreal16 half := integer\n",
    }) as CheckResponse;
    expect(response.ok).toBe(true);
    expect(response.valid).toBe(false);
    expect(response.diagnostics.length).toBeGreaterThan(0);
  });

  it("converts numeric value arguments to a concrete parameter type", () => {
    const source = `real32 echo(real32 value)
    return value

integer := 5
nat natural := 6
real32 from_integer := echo(integer)
real32 from_natural := echo(natural)
int integer_copy := integer
nat natural_copy := natural
`;
    const response = invoke({
      schema_version: WASM_SCHEMA_VERSION, operation: "check", source,
    }) as CheckResponse;
    expect(response.ok).toBe(true);
    expect(response.valid).toBe(true);
    expect(response.diagnostics).toEqual([]);
  });

  it("rejects a writable numeric argument with a different storage type", () => {
    const source = `void replace(real32 &value)
    value = 1.0

integer := 5
replace(&integer)
`;
    const response = invoke({
      schema_version: WASM_SCHEMA_VERSION, operation: "check", source,
    }) as CheckResponse;
    expect(response.ok).toBe(true);
    expect(response.valid).toBe(false);
    expect(response.diagnostics.some((diagnostic) => diagnostic.code === "TYPE_MISMATCH")).toBe(true);
  });

  it("accepts concise collection types alongside a user-defined set function", () => {
    const source = `int set(int value)
    return value + 1

map<string, int> counts
.counts.set("apple", set(2))
distinct<string> tags
.tags.add("apple")
.tags.add("apple")
println(counts.has("apple"))
println(tags.size())
`;
    const response = invoke({
      schema_version: WASM_SCHEMA_VERSION, operation: "check", source,
    }) as CheckResponse;
    expect(response.ok).toBe(true);
    expect(response.valid).toBe(true);
    expect(response.diagnostics).toEqual([]);
  });

  it("accepts whitespace around collection generic type delimiters", () => {
    const source = `map <string, int> counts
.counts.set("apple", 1)
distinct <string> tags
.tags.add("apple")
println(counts.has("apple"))
println(tags.size())
`;
    const response = invoke({
      schema_version: WASM_SCHEMA_VERSION, operation: "check", source,
    }) as CheckResponse;
    expect(response.ok).toBe(true);
    expect(response.valid).toBe(true);
    expect(response.diagnostics).toEqual([]);
  });

  it("returns a structured diagnostic with a usable range", () => {
    const response = invoke({
      schema_version: WASM_SCHEMA_VERSION, operation: "check", source: "int x := zzz\n",
    }) as CheckResponse;
    expect(response.valid).toBe(false);
    const [first] = response.diagnostics;
    expect(first?.code).toBe("UNKNOWN_NAME");
    expect(first?.span.start.line).toBe(1);
    expect(first?.span.end.offset).toBeGreaterThan(first!.span.start.offset);
  });

  it("formats, and reports a second format as unchanged", () => {
    const first = invoke({
      schema_version: WASM_SCHEMA_VERSION, operation: "format", source: "int    x   :=   1\n",
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
      schema_version: WASM_SCHEMA_VERSION, operation: "ir", source: "int x := zzz\n",
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
    const deep = `int x := 1${" + 1".repeat(2000)}\n`;
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
    const source = 's := "こんにちは 🌸"\nprintln(s)\n';
    const response = invoke({
      schema_version: WASM_SCHEMA_VERSION, operation: "format", source,
    }) as FormatResponse;
    expect(response.ok).toBe(true);
    expect(response.source).toContain("こんにちは 🌸");
  });
});
