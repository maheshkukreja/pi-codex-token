/**
 * LIVE smoke test — NOT counted toward coverage (excluded in vitest.config.ts).
 *
 * Hits the real chatgpt.com/backend-api/codex endpoint through the actual provider.
 * This is the contract-drift early-warning a mock cannot provide: it catches pi-ai
 * export/behavior breakage AND undocumented codex body-gate / dated-beta drift.
 *
 * Requires a real PAT in one of the accepted env vars (CODEX_ACCESS_TOKEN, CODEX_PAT);
 * skipped otherwise. The gate uses the SAME precedence list as resolveCredentials so the
 * test runs whenever a PAT is available under any accepted name.
 */
import type { Api, AssistantMessageEvent, Context, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { API_ID, DEFAULT_CODEX_BASE_URL, PAT_ENV_VARS } from "../src/config.js";
import { discoverModels } from "../src/discover-models.js";
import { FALLBACK_MODELS } from "../src/models.js";
import { streamCodexPat } from "../src/provider.js";

const PAT = PAT_ENV_VARS.map((k) => process.env[k]).find(Boolean);

describe("live codex backend", () => {
  it.skipIf(!PAT)(
    "streams a real response from gpt-5.5",
    async () => {
      // Live discovery should reach the account's models and include gpt-5.5.
      const discovered = await discoverModels(PAT!);
      expect(discovered.map((m) => m.id)).toContain("gpt-5.5");

      const model: Model<Api> = {
        ...FALLBACK_MODELS[0]!,
        api: API_ID,
        provider: "codex-token",
        baseUrl: DEFAULT_CODEX_BASE_URL,
      };
      const context: Context = {
        systemPrompt: "You are a terse assistant.",
        messages: [{ role: "user", content: "Reply with exactly: SMOKE_OK", timestamp: Date.now() }],
      };

      const stream = streamCodexPat(model, context, { apiKey: PAT });

      let text = "";
      let terminal: AssistantMessageEvent | undefined;
      for await (const ev of stream as AsyncIterable<AssistantMessageEvent>) {
        if (ev.type === "text_delta") text += ev.delta;
        if (ev.type === "done" || ev.type === "error") terminal = ev;
      }

      if (terminal?.type === "error") {
        throw new Error(`codex backend returned an error: ${terminal.error.errorMessage}`);
      }
      expect(terminal?.type).toBe("done");
      expect(text).toContain("SMOKE_OK");
    },
    60_000,
  );
});
