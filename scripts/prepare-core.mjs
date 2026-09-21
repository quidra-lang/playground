// Builds the Quidra compiler frontend to WebAssembly and stages it for the site.
//
// The playground never vendors compiler source and never hand-manages a binary:
// it checks out quidra-lang/quidra, records the exact revision it resolved, and
// builds src/wasm_api.cpp from that tree. Everything the UI later says about
// "which compiler is this" traces back to the SHA recorded here and to the
// metadata baked into the artifact itself.
//
// Usage:
//   node scripts/prepare-core.mjs
//
// Environment:
//   QUIDRA_CORE_DIR  use an existing Core checkout instead of cloning
//   QUIDRA_CORE_REF  branch, tag or SHA to check out (default: develop)

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workDir = join(root, ".core-build");
const coreRef = process.env.QUIDRA_CORE_REF || "develop";
const coreRepository = "https://github.com/quidra-lang/quidra.git";

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit",
    encoding: "utf8",
    ...options,
  });
}

function capture(command, args, cwd) {
  return run(command, args, { capture: true, cwd }).trim();
}

function resolveCore() {
  if (process.env.QUIDRA_CORE_DIR) {
    const dir = resolve(process.env.QUIDRA_CORE_DIR);
    if (!existsSync(join(dir, "project.toml"))) {
      throw new Error(`QUIDRA_CORE_DIR does not look like a Quidra checkout: ${dir}`);
    }
    console.log(`Using existing Core checkout: ${dir}`);
    return dir;
  }
  mkdirSync(workDir, { recursive: true });
  const dir = join(workDir, "quidra");
  if (existsSync(join(dir, ".git"))) {
    console.log(`Updating Core checkout: ${dir}`);
    run("git", ["fetch", "--depth", "1", "origin", coreRef], { cwd: dir });
    run("git", ["checkout", "--detach", "FETCH_HEAD"], { cwd: dir });
  } else {
    console.log(`Cloning ${coreRepository} @ ${coreRef}`);
    run("git", ["clone", "--depth", "1", "--branch", coreRef, coreRepository, dir]);
  }
  return dir;
}

// project.toml is Quidra's single source of truth. The playground reads it; it
// never restates a value found there.
function readCoreProjectValue(coreDir, key) {
  const text = readFileSync(join(coreDir, "project.toml"), "utf8");
  const matches = text.split("\n").filter((line) => line.startsWith(`${key} = `));
  if (matches.length !== 1) {
    throw new Error(`project.toml must declare '${key}' exactly once, found ${matches.length}`);
  }
  const value = /^[^=]+= *"?([^"]*)"?$/.exec(matches[0]);
  if (!value) throw new Error(`could not read '${key}' from project.toml`);
  return value[1];
}

const coreDir = resolveCore();
const coreCommit = capture("git", ["rev-parse", "HEAD"], coreDir);
const coreVersion = readCoreProjectValue(coreDir, "version");
const coreLanguageVersion = readCoreProjectValue(coreDir, "language_version");

console.log(`Core ${coreVersion} @ ${coreCommit}`);

const buildDir = join(coreDir, "build-wasm");
// The Core build stamps this SHA into the artifact, so a shallow or detached
// checkout still reports the right revision.
const buildEnv = { ...process.env, QUIDRA_CORE_COMMIT: coreCommit };

run("emcmake", [
  "cmake",
  "-S", coreDir,
  "-B", buildDir,
  "-DCMAKE_BUILD_TYPE=Release",
  "-DQUIDRA_WARNINGS_AS_ERRORS=ON",
], { env: buildEnv });
run("cmake", ["--build", buildDir, "--target", "quidra_wasm", "--parallel"], { env: buildEnv });

const outDir = join(root, "public", "wasm");
mkdirSync(outDir, { recursive: true });
for (const artifact of ["quidra-core.js", "quidra-core.wasm"]) {
  const from = join(buildDir, artifact);
  if (!existsSync(from)) throw new Error(`the Core build did not produce ${artifact}`);
  copyFileSync(from, join(outDir, artifact));
}

