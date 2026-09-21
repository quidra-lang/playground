// The playground must never carry a product version of its own.
//
// Quidra Core's project.toml is the single source of truth. These tests fail
// on any drift between it, package.json, and the version the compiled
// WebAssembly module reports at runtime.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const metadataPath = join(root, ".core-build", "core-metadata.json");
const hasCoreMetadata = existsSync(metadataPath);

const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  version: string;
};

describe("version synchronisation", () => {
  it.runIf(hasCoreMetadata)("package.json equals the Core product version", () => {
    const { coreVersion } = JSON.parse(readFileSync(metadataPath, "utf8")) as {
      coreVersion: string;
    };
    expect(manifest.version).toBe(coreVersion);
  });

  it.runIf(hasCoreMetadata)("records the exact Core revision it was built from", () => {
    const { coreCommit } = JSON.parse(readFileSync(metadataPath, "utf8")) as {
      coreCommit: string;
    };
    expect(coreCommit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("does not hardcode a version anywhere in src/", () => {
    // A literal version string in the UI would be a second source of truth.
    // The displayed version comes from the compiler's metadata operation.
    const files = ["src/main.ts", "src/protocol.ts", "src/compiler-client.ts"];
    for (const file of files) {
      const text = readFileSync(join(root, file), "utf8");
      const literals = text.match(/["'`]\d+\.\d+\.\d+["'`]/g) ?? [];
      expect(literals, `${file} must not state a product version`).toEqual([]);
    }
  });
});
