/**
 * Model pricing, sourced from pi's own model registry — not hardcoded here.
 *
 * pi keeps canonical ($/million-token) prices in an auto-generated registry
 * (`pi-ai/models.generated.js`, `export const MODELS`) and exposes them via the
 * `getModel(provider, id)` accessor. Built-in providers get their `cost` from that
 * registry; a custom provider supplies its own model defs, so unless we look the
 * price up too, pi multiplies real token counts by a zero `cost` and every figure
 * comes out $0.
 *
 * We integrate with that registry instead of maintaining our own price table: the
 * plugin holds **no** rate numbers, so prices track whatever the host pi ships and a
 * pi-ai version bump updates them for free. New models are priced the moment pi knows
 * them; ids pi doesn't know fall back to zero.
 *
 * The figures are **notional**: codex-token auth is a flat ChatGPT subscription, not
 * per-token metered billing, so this is the metered-API equivalent — useful for
 * budgeting/usage comparison, not an actual invoice.
 */

import { getModel } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

type Cost = ProviderModelConfig["cost"];

/**
 * The minimal slice of pi's `getModel` we rely on: look a model up by provider + id
 * string and read its `cost`. (pi's real `getModel` is generic over known
 * provider/model-id literals, which can't type a runtime-discovered id — we only need
 * the loose lookup.) Injectable for tests.
 */
export type ModelLookup = (provider: string, id: string) => { cost?: Cost } | undefined;

const registryLookup = getModel as unknown as ModelLookup;

const ZERO_COST: Cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * Provider keys under which pi catalogs the OpenAI models the codex backend serves.
 * A given OpenAI model has identical pricing across these, so we take the first that
 * knows the id, preferring the codex provider as the closest match.
 */
const PRICE_PROVIDER_KEYS = ["openai-codex", "openai", "azure-openai-responses"];

/** Canonical cost for a model id, read from pi's registry (zero if pi doesn't know it). */
export function costForModel(id: string, lookup: ModelLookup = registryLookup): Cost {
  for (const provider of PRICE_PROVIDER_KEYS) {
    const cost = lookup(provider, id)?.cost;
    if (cost) {
      return {
        input: cost.input,
        output: cost.output,
        cacheRead: cost.cacheRead,
        cacheWrite: cost.cacheWrite,
      };
    }
  }
  return { ...ZERO_COST };
}
