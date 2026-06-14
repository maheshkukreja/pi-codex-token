/**
 * Credential + account-id lifecycle.
 *
 * Pure and provider-agnostic. The PAT is opaque (`at-…`, not a JWT) so the
 * `chatgpt-account-id` cannot be decoded from it — it is resolved out-of-band via
 * the codex whoami endpoint and cached, keyed by SHA-256(PAT) so PAT rotation
 * auto-invalidates the cache and the raw PAT is never written to disk.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  ENV_ACCOUNT_ID,
  ENV_CODEX_HOME,
  ENV_PAT_PRIMARY,
  ENV_PI_AGENT_HOME,
  PAT_ENV_VARS,
  PAT_PREFIX,
  httpTimeoutMs,
  whoamiUrl,
} from "./config.js";

/** A fetch-compatible function. The DI seam for whoami (overridable in tests). */
export type FetchImpl = typeof fetch;

export type CredentialSource = "pi-config" | "env" | "codex-auth-json";

export interface ResolvedCredentials {
  pat: string;
  source: CredentialSource;
}

/**
 * Raised when a PAT is rejected (401/403) by whoami or the codex backend.
 * PATs are NOT auto-refreshable (unlike OAuth) — the only recovery is minting a
 * new one, so the message is actionable.
 */
export class PatAuthError extends Error {
  constructor(public readonly httpStatus?: number) {
    super(
      `Codex PAT rejected${httpStatus ? ` (HTTP ${httpStatus})` : ""}. The personal access ` +
        `token is expired, revoked, or invalid. PATs are NOT auto-refreshable — mint a new one ` +
        `in the ChatGPT admin console (Settings → Personal access tokens) and update ` +
        `${ENV_PAT_PRIMARY} (or the provider apiKey / ~/.codex/auth.json). If you switched workspaces, ` +
        `also clear the cached account-id at ~/.pi/agent/codex-pat-accountid.json.`,
    );
    this.name = "PatAuthError";
  }
}

/** True for HTTP 401/403, whether the value is a PatAuthError, an SDK error, or a 401 message. */
export function is401(e: unknown): boolean {
  if (e instanceof PatAuthError) return e.httpStatus === undefined || e.httpStatus === 401 || e.httpStatus === 403;
  const status = (e as { status?: unknown })?.status;
  if (status === 401 || status === 403) return true;
  // Message fallback: only the parenthesized status the inner provider emits
  // ("OpenAI API error (401): …"). Matching a bare 401/403 anywhere would misread
  // an id fragment or count in a 400/500 message as an auth failure.
  const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return /\((?:401|403)\)/.test(msg);
}

// --- PAT sourcing ------------------------------------------------------------

function authJsonPath(env: NodeJS.ProcessEnv): string {
  const home = env[ENV_CODEX_HOME];
  return home ? join(home, "auth.json") : join(homedir(), ".codex", "auth.json");
}

function validate(pat: string, source: CredentialSource): ResolvedCredentials {
  if (pat.startsWith("sk-")) {
    // sk- keys are 401 against the codex backend (wrong auth domain).
    throw new Error(
      "Got an OpenAI API key (sk-…), but the Codex backend requires a personal access token " +
        "(at-…). Use the plain `openai` provider for sk- keys.",
    );
  }
  if (!pat.startsWith(PAT_PREFIX)) {
    // Don't hard-fail (prefix could drift) but warn — the token is opaque, not a JWT.
    console.warn(`[codex-pat] PAT does not start with "${PAT_PREFIX}"; proceeding (opaque token).`);
  }
  return { pat, source };
}

/** First non-empty value among the accepted PAT env vars (precedence order). */
export function patFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const name of PAT_ENV_VARS) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

/**
 * Resolve the PAT. Precedence:
 *   1. pi-resolved ProviderConfig.apiKey (runtime --api-key / $ENV / !command)
 *   2. PAT env vars: CODEX_ACCESS_TOKEN, then CODEX_PAT
 *   3. ~/.codex/auth.json .personal_access_token (local `codex login`)
 */
