# AGENTS.md — architecture & working notes for `pi-codex-token`

Read this before changing code. It explains *why* the plugin is shaped the way it is,
where the risky parts are, and the conventions to keep. (Also useful to humans.)

## What this is

A [pi](https://github.com/earendil-works/pi) extension that registers a **`codex-token`**
provider. It lets pi talk to the **OpenAI Codex backend** (`chatgpt.com/backend-api/codex`)
using model **`gpt-5.5`**, authenticated with an opaque **personal access token (PAT,
`at-…`)** instead of an interactive ChatGPT OAuth login. Target use: headless/CI.

## Why it has to be a custom provider (the core problem)

- pi's built-in `openai-codex` provider gets the required `chatgpt-account-id` header by
  **JWT-decoding** the credential. A PAT is **opaque** (not a JWT), so that path throws
  ("Failed to extract accountId from token"). The pi maintainer won't generalize it
  (upstream issues #2038/#2336 → "write a custom provider"). So we do.
- The codex backend itself **accepts a PAT fine (HTTP 200)** when given
  `Authorization: Bearer <PAT>` + a `chatgpt-account-id` sourced **out-of-band**.
- `sk-…` API keys do **not** work against the codex backend (different auth domain → 401).
  This is a PAT-only path by construction; we reject `sk-` with guidance.

## The contract we speak (UNDOCUMENTED — this is the whole risk)

Proven-200 request (verified against the live backend; secrets masked):

```
POST https://chatgpt.com/backend-api/codex/responses
Authorization: Bearer at-***
chatgpt-account-id: ***workspace-uuid***
OpenAI-Beta: responses=experimental
originator: pi
Content-Type: application/json
Accept: text/event-stream

{ "model":"gpt-5.5", "input":[{user…}], "stream":true, "store":false,
  "reasoning":{"effort":…}, "instructions":"…" }
```

Two backend gates that pi's generic provider does NOT satisfy out of the box:
1. **Top-level `instructions` is required.** pi's `convertResponsesMessages` instead
   inlines the system prompt as a `developer` turn inside `input` → backend returns
   `400 {"detail":"Instructions are required"}`. We fix this in `onPayload`.
2. **`store:false` / `stream:true`** are required (pi already sets these; we re-assert).

Model gate: only **`gpt-5.5`** is accepted on a ChatGPT account. `gpt-5.1` /
`gpt-5.1-codex` return `400 "model is not supported … with a ChatGPT account."`

Account-id: fetched from the codex **whoami** endpoint
(`GET https://auth.openai.com/api/accounts/v1/user-auth-credential/whoami`,
`Authorization: Bearer <PAT>`) → field `chatgpt_account_id`. It's a stable workspace
UUID, so we cache it (keyed by `SHA-256(PAT)` so rotation auto-invalidates and the raw
PAT is never written to disk).

Model discovery: `GET {codexBaseUrl}/models?client_version=<v>` with **only**
`Authorization: Bearer <PAT>` (no account-id / beta) returns
`{ models: [{ slug, display_name, context_window, input_modalities,
supported_reasoning_levels, visibility, supported_in_api, … }] }`. We keep the entries
with `visibility === "list"` and `supported_in_api !== false` and map `slug`→model id.
`maxTokens` is **not** in the response → defaulted (`DEFAULT_MAX_TOKENS`, unverified).
The endpoint requires the `client_version` query param but is lenient about its value.

## Module map (`src/`)

The architecture's #1 job is to **isolate the volatile, undocumented contract** so a
backend drift is a one-file edit, not a hunt.

| File | Owns | Volatility |
|---|---|---|
| `config.ts` | All constants + env-var names (base URLs, betas, `originator`, env names) and the env-derived `codexBaseUrl()` / `whoamiUrl()`. **No magic strings elsewhere.** | **HIGH** — contract values live here |
| `codex-envelope.ts` | `makeOnPayload(systemPrompt)` (the body transform) + `buildHeaders(pat, accountId)`. **THE volatile bit.** | **HIGH** — edit here when the backend drifts |
| `auth.ts` | `resolveCredentials` (PAT precedence + `sk-` rejection), `patFromEnv`, `resolveAccountId` (override → SHA-256(PAT) cache → whoami → dev auth.json), `PatAuthError`, `is401`. Pure, provider-agnostic. | MEDIUM |
| `discover-models.ts` | `discoverModels(pat)` — live `/models` fetch + `CODEX_MODELS` override + `FALLBACK_MODELS` degrade. Never throws. | MEDIUM |
| `models.ts` | `FALLBACK_MODELS` — the static `gpt-5.5` list used only when discovery is unavailable. | LOW |
| `pricing.ts` | `costForModel(id)` — looks up the canonical `cost` from pi's own registry via `getModel(provider, id)`. **No rate numbers live in this repo.** | LOW |
| `provider.ts` | `streamCodexPat` — composes auth + envelope + the reused `streamSimpleOpenAIResponses`. Thin. | LOW |
| `index.ts` | The async `ExtensionFactory` default export + `registrationModels()` — `pi.registerProvider(...)`. Thin wiring only. | LOW |

**Rule:** keep `provider.ts` and `index.ts` thin. Business logic belongs in the pure,
unit-testable functions (`resolveCredentials`, `resolveAccountId`, `makeOnPayload`,
`buildHeaders`).

## Runtime flow

```
pi → streamSimple(model, ctx, opts)              [provider.ts: streamCodexPat]
   ├─ create our own AssistantMessageEventStream and RETURN it synchronously
   └─ async IIFE (may await):
        ├─ pat       = resolveCredentials(opts.apiKey)         [auth.ts]
        ├─ accountId = resolveAccountId(pat)                   [auth.ts] (whoami unless cached/overridden)
        ├─ headers   = buildHeaders(pat, accountId)            [codex-envelope.ts]
        ├─ inner     = streamSimpleOpenAIResponses({...model, baseUrl: …/codex}, ctx,
        │                  { ...opts, headers, onPayload: makeOnPayload(ctx.systemPrompt) })
        └─ for await ev of inner → push to our stream (remap 401 → PatAuthError); then end()
```

### Why the own-stream + async-IIFE shape
`streamSimple` **must return the stream object synchronously**, but resolving the
account-id may need to `await` whoami. So we create the stream, return it immediately,
and feed it from an async IIFE. (The synchronous-`auth.json`-read approach an early spike
used does **not** work headless — a worker only has the PAT, no `~/.codex/auth.json`.)

## Non-obvious facts verified against the installed pi-ai (don't relitigate)

- `streamSimpleOpenAIResponses` and `createAssistantMessageEventStream` **are exported**
  from `@earendil-works/pi-ai`. `streamSimpleOpenAIResponses` builds the OpenAI SDK
  client with `baseURL = model.baseUrl`, **merges `options.headers` as `defaultHeaders`
  without clobbering** (so our auth headers win), sets `store:false`/`stream:true`, POSTs
  to `{baseUrl}/responses`, and reuses SSE parsing. We get transport + parsing for free.
- The terminal stream events are `{type:"done", reason, message}` and
  `{type:"error", reason:"error"|"aborted", error: AssistantMessage}`. **`reason` is
  required** on the error event.
- **The inner provider catches SDK/HTTP errors internally and emits them as `error`
  events — it does NOT throw.** So a backend 401 arrives as a forwarded `error` event,
  not an exception. That's why `streamCodexPat` remaps 401 **in two places**: the
  `catch` (covers whoami/credential failures that *do* throw) **and** while forwarding
  inner `error` events (covers the backend 401). Keep both.
- We re-tag the model as `Model<"openai-responses">` for the inner call only; the inner
  code reads `model.id/baseUrl/reasoning/compat`, not the api string, for body-building.

## Testing & conventions

- **Coverage bar: ≥99% lines/branches/functions on `src/**`** (enforced in
  `vitest.config.ts`). New code needs tests.
- **Dependency injection** is the testing strategy. `resolveCredentials`/`resolveAccountId`
  take an explicit `env` and `fetchImpl`; `streamCodexPat` takes a `deps` object
  (`streamImpl`, `createStream`, `resolveCredentialsImpl`, `resolveAccountIdImpl`,
  `fetchImpl`). Unit tests inject mocks and **never** hit the network. `node:fs/promises`
  and `node:os` are mocked with `vi.mock`.
- **`test/smoke.test.ts` is the only network test.** It hits the real codex endpoint,
  is excluded from coverage, and `skipIf`s when no PAT is in the env. It is the
  contract-drift early-warning a mock cannot give. Run it before/after touching
  `codex-envelope.ts` or `config.ts`.
- **`scripts/check-exports.mjs`** guards the pi-ai symbols we import
  (`streamSimpleOpenAIResponses`, `createAssistantMessageEventStream`, `getModel`) — run in CI.
- **Pricing comes from pi, not from us.** A custom provider supplies its own model defs, so
  pi multiplies tokens by whatever `cost` we register; if we leave it zero, every cost is $0.
  `pricing.ts` instead reads the canonical `cost` from pi's registry (`getModel`), so prices
  track the host pi version with **no hardcoded rates** here. The figures are *notional*
  (codex-token is a flat subscription, not per-token metered) — a metered-API equivalent for
  budgeting. Unknown ids get zero. Don't reintroduce a hand-maintained price table.
- **No build step.** pi loads `src/index.ts` (TypeScript) directly; `type: "module"`.
- **`@earendil-works/pi-{ai,coding-agent}` are `peerDependencies` (range `"*"`, the pi
  convention), not `dependencies`.** They are also pinned `devDependencies` (a concrete
  `0.79.x` range) so local typecheck/test resolve a known-good host, but they must
  **never** move to `dependencies` — a bundled second copy would create a divergent
  pi-ai instance and the `Model`/`Context`/stream types would stop being interchangeable
  with what the host passes in. The real compatibility guard is **not** the npm range —
  it's the `check-exports` CI gate + the live smoke test against the host pi version.
- **Vendor-neutral.** This is OSS. Do not add company-/deployment-specific names
  (env vars, infra, internal repos). The PAT env is `CODEX_ACCESS_TOKEN` (OpenAI's
  own convention; alias `CODEX_PAT`) — see `PAT_ENV_VARS` in `config.ts` for the
  precedence; operators wire their own secret to it or set the provider `apiKey` to
  any `$ENV` / `!command`.

## Playbooks

### The backend contract drifted (cat-and-mouse)
Symptom: the smoke test or a real run starts 400/401-ing where it worked before.
1. Reproduce with the smoke test (`CODEX_ACCESS_TOKEN=… npm run smoke`) to see the exact status/body.
2. Compare against the official OSS `codex` CLI's request building (it's the reference
   implementation OpenAI maintains) to see what header/beta/body field changed.
3. Fix in **`codex-envelope.ts`** (headers/body) and/or **`config.ts`** (URLs/betas).
   Update the proven-200 comment block in `codex-envelope.ts` and the envelope.test
   fixture. Nothing else should need to change.

### Models
Models are **discovered dynamically** from the account's `/models` endpoint at
registration (`discover-models.ts`); `CODEX_MODELS` (comma-separated ids) forces an
explicit list and `FALLBACK_MODELS` in `models.ts` is the no-PAT/failure degrade. To
change discovery behavior edit `discover-models.ts` + its test. To change the static
fallback edit `models.ts`. The backend allowlists models per ChatGPT account, so a
discovered model may still 400 on a request — the smoke test is the check. `maxTokens`
and (for the fallback) `["text"]` modalities are conservative defaults; discovered
entries use the modalities the backend reports.

### Account-id is NOT needed for /models
Discovery uses only the PAT. Don't add a whoami/account-id dependency to it.

### Bump the supported pi version
Bump the pinned `devDependencies` to the new `0.79.x`/next host version (peer stays `"*"`),
`npm install`, run `npm run check-exports` (catches dropped/renamed pi-ai symbols), then
`npm test` and the smoke test against the new host version. pi-ai churns and was renamed
once (`@mariozechner/pi-ai` → `@earendil-works/pi-ai`), so treat host bumps as risky.

### 401 handling
PATs are **not** auto-refreshable (unlike OAuth). On any 401/403 (whoami or backend) the
user gets a single actionable `PatAuthError`: mint a new PAT and update `CODEX_ACCESS_TOKEN`. Do
not add a silent-refresh path.
