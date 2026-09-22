import { normalizeContext, type AssistantMessageEvent, type Model } from "@earendil-works/pi-ai";
import { streamSimpleOpenAIResponses } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { buildHeaders, makeOnPayload } from "../src/codex-envelope.js";
import { DEFAULT_INSTRUCTIONS, OPENAI_BETA, ORIGINATOR } from "../src/config.js";

/** The shape pi's generic openai-responses provider emits (system prompt as a developer turn). */
function recordedPayload() {
  return {
    model: "gpt-5.5",
    input: [
      { role: "developer", content: "You are terse." },
      { role: "user", content: [{ type: "input_text", text: "hi" }] },
    ],
    stream: true,
    store: false,
    reasoning: { effort: "none" },
    max_output_tokens: 128000,
  };
}

describe("makeOnPayload", () => {
  it("hoists the developer turn to top-level instructions and drops it from input", () => {
    const out = makeOnPayload()(recordedPayload()) as Record<string, unknown> & {
      input: { role: string }[];
    };
    expect(out.instructions).toBe("You are terse.");
    expect(out.input.some((m) => m.role === "developer" || m.role === "system")).toBe(false);
    expect(out.input).toHaveLength(1);
    expect(out.store).toBe(false);
    expect(out.stream).toBe(true);
    expect(out).not.toHaveProperty("max_output_tokens");
  });

  it("hoists a system turn too, joining several prompt turns in order", () => {
    const payload = {
      input: [
        { role: "system", content: "a" },
        { role: "user", content: "y" },
        { role: "developer", content: "b" },
      ],
    };
    const out = makeOnPayload()(payload) as { instructions: string; input: unknown[] };
    expect(out.instructions).toBe("a\n\nb");
    expect(out.input).toEqual([{ role: "user", content: "y" }]);
  });

  it("uses the default instructions when there is no non-empty prompt turn", () => {
    const run = (input: unknown) => (makeOnPayload()({ input }) as { instructions: string }).instructions;
    expect(run([{ role: "user", content: "y" }])).toBe(DEFAULT_INSTRUCTIONS);
    expect(run([{ role: "developer", content: "" }])).toBe(DEFAULT_INSTRUCTIONS);
    expect(run([{ role: "developer", content: [{ type: "input_text", text: "x" }] }])).toBe(DEFAULT_INSTRUCTIONS);
    expect(run([null])).toBe(DEFAULT_INSTRUCTIONS);
  });

  it("tolerates a non-array input", () => {
    const out = makeOnPayload()({ input: undefined }) as Record<string, unknown>;
    expect(out.instructions).toBe(DEFAULT_INSTRUCTIONS);
    expect(out.store).toBe(false);
  });

  it("is idempotent", () => {
    const fn = makeOnPayload();
    const once = fn(recordedPayload());
    const twice = fn(structuredClone(once));
    expect(twice).toEqual(once);
  });
});

describe("makeOnPayload against the host's real body builder", () => {
  it("carries pi's system prompt into instructions (pi >= 0.86 has no context.systemPrompt)", async () => {
    // No network: onPayload runs before the request, and throwing there ends the stream.
    let body: { instructions?: string; input?: { role?: string }[] } = {};
    const model = {
      id: "gpt-5.5", name: "gpt-5.5", api: "openai-responses", provider: "codex-token",
      baseUrl: "http://127.0.0.1:9", reasoning: true, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 272000, maxTokens: 128000,
    } as Model<"openai-responses">;
    const context = normalizeContext({
      systemPrompt: "You are the pi agent.",
      messages: [{ role: "user", content: "hi", timestamp: 0 }],
    });
    const stream = streamSimpleOpenAIResponses(model, context, {
      apiKey: "at-x",
      onPayload: (p: unknown) => {
        body = makeOnPayload()(p) as typeof body;
        throw new Error("stop before send");
      },
    });
    for await (const _ of stream as AsyncIterable<AssistantMessageEvent>);
    expect(body.instructions).toBe("You are the pi agent.");
    expect(body.input?.map((m) => m.role)).toEqual(["user"]);
  });
});

describe("buildHeaders", () => {
  it("produces the exact codex wire header set", () => {
    expect(buildHeaders("at-tok", "acct-uuid")).toEqual({
      Authorization: "Bearer at-tok",
      "chatgpt-account-id": "acct-uuid",
      "OpenAI-Beta": OPENAI_BETA,
      originator: ORIGINATOR,
    });
  });

  it("merges extra headers but never lets them clobber the codex headers", () => {
    const headers = buildHeaders("at-tok", "acct-uuid", {
      "X-Custom": "1",
      Authorization: "Bearer SHOULD_LOSE",
    });
    expect(headers["X-Custom"]).toBe("1");
    expect(headers.Authorization).toBe("Bearer at-tok");
  });
});
