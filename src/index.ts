/**
 * pi extension: register the `codex-token` provider so pi can use OpenAI Codex models
 * (e.g. gpt-5.5) authenticated with an opaque personal access token (PAT),
 * non-interactively.
 *
 * Thin wiring only — all logic lives in the src/ modules (see AGENTS.md):
 *   config.ts          constants + env-var names
 *   models.ts          the static FALLBACK_MODELS
 *   discover-models.ts live model discovery (/models endpoint) + CODEX_MODELS override
 *   auth.ts            resolveCredentials / resolveAccountId / caching / PatAuthError
 *   codex-envelope.ts  makeOnPayload + buildHeaders (the volatile contract)
 *   provider.ts        streamCodexPat (own-stream + async IIFE)
 */

import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { resolveCredentials } from "./auth.js";
import { API_ID, DEFAULT_CODEX_BASE_URL, ENV_PAT_PRIMARY, PROVIDER_NAME } from "./config.js";
import { discoverModels } from "./discover-models.js";
import { FALLBACK_MODELS } from "./models.js";
import { streamCodexPat } from "./provider.js";

/**
 * Best-effort model list at registration: if a PAT is available in the environment
 * (env or ~/.codex/auth.json), discover the account's models; otherwise use the static
 * fallback. Never throws — registration must not break on a discovery failure.
 */
export async function registrationModels(): Promise<ProviderModelConfig[]> {
  let pat: string;
  try {
    pat = (await resolveCredentials()).pat;
  } catch {
    return FALLBACK_MODELS; // no PAT at registration time
  }
  return discoverModels(pat);
}

export default async function (pi: ExtensionAPI): Promise<void> {
  pi.registerProvider(PROVIDER_NAME, {
    baseUrl: DEFAULT_CODEX_BASE_URL,
    apiKey: `$${ENV_PAT_PRIMARY}`,
    api: API_ID,
    streamSimple: (model, context, options) => streamCodexPat(model, context, options),
    models: await registrationModels(),
  });
}
