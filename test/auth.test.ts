import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  rename: vi.fn(),
  unlink: vi.fn(),
}));
vi.mock("node:os", () => ({ homedir: vi.fn(() => "/home/test") }));

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import {
  AUTH_FAILURE_MESSAGE,
  PatAuthError,
  classifyAuthFailure,
  clearMemCache,
  is401,
  resolveAccountId,
  resolveCredentials,
} from "../src/auth.js";
import { AUTH_CATEGORY } from "../src/config.js";

const ENOENT = () => Promise.reject(new Error("ENOENT"));
const fetchOk = (body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
const fetchStatus = (status: number) =>
  vi.fn(async () => new Response("nope", { status })) as unknown as typeof fetch;

function diskKey(pat: string): string {
  return createHash("sha256").update(pat).digest("hex").slice(0, 16);
}

beforeEach(() => {
  clearMemCache();
  vi.mocked(readFile).mockReset();
  vi.mocked(writeFile).mockReset().mockResolvedValue(undefined);
  vi.mocked(mkdir).mockReset().mockResolvedValue(undefined as never);
  vi.mocked(rename).mockReset().mockResolvedValue(undefined);
  vi.mocked(unlink).mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("resolveCredentials", () => {
  it("prefers the pi-config apiKey", async () => {
    vi.mocked(readFile).mockImplementation(ENOENT);
    expect(await resolveCredentials("at-cfg", {})).toEqual({ pat: "at-cfg", source: "pi-config" });
    expect(readFile).not.toHaveBeenCalled();
  });

  it("falls back to the CODEX_ACCESS_TOKEN env var (primary)", async () => {
    vi.mocked(readFile).mockImplementation(ENOENT);
    expect(await resolveCredentials(undefined, { CODEX_ACCESS_TOKEN: "at-primary" })).toEqual({
      pat: "at-primary",
      source: "env",
    });
  });

  it("accepts the CODEX_PAT alias", async () => {
    vi.mocked(readFile).mockImplementation(ENOENT);
    expect(await resolveCredentials(undefined, { CODEX_PAT: "at-alias" })).toEqual({
      pat: "at-alias",
      source: "env",
    });
  });

  it("prefers CODEX_ACCESS_TOKEN over CODEX_PAT", async () => {
    vi.mocked(readFile).mockImplementation(ENOENT);
    expect(
      await resolveCredentials(undefined, { CODEX_ACCESS_TOKEN: "at-win", CODEX_PAT: "at-lose" }),
    ).toEqual({ pat: "at-win", source: "env" });
  });

  it("falls back to ~/.codex/auth.json personal_access_token", async () => {
    vi.mocked(readFile).mockResolvedValue(JSON.stringify({ personal_access_token: "at-file" }));
    const res = await resolveCredentials(undefined, {});
    expect(res).toEqual({ pat: "at-file", source: "codex-auth-json" });
    expect(vi.mocked(readFile).mock.calls[0]?.[0]).toBe("/home/test/.codex/auth.json");
  });

  it("honors CODEX_HOME for the auth.json path", async () => {
    vi.mocked(readFile).mockResolvedValue(JSON.stringify({ personal_access_token: "at-file" }));
    await resolveCredentials(undefined, { CODEX_HOME: "/custom" });
    expect(vi.mocked(readFile).mock.calls[0]?.[0]).toBe("/custom/auth.json");
  });

  it("throws an actionable error when no PAT is found anywhere", async () => {
    vi.mocked(readFile).mockImplementation(ENOENT);
    await expect(resolveCredentials(undefined, {})).rejects.toThrow(/No Codex PAT found/);
  });

  it("ignores an auth.json without a personal_access_token", async () => {
    vi.mocked(readFile).mockResolvedValue(JSON.stringify({ tokens: {} }));
    await expect(resolveCredentials(undefined, {})).rejects.toThrow(/No Codex PAT found/);
  });

  it("rejects an sk- API key with guidance", async () => {
    await expect(resolveCredentials("sk-live-xyz", {})).rejects.toThrow(/personal access token/);
  });

  it("warns but proceeds for an unexpected prefix", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await resolveCredentials("xx-weird", {})).toEqual({ pat: "xx-weird", source: "pi-config" });
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe("resolveAccountId", () => {
  it("returns the CODEX_ACCOUNT_ID override without any network/file access", async () => {
    const fetchImpl = fetchStatus(500);
    expect(await resolveAccountId("at-x", fetchImpl, { CODEX_ACCOUNT_ID: "override-id" })).toBe(
      "override-id",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("resolves via whoami, writes the disk cache, then serves the in-memory cache", async () => {
    vi.mocked(readFile).mockImplementation(ENOENT); // disk cache miss + fresh write
    const fetchImpl = fetchOk({ chatgpt_account_id: "acct1" });
    expect(await resolveAccountId("at-a", fetchImpl, {})).toBe("acct1");
    expect(writeFile).toHaveBeenCalledOnce();
    expect(rename).toHaveBeenCalledOnce(); // atomic temp-file → rename
    expect(mkdir).toHaveBeenCalledOnce();
    // second call: in-memory cache hit, no extra fetch
    expect(await resolveAccountId("at-a", fetchImpl, {})).toBe("acct1");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("serves a hit from the on-disk cache without calling whoami", async () => {
    const key = diskKey("at-disk");
    vi.mocked(readFile).mockResolvedValue(JSON.stringify({ [key]: "disk-id" }));
    const fetchImpl = fetchStatus(500);
    expect(await resolveAccountId("at-disk", fetchImpl, {})).toBe("disk-id");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("cleans up the temp file if the atomic rename fails (and swallows unlink errors)", async () => {
    vi.mocked(readFile).mockImplementation(ENOENT);
    vi.mocked(rename).mockRejectedValueOnce(new Error("EXDEV"));
    vi.mocked(unlink).mockRejectedValueOnce(new Error("already gone")); // exercise the swallow
    await expect(resolveAccountId("at-r", fetchOk({ chatgpt_account_id: "x" }), {})).rejects.toThrow(
      "EXDEV", // original error propagates, not the unlink failure
    );
    expect(unlink).toHaveBeenCalledOnce();
  });

  it("merges into an existing disk-cache file (different key present)", async () => {
    vi.mocked(readFile).mockResolvedValue(JSON.stringify({ otherkey: "x" }));
    const fetchImpl = fetchOk({ chatgpt_account_id: "acct2" });
    expect(await resolveAccountId("at-b", fetchImpl, {})).toBe("acct2");
    const written = JSON.parse(vi.mocked(writeFile).mock.calls[0]?.[1] as string);
    expect(written).toMatchObject({ otherkey: "x", [diskKey("at-b")]: "acct2" });
  });

  it("uses account_id when chatgpt_account_id is absent", async () => {
    vi.mocked(readFile).mockImplementation(ENOENT);
    expect(await resolveAccountId("at-c", fetchOk({ account_id: "legacy" }), {})).toBe("legacy");
  });

  it("threads a caller AbortSignal into whoami (combined with the timeout)", async () => {
    vi.mocked(readFile).mockImplementation(ENOENT);
    const controller = new AbortController();
    expect(
      await resolveAccountId("at-s", fetchOk({ chatgpt_account_id: "sig-id" }), {}, controller.signal),
    ).toBe("sig-id");
  });

  it.each([401, 403])("throws PatAuthError on whoami %i", async (status) => {
    vi.mocked(readFile).mockImplementation(ENOENT);
    await expect(resolveAccountId("at-d", fetchStatus(status), {})).rejects.toBeInstanceOf(
      PatAuthError,
    );
  });

  it("falls back to dev auth.json when whoami fails non-auth", async () => {
    vi.mocked(readFile).mockImplementation(async (p) => {
      const path = String(p);
      if (path.endsWith("auth.json")) return JSON.stringify({ tokens: { account_id: "dev-id" } });
      throw new Error("ENOENT"); // disk cache miss
    });
    expect(await resolveAccountId("at-e", fetchStatus(500), {})).toBe("dev-id");
  });

  it("does NOT cache the dev fallback — next call retries whoami and recovers", async () => {
    vi.mocked(readFile).mockImplementation(async (p) => {
      const path = String(p);
      if (path.endsWith("auth.json")) return JSON.stringify({ tokens: { account_id: "dev-id" } });
      throw new Error("ENOENT"); // disk cache miss (both calls)
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("err", { status: 500 })) // transient failure
      .mockResolvedValueOnce(new Response(JSON.stringify({ chatgpt_account_id: "who-id" }), { status: 200 }));
    const f = fetchImpl as unknown as typeof fetch;
    expect(await resolveAccountId("at-z", f, {})).toBe("dev-id"); // best-effort, not cached
    expect(await resolveAccountId("at-z", f, {})).toBe("who-id"); // whoami recovered
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("rethrows the whoami error when no dev auth.json fallback exists", async () => {
    vi.mocked(readFile).mockImplementation(ENOENT);
    await expect(resolveAccountId("at-f", fetchStatus(500), {})).rejects.toThrow(/whoami failed/);
  });

  it("throws on whoami response-shape drift (no id field)", async () => {
    vi.mocked(readFile).mockImplementation(ENOENT);
    await expect(resolveAccountId("at-g", fetchOk({}), {})).rejects.toThrow(/shape drift/);
  });
});

describe("classifyAuthFailure", () => {
  it.each([401, 403])("→ invalid when whoami rejects the credential (%i)", async (status) => {
    expect(await classifyAuthFailure("at-x", fetchStatus(status), {})).toBe(AUTH_CATEGORY.invalid);
  });

  it("→ accessDenied when whoami confirms a live credential (chatgpt_account_id)", async () => {
    expect(await classifyAuthFailure("at-x", fetchOk({ chatgpt_account_id: "acct" }), {})).toBe(
      AUTH_CATEGORY.accessDenied,
    );
  });

  it("→ accessDenied via the legacy account_id field", async () => {
    expect(await classifyAuthFailure("at-x", fetchOk({ account_id: "legacy" }), {})).toBe(
      AUTH_CATEGORY.accessDenied,
    );
  });

  it("→ undetermined on a 200 that carries no account-id", async () => {
    expect(await classifyAuthFailure("at-x", fetchOk({}), {})).toBe(AUTH_CATEGORY.undetermined);
  });

  it("→ undetermined on a 200 with an unparseable body", async () => {
    const f = vi.fn(async () => new Response("<html>edge</html>", { status: 200 })) as unknown as typeof fetch;
    expect(await classifyAuthFailure("at-x", f, {})).toBe(AUTH_CATEGORY.undetermined);
  });

  it("→ undetermined on a non-ok, non-auth whoami status", async () => {
    expect(await classifyAuthFailure("at-x", fetchStatus(500), {})).toBe(AUTH_CATEGORY.undetermined);
  });

  it("→ undetermined when whoami times out or the network fails", async () => {
    const timeout = vi.fn(async () => {
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    }) as unknown as typeof fetch;
    expect(await classifyAuthFailure("at-x", timeout, {})).toBe(AUTH_CATEGORY.undetermined);
    const network = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await classifyAuthFailure("at-x", network, {})).toBe(AUTH_CATEGORY.undetermined);
  });

  it("propagates a caller-initiated AbortError instead of misdiagnosing it", async () => {
    const f = vi.fn(async () => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    }) as unknown as typeof fetch;
    await expect(classifyAuthFailure("at-x", f, {}, new AbortController().signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});

describe("AUTH_FAILURE_MESSAGE", () => {
  it.each([
    [AUTH_CATEGORY.invalid, "provider_auth_invalid"],
    [AUTH_CATEGORY.accessDenied, "provider_access_denied"],
    [AUTH_CATEGORY.undetermined, "provider_auth_undetermined"],
  ])("prefixes %s with exactly one bracketed category token", (category, token) => {
    const msg = AUTH_FAILURE_MESSAGE[category];
    expect(msg.startsWith(`[${token}] `)).toBe(true);
    // exactly one bracketed token, at the start (the cloud-match contract)
    expect(msg.match(/\[[^\]]+\]/g)).toEqual([`[${token}]`]);
  });

  it("points access-denied at the access-tokens docs and rules out token rotation", () => {
    const msg = AUTH_FAILURE_MESSAGE[AUTH_CATEGORY.accessDenied];
    expect(msg).toContain("https://developers.openai.com/codex/enterprise/access-tokens");
    expect(msg).toMatch(/NOT help/);
  });

  it("PatAuthError carries the invalid-category message verbatim", () => {
    expect(new PatAuthError(401).message).toBe(AUTH_FAILURE_MESSAGE[AUTH_CATEGORY.invalid]);
  });
});

describe("is401", () => {
  it("classifies auth failures across shapes", () => {
    expect(is401(new PatAuthError())).toBe(true);
    expect(is401(new PatAuthError(401))).toBe(true);
    expect(is401(new PatAuthError(403))).toBe(true);
    expect(is401(new PatAuthError(500))).toBe(false);
    expect(is401({ status: 401 })).toBe(true);
    expect(is401({ status: 403 })).toBe(true);
    // message fallback: only the parenthesized status the inner provider emits
    expect(is401(new Error("OpenAI API error (401): bad token"))).toBe(true);
    expect(is401("OpenAI API error (403): forbidden")).toBe(true);
    expect(is401(new Error("something else"))).toBe(false);
    // a bare 401/403 not in parens (id fragment / count in a 4xx-5xx) is NOT auth
    expect(is401("request req_401abc failed (400)")).toBe(false);
    expect(is401(null)).toBe(false);
  });
});