export async function resolveCredentials(
  optionsApiKey?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedCredentials> {
  const fromConfig = optionsApiKey?.trim();
  if (fromConfig) return validate(fromConfig, "pi-config");

  const fromEnv = patFromEnv(env);
  if (fromEnv) return validate(fromEnv, "env");

  try {
    const raw = await readFile(authJsonPath(env), "utf8");
    const pat = (JSON.parse(raw) as { personal_access_token?: string }).personal_access_token?.trim();
    if (pat) return validate(pat, "codex-auth-json");
  } catch {
    /* no file / unreadable -> fall through */
  }

  throw new Error(
    `No Codex PAT found. Set ${ENV_PAT_PRIMARY}, configure the provider's apiKey ` +
      `(e.g. "$${ENV_PAT_PRIMARY}"), or run \`codex login --with-access-token\`.`,
  );
}

// --- account-id resolution (headless) ----------------------------------------

interface WhoamiMetadata {
  chatgpt_account_id?: string;
  account_id?: string;
}

const memCache = new Map<string, string>();

/** Test-only: reset the in-memory account-id cache. */
export function clearMemCache(): void {
  memCache.clear();
}

function patKey(pat: string): string {
  return createHash("sha256").update(pat).digest("hex").slice(0, 16);
}

function diskCachePath(env: NodeJS.ProcessEnv): string {
  const base = env[ENV_PI_AGENT_HOME] ?? join(homedir(), ".pi", "agent");
  return join(base, "codex-pat-accountid.json");
}

async function readDiskCache(key: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  try {
    const raw = await readFile(diskCachePath(env), "utf8");
    return (JSON.parse(raw) as Record<string, string>)[key];
  } catch {
    return undefined;
  }
}

async function writeDiskCache(key: string, id: string, env: NodeJS.ProcessEnv): Promise<void> {
  const path = diskCachePath(env);
  let current: Record<string, string> = {};
  try {
    current = JSON.parse(await readFile(path, "utf8")) as Record<string, string>;
  } catch {
    /* fresh file */
  }
  current[key] = id;
  await mkdir(dirname(path), { recursive: true });
  // Write to a unique temp file then atomically rename, so a concurrent reader (or
  // another process sharing this cache) never observes a torn/invalid JSON file.
  // (A last-writer-wins merge can still drop a key under cross-process races, but
  // that is self-healing: the next readDiskCache miss simply re-resolves via whoami.)
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(current, null, 2), { mode: 0o600 });
    await rename(tmp, path);
  } catch (e) {
    await unlink(tmp).catch(() => {}); // best-effort: don't leave an orphan .tmp behind
    throw e;
  }
}

async function accountIdFromWhoami(
  pat: string,
  fetchImpl: FetchImpl,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<string> {
  // Always bound by a timeout; also honor the caller's abort signal if given, so a
  // cancelled request doesn't leave whoami running to completion.
  const timeout = AbortSignal.timeout(httpTimeoutMs(env));
  const res = await fetchImpl(whoamiUrl(env), {
    headers: { Authorization: `Bearer ${pat}` },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (res.status === 401 || res.status === 403) throw new PatAuthError(res.status);
  if (!res.ok) {
    throw new Error(
      `Codex whoami failed with HTTP ${res.status}. The endpoint may have changed; mirror the ` +
        `official codex CLI (login/src/auth/personal_access_token.rs).`,
    );
  }
  const meta = (await res.json()) as WhoamiMetadata;
  const id = meta.chatgpt_account_id ?? meta.account_id;
  if (!id) throw new Error("Codex whoami returned no chatgpt_account_id (response shape drift).");
  return id;
}

/** Dev-only convenience: account-id from a local `codex login` (OAuth-mode) auth.json. */
async function accountIdFromAuthJson(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  try {
    const raw = await readFile(authJsonPath(env), "utf8");
    return (JSON.parse(raw) as { tokens?: { account_id?: string } })?.tokens?.account_id;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the chatgpt-account-id for a PAT. Order:
 *   1. CODEX_ACCOUNT_ID env override (recommended for headless use — synchronous, no network)
 *   2. in-memory cache (keyed by SHA-256(PAT))
 *   3. on-disk cache (~/.pi/agent/codex-pat-accountid.json, mode 0600, keyed by SHA-256(PAT))
 *   4. whoami(PAT)
 *   5. ~/.codex/auth.json .tokens.account_id (dev convenience only)
 *
 * A 401/403 from whoami throws PatAuthError. Other whoami failures fall back to the
 * dev auth.json before giving up.
 */
export async function resolveAccountId(
  pat: string,
  fetchImpl: FetchImpl = globalThis.fetch,
  env: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
): Promise<string> {
  const override = env[ENV_ACCOUNT_ID]?.trim();
  if (override) return override;

  const key = patKey(pat);

  const mem = memCache.get(key);
  if (mem) return mem;

  const fromDisk = await readDiskCache(key, env);
  if (fromDisk) {
    memCache.set(key, fromDisk);
    return fromDisk;
  }

  let id: string;
  try {
    id = await accountIdFromWhoami(pat, fetchImpl, env, signal);
  } catch (e) {
    if (e instanceof PatAuthError) throw e;
    // Best-effort dev fallback for a transient whoami failure (timeout/5xx). Do NOT
    // cache it: the local OAuth auth.json account-id may belong to a different
    // workspace than the PAT, and caching it would send a mismatched
    // chatgpt-account-id on every later request even after whoami recovers.
    const dev = await accountIdFromAuthJson(env);
    if (dev) return dev;
    throw e;
  }

  memCache.set(key, id);
  await writeDiskCache(key, id, env);
  return id;
}
