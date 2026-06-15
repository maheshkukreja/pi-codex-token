/**
 * Live model discovery against the codex `/models` endpoint.
 *
 * The account's available models are discovered at registration so the provider isn't
 * pinned to a hardcoded list. The endpoint needs only `Authorization: Bearer <PAT>` and
 * a `client_version` query param (no account-id / beta). Its per-model shape carries
 * `slug`, `display_name`, `context_window`, `input_modalities`,
 * `supported_reasoning_levels`, `visibility`, and `supported_in_api` — everything we
 * need except `maxTokens` (defaulted). Verified against the live endpoint; see AGENTS.md.
 *
 * Precedence:
 *   1. CODEX_MODELS env override (comma-separated ids) — no network
 *   2. live GET {codexBaseUrl}/models?client_version=… → visible, api-supported models
 *   3. FALLBACK_MODELS ([gpt-5.5]) on any failure / empty result
 *
 * Discovery never throws — it always degrades to FALLBACK_MODELS so registration can't break.
 */

import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { FetchImpl } from "./auth.js";
import {
  API_ID,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  ENV_MODELS,
  codexBaseUrl,
  codexClientVersion,
  httpTimeoutMs,
  modelsUrl,
} from "./config.js";
import { FALLBACK_MODELS } from "./models.js";
import { costForModel } from "./pricing.js";

/** The subset of the codex `/models` per-entry shape we consume. */
interface RawCodexModel {
  slug?: string;
  display_name?: string;
  context_window?: number;
  input_modalities?: string[];
  supported_reasoning_levels?: unknown[];
  visibility?: string;
  supported_in_api?: boolean;
}

function baseConfig(id: string, env: NodeJS.ProcessEnv): ProviderModelConfig {
  return {
    id,
    name: id,
    api: API_ID,
    baseUrl: codexBaseUrl(env),
    reasoning: true,
    input: ["text"],
    cost: costForModel(id),
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  };
}

function toConfig(raw: RawCodexModel, env: NodeJS.ProcessEnv): ProviderModelConfig | undefined {
  // Type-guard every field: the /models payload is untrusted wire data, so a single
  // malformed entry (e.g. a non-string slug) must be skipped, not throw inside .map()
  // and degrade the whole batch to FALLBACK_MODELS.
  const id = typeof raw.slug === "string" ? raw.slug.trim() : "";
  if (!id) return undefined;
  const modalities = Array.isArray(raw.input_modalities)
    ? raw.input_modalities.filter((m): m is "text" | "image" => m === "text" || m === "image")
    : [];
  const name = typeof raw.display_name === "string" && raw.display_name.trim() ? raw.display_name.trim() : id;
  return {
    ...baseConfig(id, env),
    name,
    reasoning: Array.isArray(raw.supported_reasoning_levels) && raw.supported_reasoning_levels.length > 0,
    input: modalities.length ? modalities : ["text"],
    contextWindow: typeof raw.context_window === "number" ? raw.context_window : DEFAULT_CONTEXT_WINDOW,
  };
}

/** Build configs for an explicit CODEX_MODELS override (generic defaults per id). */
function fromOverride(value: string, env: NodeJS.ProcessEnv): ProviderModelConfig[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((id) => baseConfig(id, env));
}

export async function discoverModels(
  pat: string,
  fetchImpl: FetchImpl = globalThis.fetch,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProviderModelConfig[]> {
  const override = env[ENV_MODELS]?.trim();
  if (override) {
    const models = fromOverride(override, env);
    return models.length ? models : FALLBACK_MODELS;
  }

  try {
    const url = `${modelsUrl(env)}?client_version=${encodeURIComponent(codexClientVersion(env))}`;
    const res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${pat}` },
      signal: AbortSignal.timeout(httpTimeoutMs(env)),
    });
    if (!res.ok) return FALLBACK_MODELS;
    const data = (await res.json()) as { models?: RawCodexModel[] };
    const models = (data.models ?? [])
      .filter((m) => m.visibility === "list" && m.supported_in_api !== false)
      .map((m) => toConfig(m, env))
      .filter((m): m is ProviderModelConfig => m !== undefined);
    return models.length ? models : FALLBACK_MODELS;
  } catch {
    return FALLBACK_MODELS;
  }
}
