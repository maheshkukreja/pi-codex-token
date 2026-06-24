import type { Api, AssistantMessageEvent, Context, Model } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-ai")>();
  return { ...actual, streamSimpleOpenAIResponses: vi.fn() };
});
vi.mock("../src/auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/auth.js")>();
  return {
    ...actual,
    resolveCredentials: vi.fn(),
    resolveAccountId: vi.fn(),
    classifyAuthFailure: vi.fn(),
  };
});

import { streamSimpleOpenAIResponses } from "@earendil-works/pi-ai";
import {
  AUTH_FAILURE_MESSAGE,
  PatAuthError,
  classifyAuthFailure,
  resolveAccountId,
  resolveCredentials,
} from "../src/auth.js";
import { AUTH_CATEGORY, OPENAI_BETA } from "../src/config.js";
import { streamCodexPat } from "../src/provider.js";

const MODEL: Model<Api> = {
  id: "gpt-5.5",
  name: "GPT-5.5 (Codex PAT)",
  api: "codex-token-responses",
  provider: "codex-token",
  baseUrl: "https://placeholder/codex",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 272000,
  maxTokens: 128000,
};
const CONTEXT: Context = { systemPrompt: "You are terse.", messages: [] };

async function* gen(events: Partial<AssistantMessageEvent>[]) {
  for (const e of events) yield e as AssistantMessageEvent;
}
const errorEvent = (errorMessage: string) =>
  ({ type: "error", reason: "error", error: { errorMessage } }) as unknown as AssistantMessageEvent;

async function collect(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
  const out: AssistantMessageEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveCredentials).mockResolvedValue({ pat: "at-x", source: "env" });
  vi.mocked(resolveAccountId).mockResolvedValue("acct-uuid");
  vi.mocked(classifyAuthFailure).mockResolvedValue(AUTH_CATEGORY.invalid);
  vi.mocked(streamSimpleOpenAIResponses).mockImplementation(
    () => gen([{ type: "done", reason: "stop" }]) as never,
  );
});

describe("streamCodexPat (default deps)", () => {
  it("invokes the inner stream with the codex baseUrl, headers, and onPayload, then pipes events", async () => {
    const events = await collect(streamCodexPat(MODEL, CONTEXT, { apiKey: "at-x" }));
    expect(events.at(-1)?.type).toBe("done");

    const [codexModel, ctx, opts] = vi.mocked(streamSimpleOpenAIResponses).mock.calls[0]!;
    expect(codexModel.baseUrl).toBe("https://chatgpt.com/backend-api/codex");
    // Must be re-tagged at RUNTIME (not just cast): pi 0.79.10+ validates the inner
    // model.api === "openai-responses" or rejects with "Mismatched api".
    expect(codexModel.api).toBe("openai-responses");
    expect(ctx).toBe(CONTEXT);
    expect(opts?.headers).toMatchObject({
      Authorization: "Bearer at-x",
      "chatgpt-account-id": "acct-uuid",
      "OpenAI-Beta": OPENAI_BETA,
      originator: "pi",
    });
    expect(typeof opts?.onPayload).toBe("function");
  });

  it("merges caller-supplied headers", async () => {
    await collect(streamCodexPat(MODEL, CONTEXT, { headers: { "X-Trace": "1" } }));
    const opts = vi.mocked(streamSimpleOpenAIResponses).mock.calls[0]![2];
    expect(opts?.headers).toMatchObject({ "X-Trace": "1", "chatgpt-account-id": "acct-uuid" });
  });

  it("classifies a backend 401 error event via whoami and surfaces the category message", async () => {
    vi.mocked(classifyAuthFailure).mockResolvedValue(AUTH_CATEGORY.accessDenied);
    vi.mocked(streamSimpleOpenAIResponses).mockImplementation(
      () => gen([errorEvent("OpenAI API error (401): bad token")]) as never,
    );
    const ev = (await collect(streamCodexPat(MODEL, CONTEXT, {})))[0]!;
    expect(vi.mocked(classifyAuthFailure)).toHaveBeenCalledWith(
      "at-x",
      expect.any(Function),
      process.env,
      undefined,
    );
    expect((ev as { error: { errorMessage: string } }).error.errorMessage).toBe(
      AUTH_FAILURE_MESSAGE[AUTH_CATEGORY.accessDenied],
    );
  });

  it("surfaces the invalid-credential message when whoami rejects the PAT", async () => {
    vi.mocked(classifyAuthFailure).mockResolvedValue(AUTH_CATEGORY.invalid);
    vi.mocked(streamSimpleOpenAIResponses).mockImplementation(
      () => gen([errorEvent("OpenAI API error (403): nope")]) as never,
    );
    const ev = (await collect(streamCodexPat(MODEL, CONTEXT, {})))[0]!;
    expect((ev as { error: { errorMessage: string } }).error.errorMessage).toBe(
      AUTH_FAILURE_MESSAGE[AUTH_CATEGORY.invalid],
    );
  });

  it("propagates a caller-cancel during classification as reason 'aborted'", async () => {
    vi.mocked(classifyAuthFailure).mockRejectedValue(
      Object.assign(new Error("aborted"), { name: "AbortError" }),
    );
    vi.mocked(streamSimpleOpenAIResponses).mockImplementation(
      () => gen([errorEvent("OpenAI API error (401): bad token")]) as never,
    );
    const ev = (await collect(streamCodexPat(MODEL, CONTEXT, {})))[0]!;
    expect((ev as { reason: string }).reason).toBe("aborted");
    expect((ev as { error: { stopReason: string } }).error.stopReason).toBe("aborted");
  });

  it("passes through a non-401 backend error event unchanged", async () => {
    vi.mocked(streamSimpleOpenAIResponses).mockImplementation(
      () => gen([errorEvent("OpenAI API error (500): boom")]) as never,
    );
    const ev = (await collect(streamCodexPat(MODEL, CONTEXT, {})))[0]!;
    expect((ev as { error: { errorMessage: string } }).error.errorMessage).toBe(
      "OpenAI API error (500): boom",
    );
  });

  it("emits an error event when no PAT is found", async () => {
    vi.mocked(resolveCredentials).mockRejectedValue(new Error("No Codex PAT found. ..."));
    const ev = (await collect(streamCodexPat(MODEL, CONTEXT, {})))[0]!;
    expect(ev.type).toBe("error");
    expect((ev as { error: { errorMessage: string } }).error.errorMessage).toMatch(/No Codex PAT/);
    expect((ev as { error: { stopReason: string } }).error.stopReason).toBe("error");
  });

  it("maps a thrown PatAuthError (whoami 401) to the actionable message", async () => {
    vi.mocked(resolveAccountId).mockRejectedValue(new PatAuthError(401));
    const ev = (await collect(streamCodexPat(MODEL, CONTEXT, {})))[0]!;
    expect((ev as { error: { errorMessage: string } }).error.errorMessage).toBe(
      new PatAuthError(401).message,
    );
  });

  it("surfaces a thrown error's own message without re-classifying (catch path)", async () => {
    // A thrown auth failure is only ever a PatAuthError (whoami already classified it);
    // any other thrown Error surfaces its own message verbatim — no whoami re-check.
    vi.mocked(resolveCredentials).mockRejectedValue(Object.assign(new Error("Unauthorized"), { status: 401 }));
    const ev = (await collect(streamCodexPat(MODEL, CONTEXT, {})))[0]!;
    expect((ev as { reason: string }).reason).toBe("error");
    expect((ev as { error: { errorMessage: string } }).error.errorMessage).toBe("Unauthorized");
    expect(vi.mocked(classifyAuthFailure)).not.toHaveBeenCalled();
  });

  it("stringifies a non-Error rejection", async () => {
    vi.mocked(resolveCredentials).mockRejectedValue("weird failure");
    const ev = (await collect(streamCodexPat(MODEL, CONTEXT, {})))[0]!;
    expect((ev as { error: { errorMessage: string } }).error.errorMessage).toBe("weird failure");
  });

  it("reports an already-aborted request as reason 'aborted' and skips all work", async () => {
    const ev = (await collect(streamCodexPat(MODEL, CONTEXT, { signal: AbortSignal.abort() })))[0]!;
    expect(ev.type).toBe("error");
    expect((ev as { reason: string }).reason).toBe("aborted");
    expect((ev as { error: { stopReason: string } }).error.stopReason).toBe("aborted");
    expect(resolveCredentials).not.toHaveBeenCalled();
  });
});

