/**
 * All constants and env-var names for the codex-token provider live here.
 *
 * The codex backend is an UNDOCUMENTED contract: the betas, headers, and base
 * URLs below can drift without notice. Keeping them in one file means a contract
 * change is a one-line edit here (or in codex-envelope.ts), not a hunt across the
 * package. The values were verified against a live codex request (see AGENTS.md).
 */

/** Provider id registered with pi. */
export const PROVIDER_NAME = "codex-token";

/**
 * Custom api id. Required when `streamSimple` is given, and chosen so it never
 * collides with pi's built-in `openai` / `openai-codex` / `openai-responses`.
 * Single source of truth for the api id across the package.
 */
export const API_ID = "codex-token-responses";

/** Default codex inference backend. The OpenAI SDK appends `/responses`. */
export const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";

/**
 * Machine-matchable category tokens for an auth/access failure. pi's error event has no
 * structured category field, so these ride as a leading `[token]` substring in the
 * surfaced `errorMessage` — the documented contract downstream consumers (e.g. the ASR
 * worker) match on. Stable strings: changing them is a breaking contract change.
 */
export const AUTH_CATEGORY = {
  /** Credential is expired/revoked/unknown — mint a new token. */
  invalid: "provider_auth_invalid",
  /** Credential is valid but not authorized to run Codex — fix the access policy. */
  accessDenied: "provider_access_denied",
  /** Couldn't verify the credential (whoami unavailable) — cause not established. */
  undetermined: "provider_auth_undetermined",
} as const;

export type AuthCategory = (typeof AUTH_CATEGORY)[keyof typeof AUTH_CATEGORY];

/** Default codex auth/whoami host (distinct from the inference host). */
export const DEFAULT_WHOAMI_URL =
  "https://auth.openai.com/api/accounts/v1/user-auth-credential/whoami";

/** Dated SSE beta the codex backend accepts today. */
export const OPENAI_BETA = "responses=experimental";

/** Sent as the `originator` header; matches the proven-200 request. */
export const ORIGINATOR = "pi";

/** Fallback when there is no system prompt (codex requires top-level instructions). */
export const DEFAULT_INSTRUCTIONS = "You are a helpful assistant.";

/** Opaque PATs start with this; sk- keys are rejected (wrong auth domain). */
export const PAT_PREFIX = "at-";

/** maxTokens is not returned by the /models endpoint; sensible default (unverified). */
export const DEFAULT_MAX_TOKENS = 128000;
/** contextWindow default when /models omits it. */
export const DEFAULT_CONTEXT_WINDOW = 272000;
/** `client_version` query param the /models endpoint requires. */
export const DEFAULT_CODEX_CLIENT_VERSION = "0.139.0";
/** Response timeout (ms) for the whoami / models fetches, so they can't hang forever. */
export const DEFAULT_HTTP_TIMEOUT_MS = 10000;

// --- env var names (no magic strings elsewhere) ------------------------------
/** Primary PAT env var — matches the OpenAI codex CLI convention (CODEX_ACCESS_TOKEN). */
export const ENV_PAT_PRIMARY = "CODEX_ACCESS_TOKEN";
/** PAT env var precedence (first non-empty wins). Primary first. */
export const PAT_ENV_VARS = [ENV_PAT_PRIMARY, "CODEX_PAT"] as const;
/** Static workspace UUID override — skips whoami entirely. */
export const ENV_ACCOUNT_ID = "CODEX_ACCOUNT_ID";
/** Comma-separated model-id override; skips live model discovery. */
export const ENV_MODELS = "CODEX_MODELS";
/** Override for the /models `client_version` query param. */
export const ENV_CLIENT_VERSION = "CODEX_CLIENT_VERSION";
/** Override (ms) for the whoami / models fetch timeout. */
export const ENV_HTTP_TIMEOUT_MS = "CODEX_HTTP_TIMEOUT_MS";
/** Mirrors codex: dir holding auth.json (local dev). */
export const ENV_CODEX_HOME = "CODEX_HOME";
/** Full whoami URL override (testing / mock). */
export const ENV_WHOAMI_URL = "CODEX_WHOAMI_URL";
/** Base-URL override for the auth host (mirrors codex personal_access_token.rs). */
export const ENV_AUTHAPI_BASE_URL = "CODEX_AUTHAPI_BASE_URL";
/** codex inference base-URL override (testing). */
export const ENV_CODEX_BASE_URL = "CODEX_BASE_URL";
/** Dir for the on-disk account-id cache. */
export const ENV_PI_AGENT_HOME = "PI_AGENT_HOME";

// --- env-derived values (functions so tests can override process.env) --------

/** The codex inference base URL, honoring CODEX_BASE_URL. */
export function codexBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env[ENV_CODEX_BASE_URL]?.trim() || DEFAULT_CODEX_BASE_URL;
}

/** The codex model-listing endpoint (`{codexBaseUrl}/models`), for discovery. */
export function modelsUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `${codexBaseUrl(env)}/models`;
}

/** The `client_version` query value the /models endpoint requires, honoring the override. */
export function codexClientVersion(env: NodeJS.ProcessEnv = process.env): string {
  return env[ENV_CLIENT_VERSION]?.trim() || DEFAULT_CODEX_CLIENT_VERSION;
}

/** Fetch timeout (ms), honoring CODEX_HTTP_TIMEOUT_MS; falls back to the default for blank/invalid values. */
export function httpTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[ENV_HTTP_TIMEOUT_MS]?.trim();
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_HTTP_TIMEOUT_MS;
}

/**
 * The whoami URL. Precedence: CODEX_WHOAMI_URL (full) → CODEX_AUTHAPI_BASE_URL
 * (base, with the whoami path appended) → default. Mirrors codex's override.
 */
export function whoamiUrl(env: NodeJS.ProcessEnv = process.env): string {
  const full = env[ENV_WHOAMI_URL]?.trim();
  if (full) return full;
  const base = env[ENV_AUTHAPI_BASE_URL]?.trim().replace(/\/+$/, "");
  return base ? `${base}/v1/user-auth-credential/whoami` : DEFAULT_WHOAMI_URL;
}
