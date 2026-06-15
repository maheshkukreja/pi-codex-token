import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS } from "../src/config.js";
import { discoverModels } from "../src/discover-models.js";
import { FALLBACK_MODELS } from "../src/models.js";

const fetchJson = (body: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("discoverModels — CODEX_MODELS override", () => {
  it("builds configs from the comma list without any network call", async () => {
    const fetchImpl = fetchJson({});
    const models = await discoverModels("at-x", fetchImpl, { CODEX_MODELS: "gpt-5.5, gpt-5.4 ,," });
    expect(models.map((m) => m.id)).toEqual(["gpt-5.5", "gpt-5.4"]);
    expect(models[0]).toMatchObject({
      input: ["text"],
      reasoning: true,
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MAX_TOKENS,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("falls back when the override is blank", async () => {
    expect(await discoverModels("at-x", fetchJson({}), { CODEX_MODELS: "  , ," })).toBe(FALLBACK_MODELS);
  });
});

describe("discoverModels — live /models", () => {
  it("maps visible api-supported models and filters the rest", async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            models: [
              {
                slug: "gpt-5.5",
                display_name: "GPT-5.5",
                context_window: 272000,
                input_modalities: ["text", "image", "video"],
                supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }],
                visibility: "list",
                supported_in_api: true,
              },
              { slug: "bare", visibility: "list", supported_in_api: true },
              { slug: "hidden", visibility: "hide", supported_in_api: true },
              { slug: "noapi", visibility: "list", supported_in_api: false },
              { visibility: "list", supported_in_api: true }, // no slug → dropped
            ],
          }),
          { status: 200 },
        ),
    );

    const models = await discoverModels("at-tok", fetchImpl as unknown as typeof fetch, {});
    expect(models.map((m) => m.id)).toEqual(["gpt-5.5", "bare"]);

    const five = models[0]!;
    expect(five).toMatchObject({
      name: "GPT-5.5",
      input: ["text", "image"], // "video" filtered out
      reasoning: true,
      contextWindow: 272000,
      maxTokens: DEFAULT_MAX_TOKENS,
      cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 }, // sourced from pi's registry
    });

    const bare = models[1]!;
    expect(bare).toMatchObject({
      name: "bare", // falls back to slug
      input: ["text"], // no modalities → text
      reasoning: false, // no reasoning levels
      contextWindow: DEFAULT_CONTEXT_WINDOW, // no context_window
    });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toContain("/models?client_version=0.139.0");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer at-tok" });
  });

  it("skips malformed entries instead of degrading the whole batch", async () => {
    const fetchImpl = fetchJson({
      models: [
        {
          slug: "good",
          display_name: "Good",
          context_window: 100,
          input_modalities: ["text"],
          supported_reasoning_levels: [{ effort: "low" }],
          visibility: "list",
          supported_in_api: true,
        },
        // non-string slug → skipped, must NOT throw inside .map()
        { slug: 42, visibility: "list", supported_in_api: true },
        // wrong-typed fields → safe defaults, entry still kept
        {
          slug: "  ws  ",
          display_name: "   ",
          context_window: "nope",
          input_modalities: "text",
          supported_reasoning_levels: "high",
          visibility: "list",
          supported_in_api: true,
        },
      ],
    });

    const models = await discoverModels("at-x", fetchImpl, {});
    expect(models.map((m) => m.id)).toEqual(["good", "ws"]); // bad entry skipped, others survive
    expect(models[0]).toMatchObject({ name: "Good", contextWindow: 100, reasoning: true });
    expect(models[1]).toMatchObject({
      name: "ws", // blank display_name → slug
      contextWindow: DEFAULT_CONTEXT_WINDOW, // non-number context_window → default
      reasoning: false, // non-array reasoning levels → false
      input: ["text"], // non-array modalities → text
    });
  });

  it("honors the CODEX_CLIENT_VERSION override in the query", async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ models: [] }), { status: 200 }),
    );
    await discoverModels("at-x", fetchImpl as unknown as typeof fetch, { CODEX_CLIENT_VERSION: "9.9.9" });
    expect(String(fetchImpl.mock.calls[0]![0])).toContain("client_version=9.9.9");
  });

  it("falls back on a non-OK response", async () => {
    expect(await discoverModels("at-x", fetchJson("nope", 500), {})).toBe(FALLBACK_MODELS);
  });

  it("falls back on an empty model list", async () => {
    expect(await discoverModels("at-x", fetchJson({ models: [] }), {})).toBe(FALLBACK_MODELS);
  });

  it("falls back when the response has no models field", async () => {
    expect(await discoverModels("at-x", fetchJson({}), {})).toBe(FALLBACK_MODELS);
  });

  it("falls back when fetch throws", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(await discoverModels("at-x", fetchImpl, {})).toBe(FALLBACK_MODELS);
  });
});
