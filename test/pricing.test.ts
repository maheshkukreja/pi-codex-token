import { describe, expect, it, vi } from "vitest";
import { type ModelLookup, costForModel } from "../src/pricing.js";

describe("costForModel", () => {
  it("reads the canonical cost from pi's real registry (gpt-5.5)", () => {
    // Sourced from pi-ai, not hardcoded in the plugin — pinned host => deterministic.
    expect(costForModel("gpt-5.5")).toEqual({ input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 });
  });

  it("returns zero cost for an id pi's registry doesn't know", () => {
    expect(costForModel("totally-made-up-model")).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });

  it("falls through to the next provider key until one knows the id", () => {
    const lookup: ModelLookup = vi.fn((provider: string) =>
      provider === "openai" ? { cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 } } : undefined,
    );
    expect(costForModel("some-id", lookup)).toEqual({ input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 });
    expect(vi.mocked(lookup).mock.calls.length).toBeGreaterThan(1); // first key ("openai-codex") missed
  });

  it("skips a registry hit that has no cost and keeps looking", () => {
    const lookup: ModelLookup = vi.fn(() => ({})); // model present but no cost
    expect(costForModel("no-cost-id", lookup)).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });
});
