import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const worker = readFileSync(join(root, "runner", "cloudflare", "src", "index.js"), "utf8");
const dockerfile = readFileSync(join(root, "runner", "cloudflare", "Dockerfile"), "utf8");
const deploy = readFileSync(join(root, ".github", "workflows", "deploy.yml"), "utf8");
const limited = readFileSync(join(root, "runner", "limited_exec.py"), "utf8");
const config = JSON.parse(
  readFileSync(join(root, "runner", "cloudflare", "wrangler.json"), "utf8"),
);
const configure = readFileSync(
  join(root, "runner", "cloudflare", "scripts", "configure.mjs"),
  "utf8",
);
const cloudflarePackage = JSON.parse(
  readFileSync(join(root, "runner", "cloudflare", "package.json"), "utf8"),
);

describe("Cloudflare production runner", () => {
  it("isolates every execution and destroys the VM", () => {
    expect(worker).toContain("enableInternet = false");
    expect(worker).toMatch(/crypto\.randomUUID\(\)/);
    expect(worker).toMatch(/finally\s*{[\s\S]*await sandbox\.destroy\(\)/);
    expect(worker).toMatch(/QUIDRA_RUNNER_UID=10001/);
    expect(worker).toMatch(/QUIDRA_RUNNER_GID=10001/);
    expect(worker).toContain("env -i");
    expect(worker).toContain('transport: "rpc"');
    expect(worker).toContain("version: env.QUIDRA_VERSION");
    expect(config.vars.QUIDRA_VERSION).toBe("unknown");
    expect(configure).toContain("input.vars.QUIDRA_VERSION = coreVersion");
    expect(worker).not.toContain("compiler_version");
    expect(worker).toContain('"/v2/execute"');
    expect(worker).toContain("enableDefaultSession: false");
    expect(worker).toContain('const CONTROL_DIR = "/workspace/.quidra-playground-control"');
    expect(worker).toContain("install -d -m 0700");
    expect(worker).toContain("install -d -m 0770 -o 10001 -g 10001");
    expect(worker).toContain("timeout --signal=TERM --kill-after=1s");
    expect(worker).not.toContain("JOB_DIR");
    expect(worker).toContain("cwd: WORK_DIR");
    expect(limited).toMatch(/os\.setuid\(uid\)/);
    expect(limited).toMatch(/os\.setgid\(gid\)/);
  });

  it("rate limits execution and caps sandbox capacity", () => {
    expect(worker).toMatch(/RUNNER_RATE_LIMIT\.limit\(/);
    expect(config.ratelimits[0].simple).toEqual({ limit: 10, period: 60 });
    expect(config.containers[0].max_instances).toBe(4);
    expect(config.containers[0].instance_type).toBe("standard-1");
  });

  it("pins the Sandbox SDK and injects the exact Core revision at deploy time", () => {
    expect(dockerfile).toContain("docker.io/cloudflare/sandbox:0.12.10");
    expect(dockerfile).toContain("ARG QUIDRA_CORE_REF=develop");
    expect(deploy).toContain("QUIDRA_CORE_REF: ${{ steps.core.outputs.sha }}");
    expect(deploy).toContain("QUIDRA_CORE_VERSION: ${{ steps.core.outputs.version }}");
    expect(deploy).toContain("wrangler deploy --config wrangler.deploy.json");
    expect(cloudflarePackage.scripts.deploy).toBe(
      "wrangler deploy --config wrangler.deploy.json",
    );
  });

  it("keeps semantics in the real Quidra CLI", () => {
    expect(worker).toContain("/opt/quidra/bin/quidra build");
    expect(worker).toContain("/opt/quidra/bin/quidra run");
    expect(worker).not.toMatch(/\beval\(|new Function\(/);
  });
});
