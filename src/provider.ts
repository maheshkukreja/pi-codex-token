/**
 * The provider stream function. Thin composition of auth + codex-envelope +
 * the reused `streamSimpleOpenAIResponses`.
 *
 * `streamSimple` must RETURN the stream object synchronously, but the async body
 * feeding it may await. So we create our own AssistantMessageEventStream, run the
 * work (credential + account-id resolution, which may hit whoami) in an async
 * IIFE, pipe the inner provider's events into our stream, and return ours
 * synchronously.
 */

import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  createAssistantMessageEventStream,
  streamSimpleOpenAIResponses,
} from "@earendil-works/pi-ai";
import {
  AUTH_FAILURE_MESSAGE,
  type FetchImpl,
  classifyAuthFailure,
  is401,
  resolveAccountId,
  resolveCredentials,
} from "./auth.js";
import { buildHeaders, makeOnPayload } from "./codex-envelope.js";
import { codexBaseUrl } from "./config.js";

/** Injectable seams for unit testing. Defaults are the real implementations. */
export interface StreamDeps {
  streamImpl?: typeof streamSimpleOpenAIResponses;
  createStream?: typeof createAssistantMessageEventStream;
  resolveCredentialsImpl?: typeof resolveCredentials;
  resolveAccountIdImpl?: typeof resolveAccountId;
  classifyAuthFailureImpl?: typeof classifyAuthFailure;
  fetchImpl?: FetchImpl;
}

function makeErrorMessage(
  model: Model<Api>,
  message: string,
  stopReason: "error" | "aborted",
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    errorMessage: message,
    timestamp: Date.now(),
  };
}

export function streamCodexPat(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
  deps: StreamDeps = {},
): AssistantMessageEventStream {
  const streamImpl = deps.streamImpl ?? streamSimpleOpenAIResponses;
  const createStream = deps.createStream ?? createAssistantMessageEventStream;
  const resolveCredentialsImpl = deps.resolveCredentialsImpl ?? resolveCredentials;
  const resolveAccountIdImpl = deps.resolveAccountIdImpl ?? resolveAccountId;
  const classifyAuthFailureImpl = deps.classifyAuthFailureImpl ?? classifyAuthFailure;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;

  const stream = createStream();

  (async () => {
    try {
      // Honor an already-cancelled request before doing any credential/whoami work;
      // the signal is also threaded into resolveAccountId so an in-flight whoami aborts.
      options?.signal?.throwIfAborted();
      const { pat } = await resolveCredentialsImpl(options?.apiKey);
      const accountId = await resolveAccountIdImpl(pat, fetchImpl, process.env, options?.signal);

      const headers = buildHeaders(pat, accountId, options?.headers ?? {});
      // Re-tag to "openai-responses" for the inner call: it builds the body from
      // model.id/baseUrl/reasoning/compat, and (as of pi 0.79.10) validates that
      // model.api === "openai-responses" — so we must set the api field at RUNTIME,
      // not just cast the type, or the inner stream rejects it ("Mismatched api").
      const codexModel = { ...model, api: "openai-responses", baseUrl: codexBaseUrl() } as Model<"openai-responses">;

      const inner = streamImpl(codexModel, context, {
        ...options,
        headers,
        onPayload: makeOnPayload(context.systemPrompt),
      });

      for await (const ev of inner as AsyncIterable<AssistantMessageEvent>) {
        // The backend 401/403 arrives as an `error` event (the inner provider catches
        // SDK errors internally rather than throwing). The backend returns the SAME 401
        // for an invalid credential AND a valid-but-access-denied one, so an independent
        // whoami check classifies the cause and we surface an accurate, machine-matchable
        // message. (A caller-cancel mid-classify throws AbortError → caught below as `aborted`.)
        if (ev.type === "error" && is401(ev.error.errorMessage)) {
          const category = await classifyAuthFailureImpl(pat, fetchImpl, process.env, options?.signal);
          ev.error.errorMessage = AUTH_FAILURE_MESSAGE[category];
        }
        stream.push(ev);
      }
      stream.end();
    } catch (e) {
      // Thrown before/around the inner stream: missing/invalid PAT, sk- key, a whoami
      // 401/403 (PatAuthError — its message is already the actionable invalid-credential
      // text, no re-classification needed), or a cancellation. Report a caller cancel as
      // `aborted` (pi-ai's convention) so callers can branch on it; everything else is
      // `error`. (A timeout surfaces as TimeoutError → stays `error`, since whoami hung.)
      const reason: "error" | "aborted" =
        (e as { name?: string })?.name === "AbortError" ? "aborted" : "error";
      const message = e instanceof Error ? e.message : String(e);
      stream.push({ type: "error", reason, error: makeErrorMessage(model, message, reason) });
      stream.end();
    }
  })();

  return stream;
}
