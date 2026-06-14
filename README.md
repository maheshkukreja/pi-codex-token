# pi-codex-token

A [pi](https://github.com/earendil-works/pi) provider extension that registers a
`codex-token` provider so pi can use **`gpt-5.5` on the OpenAI Codex backend**
(`chatgpt.com/backend-api/codex`), authenticated **non-interactively with a Codex
personal/enterprise access token (PAT)**.

It lets you run Codex with a long-lived access token instead of an interactive
ChatGPT OAuth login — which is what makes it usable for headless/CI automation.

Why a separate provider: pi's built-in `openai-codex` reads the `chatgpt-account-id`
by JWT-decoding the credential, which an opaque PAT can't satisfy. This provider
fetches that id out-of-band (the codex `whoami` endpoint) instead, so a plain PAT
works.

> **Codex access tokens are an OpenAI Codex _enterprise_ feature.** A workspace admin
> mints a long-lived personal/enterprise access token (`at-…`) for non-interactive use;
> see OpenAI's docs:
> [Codex enterprise — access tokens](https://developers.openai.com/codex/enterprise/access-tokens).
> Without an enterprise plan you won't have a PAT — use pi's built-in `openai-codex`
> provider (interactive OAuth) instead.
>
> **This needs a PAT (`at-…`), not an OpenAI API key (`sk-…`).** The Codex backend is a
> different auth domain — `sk-…` keys are rejected (401). For `sk-…` keys, use pi's plain
> `openai` provider.

## Install / local dev

This is a no-build, single-file-style pi extension. Run it straight from a clone:

```bash
npm install                 # installs dev deps + the pi host packages (peer deps)
pi -e . --provider codex-token --model gpt-5.5 -p "Reply with exactly: SPIKE_OK"
```

`pi` resolves the extension's `@earendil-works/pi-*` imports from its own install at
runtime; `npm install` provides the same packages for local typecheck/test.

## Production use

`pi -e .` is the dev loop. In production you **install** the extension into the
environment where pi runs (a worker image, CI runner, server) and configure it via env:

1. **Distribute** — publish to npm, or pin a git tag/SHA for an internal build:
   ```bash
   pi install pi-codex-token                    # from npm
   # or, pinned to an immutable ref:
   pi install <git-url>#<tag-or-sha>
   ```
   `pi install` records the source in pi's settings, so the extension loads automatically
   on every subsequent pi run (no `-e` needed). In a Docker/image build, run the install
   step at build time so it's baked in.

2. **Configure** (env in the runtime):
   ```bash
   export CODEX_ACCESS_TOKEN=at-...     # the enterprise PAT (see above)
   export CODEX_ACCOUNT_ID=<uuid>       # optional but recommended headless — skips the whoami call
   ```

3. **Select the provider/model** — either per invocation
   (`pi --provider codex-token --model gpt-5.5 …`) or via pi's default provider/model config.

At startup pi loads the extension, the async factory discovers the account's models with
the PAT, and the `codex-token` provider is ready. Pin a tag/SHA (not a moving branch) for a
reproducible deploy, and gate upgrades on the `npm run smoke` contract test.

## Credentials

PAT precedence (first non-empty wins):

1. the provider `apiKey` (pi resolves `$ENV` / `!command` / `--api-key`)
2. `CODEX_ACCESS_TOKEN` env, then `CODEX_PAT` (first non-empty wins)
3. `~/.codex/auth.json` `.personal_access_token` (from `codex login --with-access-token`)

`sk-…` API keys are rejected — the codex backend is a different auth domain (use
pi's plain `openai` provider for those).

### Account-id (headless)

The `chatgpt-account-id` is a stable workspace UUID resolved in this order:

1. `CODEX_ACCOUNT_ID` env override (**recommended for headless/CI** — no network)
2. in-memory cache (keyed by `SHA-256(PAT)`)
3. on-disk cache `~/.pi/agent/codex-token-accountid.json` (mode 0600, keyed by `SHA-256(PAT)`)
4. codex `whoami` (`Authorization: Bearer <PAT>`)
5. `~/.codex/auth.json` `.tokens.account_id` (local dev only)

For headless use, set **both** `CODEX_ACCESS_TOKEN` and `CODEX_ACCOUNT_ID` so resolution
is fully synchronous with no network round-trip.

PATs are **not** auto-refreshable. On a 401 (whoami or backend), the error tells you
to mint a new PAT.

## Models

The provider **discovers the account's available models** at registration by calling the
codex `/models` endpoint with the PAT, and registers the ones the account exposes
(`visibility: list`, API-supported). No PAT at registration, a `/models` error, or an
empty result falls back to a static `gpt-5.5` entry.

- Set **`CODEX_MODELS`** (comma-separated ids, e.g. `gpt-5.5,gpt-5.4`) to skip discovery
  and pin an explicit list.
- `contextWindow` comes from `/models`; **`maxTokens` is a default** (not returned by the
  endpoint) and is unverified. The static fallback declares `input: ["text"]` (the proven
  path); discovered entries use the modalities the backend reports.

## Config knobs (env)

| Env var | Purpose |
|---|---|
| `CODEX_ACCESS_TOKEN` / `CODEX_PAT` | PAT source (first non-empty wins) |
| `CODEX_ACCOUNT_ID` | workspace UUID override (skips whoami) |
| `CODEX_MODELS` | comma-separated model-id list; skips live model discovery |
| `CODEX_HOME` | dir for `auth.json` (default `~/.codex`) |
| `CODEX_BASE_URL` | codex inference base URL override |
| `CODEX_WHOAMI_URL` / `CODEX_AUTHAPI_BASE_URL` | whoami URL override (testing) |
| `PI_AGENT_HOME` | dir for the on-disk account-id cache |

## Testing

```bash
npm test            # vitest unit suite + coverage (≥99% on src/**)
npm run smoke       # live request to the real codex endpoint (needs CODEX_ACCESS_TOKEN)
npm run check-exports
```

## How it works

The codex backend is an **undocumented** contract. The provider reuses pi-ai's
exported `streamSimpleOpenAIResponses` for the HTTP/SSE transport + parsing, injects
the codex auth headers, and reshapes the request body (top-level `instructions`,
`store:false`) to satisfy the backend's gates. When the contract drifts, the change
is confined to `src/codex-envelope.ts` + `src/config.ts`, and the smoke test is the
early-warning. See [`AGENTS.md`](./AGENTS.md) for the full architecture.

## Contributing

See [`AGENTS.md`](./AGENTS.md) (architecture + conventions) and
[`CONTRIBUTING.md`](./CONTRIBUTING.md).

## License

[MIT](./LICENSE).