describe("streamCodexPat (explicit deps)", () => {
  it("uses injected streamImpl/resolvers/fetchImpl over the defaults", async () => {
    const streamImpl = vi.fn(
      (..._args: Parameters<typeof streamSimpleOpenAIResponses>) =>
        gen([{ type: "done", reason: "stop" }]) as never,
    );
    const resolveCredentialsImpl = vi.fn(async () => ({ pat: "at-inj", source: "pi-config" as const }));
    const resolveAccountIdImpl = vi.fn(async () => "inj-acct");
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    const events = await collect(
      streamCodexPat(MODEL, CONTEXT, { apiKey: "at-inj" }, {
        streamImpl,
        resolveCredentialsImpl,
        resolveAccountIdImpl,
        fetchImpl,
      }),
    );

    expect(events.at(-1)?.type).toBe("done");
    expect(streamImpl).toHaveBeenCalledOnce();
    expect(vi.mocked(streamSimpleOpenAIResponses)).not.toHaveBeenCalled();
    expect(resolveAccountIdImpl).toHaveBeenCalledWith("at-inj", fetchImpl, process.env, undefined);
    expect(streamImpl.mock.calls[0]![2]?.headers).toMatchObject({
      Authorization: "Bearer at-inj",
      "chatgpt-account-id": "inj-acct",
    });
  });

  it("uses an injected classifyAuthFailureImpl for a backend 401 event", async () => {
    const classifyAuthFailureImpl = vi.fn(async () => AUTH_CATEGORY.undetermined);
    const streamImpl = vi.fn(
      (..._args: Parameters<typeof streamSimpleOpenAIResponses>) =>
        gen([errorEvent("OpenAI API error (401): bad token")]) as never,
    );
    const ev = (await collect(
      streamCodexPat(MODEL, CONTEXT, { apiKey: "at-x" }, { streamImpl, classifyAuthFailureImpl }),
    ))[0]!;
    expect(classifyAuthFailureImpl).toHaveBeenCalledOnce();
    expect(vi.mocked(classifyAuthFailure)).not.toHaveBeenCalled();
    expect((ev as { error: { errorMessage: string } }).error.errorMessage).toBe(
      AUTH_FAILURE_MESSAGE[AUTH_CATEGORY.undetermined],
    );
  });
});
