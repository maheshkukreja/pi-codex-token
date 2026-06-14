import { describe, expect, it } from "vitest";
import {
  DEFAULT_CODEX_BASE_URL,
  DEFAULT_CODEX_CLIENT_VERSION,
  DEFAULT_HTTP_TIMEOUT_MS,
  DEFAULT_WHOAMI_URL,
  codexBaseUrl,
  codexClientVersion,
  httpTimeoutMs,
  modelsUrl,
  whoamiUrl,
} from "../src/config.js";

describe("codexBaseUrl", () => {
  it("defaults when env unset", () => {
    expect(codexBaseUrl({})).toBe(DEFAULT_CODEX_BASE_URL);
  });
  it("honors CODEX_BASE_URL", () => {
    expect(codexBaseUrl({ CODEX_BASE_URL: "https://example.test/codex" })).toBe(
      "https://example.test/codex",
    );
  });
  it("trims and ignores blank override", () => {
    expect(codexBaseUrl({ CODEX_BASE_URL: "   " })).toBe(DEFAULT_CODEX_BASE_URL);
  });
});

describe("whoamiUrl", () => {
  it("defaults when env unset", () => {
    expect(whoamiUrl({})).toBe(DEFAULT_WHOAMI_URL);
  });
  it("honors full CODEX_WHOAMI_URL override", () => {
    expect(whoamiUrl({ CODEX_WHOAMI_URL: "https://mock.test/whoami" })).toBe(
      "https://mock.test/whoami",
    );
  });
  it("appends the whoami path to CODEX_AUTHAPI_BASE_URL (trailing slash stripped)", () => {
    expect(whoamiUrl({ CODEX_AUTHAPI_BASE_URL: "https://auth.test/api/accounts/" })).toBe(
      "https://auth.test/api/accounts/v1/user-auth-credential/whoami",
    );
  });
});

describe("modelsUrl", () => {
  it("appends /models to the codex base url", () => {
    expect(modelsUrl({})).toBe(`${DEFAULT_CODEX_BASE_URL}/models`);
    expect(modelsUrl({ CODEX_BASE_URL: "https://example.test/codex" })).toBe(
      "https://example.test/codex/models",
    );
  });
});

describe("codexClientVersion", () => {
  it("defaults when env unset", () => {
    expect(codexClientVersion({})).toBe(DEFAULT_CODEX_CLIENT_VERSION);
  });
  it("honors CODEX_CLIENT_VERSION", () => {
    expect(codexClientVersion({ CODEX_CLIENT_VERSION: "1.2.3" })).toBe("1.2.3");
  });
});

describe("httpTimeoutMs", () => {
  it("defaults when env unset", () => {
    expect(httpTimeoutMs({})).toBe(DEFAULT_HTTP_TIMEOUT_MS);
  });
  it("honors a valid positive CODEX_HTTP_TIMEOUT_MS", () => {
    expect(httpTimeoutMs({ CODEX_HTTP_TIMEOUT_MS: "5000" })).toBe(5000);
  });
  it("falls back to the default for a non-numeric value", () => {
    expect(httpTimeoutMs({ CODEX_HTTP_TIMEOUT_MS: "soon" })).toBe(DEFAULT_HTTP_TIMEOUT_MS);
  });
  it("falls back to the default for a non-positive value", () => {
    expect(httpTimeoutMs({ CODEX_HTTP_TIMEOUT_MS: "0" })).toBe(DEFAULT_HTTP_TIMEOUT_MS);
  });
});
