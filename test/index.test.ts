import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/auth.js")>();
  return { ...actual, resolveCredentials: vi.fn() };
});
vi.mock("../src/discover-models.js", () => ({ discoverModels: vi.fn() }));

import { resolveCredentials } from "../src/auth.js";
import { API_ID, DEFAULT_CODEX_BASE_URL, PROVIDER_NAME } from "../src/config.js";
import { discoverModels } from "../src/discover-models.js";
import factory, { registrationModels } from "../src/index.js";
import { FALLBACK_MODELS } from "../src/models.js";

const DISCOVERED = [{ id: "gpt-5.4" }] as never;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveCredentials).mockResolvedValue({ pat: "at-x", source: "env" });
  vi.mocked(discoverModels).mockResolvedValue(DISCOVERED);
});

describe("registrationModels", () => {
  it("discovers models when a PAT is resolvable", async () => {
    expect(await registrationModels()).toBe(DISCOVERED);
    expect(discoverModels).toHaveBeenCalledWith("at-x");
  });

  it("falls back to the static list when no PAT is available", async () => {
    vi.mocked(resolveCredentials).mockRejectedValue(new Error("No Codex PAT found"));
    expect(await registrationModels()).toBe(FALLBACK_MODELS);
    expect(discoverModels).not.toHaveBeenCalled();
  });
});

describe("extension factory", () => {
  it("registers the codex-token provider with the assembled config + discovered models", async () => {
    const registerProvider = vi.fn();
    await factory({ registerProvider } as unknown as ExtensionAPI);

    expect(registerProvider).toHaveBeenCalledOnce();
    const [name, config] = registerProvider.mock.calls[0]!;
    expect(name).toBe(PROVIDER_NAME);
    expect(config.api).toBe(API_ID);
    expect(config.baseUrl).toBe(DEFAULT_CODEX_BASE_URL);
    expect(config.apiKey).toBe("$CODEX_ACCESS_TOKEN");
    expect(config.models).toBe(DISCOVERED);
    expect(typeof config.streamSimple).toBe("function");
  });

  it("wires streamSimple through to streamCodexPat (returns a stream object)", async () => {
    const registerProvider = vi.fn();
    await factory({ registerProvider } as unknown as ExtensionAPI);
    const { streamSimple } = registerProvider.mock.calls[0]![1];
    // No PAT in this env → the stream emits an error event, but the call must return
    // a stream object synchronously without throwing.
    const stream = streamSimple({ ...FALLBACK_MODELS[0], provider: PROVIDER_NAME }, { messages: [] }, {});
    expect(stream).toBeDefined();
    expect(typeof stream[Symbol.asyncIterator]).toBe("function");
  });
});
