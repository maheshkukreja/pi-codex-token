/**
 * CI gate (i): fail fast if pi-ai dropped/renamed the symbols we depend on.
 * Cheap, no network. Run against the exact host pi version this plugin targets.
 */
import * as piai from "@earendil-works/pi-ai";
import * as compat from "@earendil-works/pi-ai/compat";

const required = {
  createAssistantMessageEventStream: piai,
  streamSimpleOpenAIResponses: compat,
  getModel: compat,
};
const missing = Object.entries(required)
  .filter(([s, mod]) => typeof mod[s] !== "function")
  .map(([s]) => s);

if (missing.length) {
  console.error(`pi-ai missing required exports: ${missing.join(", ")}`);
  process.exit(1);
}
console.log(`pi-ai exports OK: ${Object.keys(required).join(", ")}`);
