// Keeps package.json's version equal to the Quidra Core product version.
//
// The playground has no product version of its own. Quidra Core's project.toml
// is the single source of truth, so this script copies the value rather than
// letting anyone type it a second time. CI runs it with --check, which fails
// the build on any drift.
//
// Usage:
//   node scripts/sync-version.mjs            write package.json
//   node scripts/sync-version.mjs --check    fail if it would change anything

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const metadataPath = join(root, ".core-build", "core-metadata.json");
const packagePath = join(root, "package.json");
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
  console.error("Core metadata does not carry a product version.");
  process.exit(1);
}

const packageText = readFileSync(packagePath, "utf8");
const manifest = JSON.parse(packageText);

if (manifest.version === coreVersion) {
  console.log(`playground version ${manifest.version} matches Core ${coreVersion} @ ${coreCommit}`);
  process.exit(0);
}

if (checkOnly) {
  console.error(
    `version drift: package.json says ${manifest.version}, Quidra Core says ${coreVersion}.\n` +
      "Run `npm run version:sync`. The playground must never carry a version of its own.",
  );
  process.exit(1);
}

// Rewrite just the version line so the file keeps its formatting.
const updated = packageText.replace(
  /("version"\s*:\s*")[^"]*(")/,
  (_match, open, close) => `${open}${coreVersion}${close}`,
);
if (updated === packageText) {
  console.error("could not find a version field to update in package.json");
  process.exit(1);
}
writeFileSync(packagePath, updated);
console.log(`package.json version set to ${coreVersion} (Core @ ${coreCommit})`);
