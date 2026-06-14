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
import { type FetchImpl, PatAuthError, is401, resolveAccountId, resolveCredentials } from "./auth.js";
import { buildHeaders, makeOnPayload } from "./codex-envelope.js";
import { codexBaseUrl } from "./config.js";

/** Injectable seams for unit testing. Defaults are the real implementations. */
export interface StreamDeps {
  streamImpl?: typeof streamSimpleOpenAIResponses;
  createStream?: typeof createAssistantMessageEventStream;
  resolveCredentialsImpl?: typeof resolveCredentials;
  resolveAccountIdImpl?: typeof resolveAccountId;
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

  const stream = createStream();

  (async () => {
    try {
      // Honor an already-cancelled request before doing any credential/whoami work;
      // the signal is also threaded into resolveAccountId so an in-flight whoami aborts.
      options?.signal?.throwIfAborted();
      const { pat } = await resolveCredentialsImpl(options?.apiKey);
      const accountId = await resolveAccountIdImpl(
        pat,
        deps.fetchImpl ?? globalThis.fetch,
        process.env,
        options?.signal,
      );

      const headers = buildHeaders(pat, accountId, options?.headers ?? {});
      // The inner code only reads model.id/baseUrl/reasoning/compat, not the api
      // string, for body-building — so re-tagging to "openai-responses" is safe.
      const codexModel = { ...model, baseUrl: codexBaseUrl() } as Model<"openai-responses">;

      const inner = streamImpl(codexModel, context, {
        ...options,
        headers,
        onPayload: makeOnPayload(context.systemPrompt),
      });

      for await (const ev of inner as AsyncIterable<AssistantMessageEvent>) {
        // The backend 401 arrives as an `error` event (the inner provider catches
        // SDK errors internally rather than throwing) — remap its message so the
        // user gets the same actionable "mint a new PAT" text as a whoami 401.
        if (ev.type === "error" && is401(ev.error.errorMessage)) {
          ev.error.errorMessage = new PatAuthError(401).message;
        }
        stream.push(ev);
      }
      stream.end();
    } catch (e) {
      // Thrown before/around the inner stream: missing/invalid PAT, sk- key, a
      // whoami 401/403 (PatAuthError), or a cancellation. Funnel 401s through the
      // actionable message, and report a caller cancellation as `aborted` (pi-ai's
      // convention) rather than a generic error so callers can branch on it.
      // (A timeout surfaces as TimeoutError → stays `error`, since the backend hung.)
      const reason: "error" | "aborted" =
        (e as { name?: string })?.name === "AbortError" ? "aborted" : "error";
      const message = is401(e)
        ? new PatAuthError(e instanceof PatAuthError ? e.httpStatus : 401).message
        : e instanceof Error
          ? e.message
          : String(e);
      stream.push({ type: "error", reason, error: makeErrorMessage(model, message, reason) });
      stream.end();
    }
  })();

  return stream;
}
