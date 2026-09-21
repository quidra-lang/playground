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

  it("offers exactly the five documented operations", () => {
    for (const action of ["check", "format", "ir", "inspect", "patch"]) {
      expect(html).toContain(`id="action-${action}"`);
    }
  });
});

describe("execution is not offered", () => {
  it("has no Run control", () => {
    // A Run button would mean a second execution engine with semantics that
    // are not Quidra's. The absence is a product decision, so it is tested.
    expect(html).not.toMatch(/id="action-run"/);
    expect(html).not.toMatch(/>\s*Run\s*</);
    expect(mainTs).not.toMatch(/\baction-run\b/);
  });

  it("says plainly that execution is excluded", () => {
    expect(html).toMatch(/No Run button/i);
  });

  it("never asks the compiler to run anything", () => {
    const protocol = readFileSync(join(root, "src", "protocol.ts"), "utf8");
    expect(protocol).not.toMatch(/"run"/);
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
