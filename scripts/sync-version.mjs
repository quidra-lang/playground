// Keeps npm package metadata equal to the Quidra Core language version.
//
// The playground has no language version of its own. Quidra Core's project.toml
// is the single source of truth, so this script copies the value into package.json
// and package-lock.json rather than letting anyone type it a second time. CI runs
// it with --check, which fails the build on any drift.
//
// Usage:
//   node scripts/sync-version.mjs            write npm package metadata
//   node scripts/sync-version.mjs --check    fail if it would change anything

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const metadataPath = join(root, ".core-build", "core-metadata.json");
const packagePath = join(root, "package.json");
const lockPath = join(root, "package-lock.json");
const checkOnly = process.argv.includes("--check");

if (!existsSync(metadataPath)) {
  console.error(
    "No Core metadata found. Run `npm run core:build` first -- the playground " +
      "reads its version from the Quidra Core checkout, never from a literal here.",
  );
  process.exit(1);
}

const { coreVersion, coreCommit } = JSON.parse(readFileSync(metadataPath, "utf8"));
if (typeof coreVersion !== "string" || coreVersion.length === 0) {
  console.error("Core metadata does not carry a language version.");
  process.exit(1);
}

const packageText = readFileSync(packagePath, "utf8");
const manifest = JSON.parse(packageText);
const lockText = readFileSync(lockPath, "utf8");
const lockManifest = JSON.parse(lockText);
const lockRoot = lockManifest.packages?.[""];

if (!lockRoot || typeof lockRoot !== "object") {
  console.error('package-lock.json is missing packages[""] root metadata.');
  process.exit(1);
}

const observed = [
  ["package.json", manifest.version],
  ["package-lock.json", lockManifest.version],
  ['package-lock.json packages[""]', lockRoot.version],
];
const drift = observed.filter(([, value]) => value !== coreVersion);

if (drift.length === 0) {
  console.log(`playground package metadata matches Core ${coreVersion} @ ${coreCommit}`);
  process.exit(0);
}

if (checkOnly) {
  console.error(
    "version drift:\n" +
      drift.map(([where, value]) => `  ${where} says ${String(value)}, Core says ${coreVersion}`).join("\n") +
      "\nRun `npm run version:sync`. The playground must never carry a version of its own.",
  );
  process.exit(1);
}

if (manifest.version !== coreVersion) {
  // Rewrite just the version line so package.json keeps its formatting.
  const updated = packageText.replace(
    /("version"\s*:\s*")[^"]*(")/,
    (_match, open, close) => `${open}${coreVersion}${close}`,
  );
  if (updated === packageText) {
    console.error("could not find a version field to update in package.json");
    process.exit(1);
  }
  writeFileSync(packagePath, updated);
}

if (lockManifest.version !== coreVersion || lockRoot.version !== coreVersion) {
  lockManifest.version = coreVersion;
  lockRoot.version = coreVersion;
  writeFileSync(lockPath, `${JSON.stringify(lockManifest, null, 2)}\n`);
}

console.log(`playground package metadata set to ${coreVersion} (Core @ ${coreCommit})`);
