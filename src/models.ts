import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { API_ID, DEFAULT_CODEX_BASE_URL, DEFAULT_MAX_TOKENS } from "./config.js";
import { costForModel } from "./pricing.js";

/**
 * Static fallback model list. Used when live discovery (see `discover-models.ts`) is
 * unavailable — no PAT at registration, the `/models` endpoint errors, or it returns
 * nothing. The account's real model set is normally discovered dynamically.
 *
 * `gpt-5.5` is the proven model: it returned HTTP 200 on a ChatGPT account, and the
 * request shape is verified by the smoke test. `input: ["text"]` only — the proven run
 * was text-only; image is unverified against our SSE transport even though the backend
 * advertises it. (Discovered entries use the modalities the backend reports.)
 */
const FALLBACK_MODEL_ID = "gpt-5.5";

export const FALLBACK_MODELS: ProviderModelConfig[] = [
  {
    id: FALLBACK_MODEL_ID,
    name: "GPT-5.5 (Codex PAT)",
    api: API_ID,
    baseUrl: DEFAULT_CODEX_BASE_URL,
    reasoning: true,
    input: ["text"],
    cost: costForModel(FALLBACK_MODEL_ID), // price the same id we register, not a re-typed literal
    contextWindow: 272000,
    maxTokens: DEFAULT_MAX_TOKENS,
  },
];
