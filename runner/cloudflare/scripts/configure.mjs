import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

const root = resolve(import.meta.dirname, "..");
const input = JSON.parse(readFileSync(resolve(root, "wrangler.json"), "utf8"));
const coreRef = required("QUIDRA_CORE_REF");
const coreVersion = required("QUIDRA_CORE_VERSION");
const origin =
  process.env.QUIDRA_PLAYGROUND_ORIGIN?.trim() || "https://quidra-lang.github.io";

input.vars.QUIDRA_CORE_COMMIT = coreRef;
input.vars.QUIDRA_VERSION = coreVersion;
input.vars.QUIDRA_PLAYGROUND_ORIGIN = origin;
input.containers[0].image_vars.QUIDRA_CORE_REF = coreRef;

const output = resolve(root, "wrangler.deploy.json");
writeFileSync(output, JSON.stringify(input, null, 2) + "\n");
console.log(`Prepared Cloudflare runner config for Core ${coreVersion} @ ${coreRef}`);
