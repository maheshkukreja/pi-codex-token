import { describe, expect, it } from "vitest";
import { API_ID, DEFAULT_CODEX_BASE_URL, DEFAULT_MAX_TOKENS } from "../src/config.js";
import { FALLBACK_MODELS } from "../src/models.js";

describe("FALLBACK_MODELS", () => {
  it("is the gpt-5.5 static fallback", () => {
    expect(FALLBACK_MODELS.map((m) => m.id)).toEqual(["gpt-5.5"]);
  });

  it("uses the custom api id, text-only input, reasoning, and registry-sourced cost", () => {
    const m = FALLBACK_MODELS[0]!;
    expect(m.api).toBe(API_ID);
    expect(m.baseUrl).toBe(DEFAULT_CODEX_BASE_URL);
    expect(m.input).toEqual(["text"]);
    expect(m.reasoning).toBe(true);
    // cost comes from pi's registry (notional metered rate), not hardcoded zeros
    expect(m.cost).toEqual({ input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 });
    expect(m.contextWindow).toBe(272000);
    expect(m.maxTokens).toBe(DEFAULT_MAX_TOKENS);
  });
});
