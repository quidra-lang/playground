// Guards the contract between index.html and the code that drives it.
//
// main.ts throws if an element it needs is missing, which in a browser means a
// blank page. Checking the ids here turns that into a failed test instead.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "index.html"), "utf8");
const mainTs = readFileSync(join(root, "src", "main.ts"), "utf8");
const languageTs = readFileSync(join(root, "src", "quidra-language.ts"), "utf8");
const readme = readFileSync(join(root, "README.md"), "utf8");
const cloudflareReadme = readFileSync(join(root, "runner", "cloudflare", "README.md"), "utf8");

function idsIn(source: string): Set<string> {
  return new Set([...source.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]!));
}

function idsRequiredBy(source: string): Set<string> {
  const direct = [...source.matchAll(/need<[^>]*>\("([^"]+)"\)/g)].map((match) => match[1]!);
  // Template ids such as `tab-${tab}` and `panel-${tab}` expand over TABS.
  const tabs = /const TABS = \[([^\]]+)\]/.exec(source);
  const names = tabs
    ? [...tabs[1]!.matchAll(/"([^"]+)"/g)].map((match) => match[1]!)
    : [];
  const expanded = names.flatMap((name) => [`tab-${name}`, `panel-${name}`]);
  return new Set([...direct, ...expanded]);
}

describe("the page and the code agree", () => {
  it("declares every element main.ts looks up", () => {
    const available = idsIn(html);
    const missing = [...idsRequiredBy(mainTs)]
      .filter((id) => !id.includes("${"))
      .filter((id) => !available.has(id));
    expect(missing, "index.html is missing these ids").toEqual([]);
  });

  it("offers local tooling plus native Build and Run", () => {
    for (const action of ["run", "build", "check", "format", "ir", "inspect", "patch"]) {
      expect(html).toContain(`id="action-${action}"`);
    }
    expect(html).toContain('id="tab-output"');
    expect(html).toContain('id="execution-output"');
  });

  it("does not hardcode Core's default source filename in the static page", () => {
    expect(html).not.toContain("main.qui");
    expect(mainTs).toContain("metadata.default_filename");
  });
});

describe("native execution is explicit", () => {
  it("keeps Build and Run disabled until the runner identity is verified", () => {
    expect(html).toMatch(/id="action-run"[^>]*disabled/);
    expect(html).toMatch(/id="action-build"[^>]*disabled/);
    expect(mainTs).toMatch(/runner\.version !== metadata\.version/);
    expect(mainTs).toMatch(/runner\.core_commit !== metadata\.core_commit/);
  });

  it("keeps execution out of the WebAssembly frontend protocol", () => {
    const protocol = readFileSync(join(root, "src", "protocol.ts"), "utf8");
    expect(protocol).not.toMatch(/"run"/);
    expect(protocol).not.toMatch(/"build"/);
  });

  it("uses the dedicated execution client for native work", () => {
    expect(mainTs).toMatch(/executionClient\.execute\(operation, program\)/);
  });
});

describe("runner identity documentation matches runtime checks", () => {
  it("documents both language version and Core revision as required identity", () => {
    expect(readme).toMatch(/same\s+language version and exact same Core commit/);
    expect(readme).toMatch(/reported language version and Core\s+SHA match/);
    expect(cloudflareReadme).toMatch(/same language version and Core SHA/);
  });
});

describe("compiler output never becomes markup", () => {
  it("does not use innerHTML or outerHTML anywhere in src/", () => {
    for (const file of ["src/main.ts", "src/editor.ts", "src/compiler-client.ts"]) {
      const text = readFileSync(join(root, file), "utf8");
      expect(text, `${file} must not assign HTML`).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML/);
    }
  });

  it("does not use eval or the Function constructor", () => {
    for (const file of ["src/main.ts", "src/editor.ts", "src/compiler-client.ts", "src/worker/compiler.worker.ts"]) {
      const text = readFileSync(join(root, file), "utf8");
      expect(text, `${file} must not evaluate code`).not.toMatch(/\beval\(|new Function\(/);
    }
  });
});


describe("syntax highlighting follows Core lexical contracts", () => {
  it("does not invent numeric separators or integer exponent notation", () => {
    expect(languageTs).not.toContain("[0-9_]");
    expect(languageTs).toContain("let hasDecimalPoint = false");
    expect(languageTs).toContain("hasDecimalPoint && (stream.peek() === \"e\" || stream.peek() === \"E\")");
  });

  it("tracks Core string boundaries across interpolation and line breaks", () => {
    expect(languageTs).toContain("interpolationDepth");
    expect(languageTs).toContain("interpolationString");
    expect(languageTs).toContain('next === "{" && stream.peek() === "{"');
    expect(languageTs).toContain("if (state.inString)");
    expect(languageTs).not.toContain("escaped =");
  });

  it("highlights only source punctuation that Core actually tokenizes", () => {
    expect(languageTs).toContain(':.;]');
    expect(languageTs).not.toContain("{}");
  });
});