// Highlighting must not become a second opinion about the language, so the
// token inventory is extracted from Core rather than retyped here. If Core
// changes shape, this fails loudly instead of silently shipping a stale list.
function extractKeywords(coreDir) {
  const lexer = readFileSync(join(coreDir, "src", "lexer.cpp"), "utf8");
  const table = /static const std::unordered_map<std::string, TokenKind> keywords = \{([^}]*(?:\}[^;]*?)*?)\n\s*\};/s.exec(lexer);
  if (!table) throw new Error("could not locate the keyword table in src/lexer.cpp");
  const keywords = [...table[1].matchAll(/\{"([^"]+)",\s*TokenKind::/g)].map((m) => m[1]);
  if (keywords.length < 20) {
    throw new Error(`extracted only ${keywords.length} keywords from src/lexer.cpp; the table shape changed`);
  }
  return keywords;
}

function extractManifestLists(coreDir) {
  const manifest = JSON.parse(readFileSync(join(coreDir, "quidra.manifest.json"), "utf8"));
  const clean = (entries) =>
    [...new Set((entries ?? []).map((entry) => String(entry).split(" ")[0].trim()).filter(Boolean))];
  const types = clean(manifest.current_types);
  const builtins = clean(manifest.current_builtins);
  const modules = clean(manifest.standard_modules);
  if (types.length === 0 || builtins.length === 0 || modules.length === 0) {
    throw new Error("quidra.manifest.json did not carry the expected type/builtin/module lists");
  }
  return { types, builtins, modules };
}

const keywords = extractKeywords(coreDir);
const { types, builtins, modules } = extractManifestLists(coreDir);
console.log(
  `Extracted ${keywords.length} keywords, ${types.length} types, ` +
    `${builtins.length} builtins, ${modules.length} standard modules from Core`,
);

mkdirSync(join(root, "src", "generated"), { recursive: true });
writeFileSync(
  join(root, "src", "generated", "tokens.ts"),
  `// Generated by scripts/prepare-core.mjs from the Quidra Core checkout.
// Do not edit; do not commit. Keywords come from src/lexer.cpp, the rest from
// quidra.manifest.json, which project.toml generates.
export const KEYWORDS: readonly string[] = ${JSON.stringify(keywords.sort())};
export const TYPE_NAMES: readonly string[] = ${JSON.stringify(types.sort())};
export const BUILTINS: readonly string[] = ${JSON.stringify(builtins.sort())};
export const STANDARD_MODULES: readonly string[] = ${JSON.stringify(modules.sort())};
`,
);

let playgroundCommit = "unknown";
try {
  playgroundCommit = capture("git", ["rev-parse", "HEAD"], root);
} catch {
  // A source export without git history; the UI degrades to "unknown".
}

// Only facts the artifact cannot report about itself live here. The Core
// version, language version and commit are read back from the WebAssembly
// module at runtime, so they are never displayed from this file.
mkdirSync(join(root, "src", "generated"), { recursive: true });
writeFileSync(
  join(root, "src", "generated", "build-info.ts"),
  `// Generated by scripts/prepare-core.mjs. Do not edit; do not commit.
export const buildInfo = {
  playgroundCommit: ${JSON.stringify(playgroundCommit)},
  coreRef: ${JSON.stringify(coreRef)},
} as const;
`,
);

// Consumed by sync-version.mjs and by CI's equality check.
mkdirSync(workDir, { recursive: true });
writeFileSync(
  join(workDir, "core-metadata.json"),
  `${JSON.stringify({ coreVersion, coreLanguageVersion, coreCommit, coreRef }, null, 2)}\n`,
);

console.log(`Staged public/wasm/quidra-core.{js,wasm} from Core ${coreVersion} @ ${coreCommit}`);
