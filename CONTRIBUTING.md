# Contributing

Thanks for contributing! Start with [`AGENTS.md`](./AGENTS.md) — it documents the
architecture, the module boundaries, and the conventions this project holds to.

## Setup

```bash
npm install
```

This installs the dev toolchain (vitest, typescript) and the pi host packages
(`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`) so typecheck and tests
resolve. At runtime, `pi` provides those packages itself — they are declared as
`peerDependencies` and must **not** be moved to `dependencies` (a bundled second copy
would create a divergent pi-ai instance; see `AGENTS.md`).

## Checks (all must pass)

```bash
npm run check          # tsc --noEmit (strict)
npm run check-exports  # guards the pi-ai symbols we depend on
npm test               # vitest unit suite + coverage (≥99% on src/**)
```

- **Coverage bar: ≥99% lines/branches/functions on `src/**`**, enforced in
  `vitest.config.ts`. New code must come with tests. Use the DI seams
  (`fetchImpl`, `streamImpl`, injected resolvers) to keep logic deterministic and
  offline — never hit the network in a unit test.
- The **live smoke test** (`npm run smoke`) hits the real codex endpoint and is the
  only thing allowed to do network I/O. It is excluded from coverage and skips
  automatically unless a PAT is set (`CODEX_ACCESS_TOKEN`, or the `CODEX_PAT` alias —
  it gates on the same `PAT_ENV_VARS` list the code resolves). Run it locally before
  changing anything in `src/codex-envelope.ts` or `src/config.ts`.

## Conventions

- Keep the volatile, undocumented codex contract isolated in `src/codex-envelope.ts`
  + `src/config.ts`. A backend drift should be a one-file edit there + a fixture
  update, not a hunt across the package.
- Match the surrounding code's comment density and style. Do not re-introduce
  vendor-/deployment-specific names — this is a vendor-neutral OSS plugin.
