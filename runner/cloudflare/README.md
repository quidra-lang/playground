# Cloudflare Sandbox deployment

This directory is the production isolation adapter for the Playground runner.
It does not implement Quidra semantics. The Worker accepts the existing runner
API and executes the real `quidra build` / `quidra run` commands inside a
fresh Cloudflare Sandbox VM for every request.

Security properties are explicit:

- `enableInternet = false`: submitted programs have no outbound Internet access;
- a random Sandbox id is created per Build/Run and `destroy()` is called in a
  `finally` block;
- executed Quidra processes drop to uid/gid 10001 and inherit the same rlimits as
  the ordinary runner;
- the Worker rate-limits execution by client IP and caps active Sandbox
  instances;
- the language version and exact Core SHA are injected into the runner build
  and metadata, so the browser still fails closed on a frontend/runner
  mismatch.

## Deploy

The main deployment workflow deploys this adapter automatically when both
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` GitHub secrets are
configured. It generates `wrangler.deploy.json` from the exact Core SHA already
used to build the page.

Set the repository variable `QUIDRA_RUNNER_URL` to the HTTPS URL of the
deployed Worker. The page keeps Build/Run disabled until that endpoint reports
the same language version and Core SHA as its WebAssembly frontend.

For a manual deployment:

```bash
cd runner/cloudflare
npm install
QUIDRA_CORE_REF=<40-char-core-sha> \
QUIDRA_CORE_VERSION=<version-from-project.toml> \
QUIDRA_PLAYGROUND_ORIGIN=https://quidra-lang.github.io \
node scripts/configure.mjs
npx wrangler deploy --config wrangler.deploy.json
```
