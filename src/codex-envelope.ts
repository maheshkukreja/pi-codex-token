/**
 * THE volatile bit, isolated. When the OpenAI codex backend drifts, you edit
 * ONLY this file (plus config.ts) and the smoke-test fixture.
 *
 * Proven-200 request envelope (captured from the working spike, secrets masked):
 *
 *   POST https://chatgpt.com/backend-api/codex/responses
 *   Authorization: Bearer at-***
 *   chatgpt-account-id: ***UUID***
 *   OpenAI-Beta: responses=experimental
 *   originator: pi
 *   Content-Type: application/json
 *   Accept: text/event-stream
 *
 *   { "model":"gpt-5.5", "input":[{user…}], "stream":true, "store":false,
 *     "reasoning":{"effort":…}, "instructions":"…" }
 *
 * The body-delta vs what pi's generic openai-responses provider emits: codex
 * requires a TOP-LEVEL `instructions` string. `convertResponsesMessages` instead
 * inlines the system prompt as a `developer` turn inside `input`, so the backend
 * returns 400 {"detail":"Instructions are required"}. `makeOnPayload` reproduces
 * the proven shape post-hoc by hoisting those turns into `instructions`.
 *
 * The prompt is read from the payload, not from `context.systemPrompt`: pi >= 0.86
 * passes a `TranscriptContext` with no `systemPrompt` field (the prompt is a leading
 * `system` message), but every pi version renders it into these `input` turns.
 */

import { DEFAULT_INSTRUCTIONS, OPENAI_BETA, ORIGINATOR } from "./config.js";

/** Body transform for the `onPayload` hook. */
export function makeOnPayload() {
  return (payload: unknown): unknown => {
    const body = payload as Record<string, unknown> & { input?: unknown[] };
    // 1-2. Move the developer/system turns convertResponsesMessages injected into a
    //      top-level `instructions` (codex gate), dropping them from `input`.
    const prompts: string[] = [];
    if (Array.isArray(body.input)) {
      body.input = body.input.filter((m) => {
        const { role, content } = (m ?? {}) as { role?: string; content?: unknown };
        if (role !== "system" && role !== "developer") return true;
        if (typeof content === "string" && content.length > 0) prompts.push(content);
        return false;
      });
    }
    // No turn to hoist → keep an existing `instructions` (idempotent re-run), else default.
    const existing = typeof body.instructions === "string" ? body.instructions : "";
    body.instructions = prompts.length > 0 ? prompts.join("\n\n") : existing || DEFAULT_INSTRUCTIONS;
    // 3. Enforce codex gates (buildParams already sets these; belt-and-suspenders).
    body.store = false;
    body.stream = true;
    // 4. codex 400s on max_output_tokens; the proven-200 envelope omits it.
    delete body.max_output_tokens;
    return body;
  };
}

/**
 * The codex wire headers. `streamSimpleOpenAIResponses` merges these as the SDK's
 * `defaultHeaders` without clobbering, so our values win.
 */
export function buildHeaders(
  pat: string,
  accountId: string,
  extra: Record<string, string | null> = {},
): Record<string, string | null> {
  return {
    ...extra,
    Authorization: `Bearer ${pat}`,
    "chatgpt-account-id": accountId,
    "OpenAI-Beta": OPENAI_BETA,
    originator: ORIGINATOR,
  };
}
