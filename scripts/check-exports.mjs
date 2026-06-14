/**
 * CI gate (i): fail fast if pi-ai dropped/renamed the symbols we depend on.
 * Cheap, no network. Run against the exact host pi version this plugin targets.
 */
import * as piai from "@earendil-works/pi-ai";

const required = ["streamSimpleOpenAIResponses", "createAssistantMessageEventStream"];
const missing = required.filter((s) => typeof piai[s] !== "function");

if (missing.length) {
  console.error(`pi-ai missing required exports: ${missing.join(", ")}`);
  process.exit(1);
}
console.log(`pi-ai exports OK: ${required.join(", ")}`);
