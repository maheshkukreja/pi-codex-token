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
 * the proven shape post-hoc.
 */

import { DEFAULT_INSTRUCTIONS, OPENAI_BETA, ORIGINATOR } from "./config.js";

/**
 * Body transform for the `onPayload` hook. `onPayload` only receives
 * `(payload, model)` — not `context` — so the system prompt is captured here in a
 * closure. Carried verbatim from the proven spike.
 */
export function makeOnPayload(systemPrompt: string | undefined) {
  return (payload: unknown): unknown => {
    const body = payload as Record<string, unknown> & { input?: unknown[] };
    // 1. Hoist the system prompt to a top-level `instructions` (codex gate).
    body.instructions =
      systemPrompt && systemPrompt.length > 0 ? systemPrompt : DEFAULT_INSTRUCTIONS;
    // 2. Drop the leading developer/system turn convertResponsesMessages injected
    //    (it would otherwise duplicate the instructions inside `input`).
    if (Array.isArray(body.input)) {
      body.input = body.input.filter((m) => {
        const role = (m as { role?: string })?.role;
        return role !== "system" && role !== "developer";
      });
    }
    // 3. Enforce codex gates (buildParams already sets these; belt-and-suspenders).
    body.store = false;
    body.stream = true;
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
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    ...extra,
    Authorization: `Bearer ${pat}`,
    "chatgpt-account-id": accountId,
    "OpenAI-Beta": OPENAI_BETA,
    originator: ORIGINATOR,
  };
}
