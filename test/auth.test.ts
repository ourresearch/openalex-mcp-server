import { describe, it, expect, vi, afterEach } from "vitest";
import { storePending, takePending, consentUrl, exchangeCode, revokeAllGrants, keyLabel, randomId, type AuthEnv } from "../src/auth";

function fakeKv() {
  const m = new Map<string, string>();
  return {
    store: m,
    get: async (k: string) => m.get(k) ?? null,
    put: async (k: string, v: string) => { m.set(k, v); },
    delete: async (k: string) => { m.delete(k); },
  } as unknown as KVNamespace;
}

const env = (over: Partial<AuthEnv> = {}): AuthEnv => ({
  OAUTH_KV: fakeKv(),
  OAUTH_PROVIDER: {} as any,
  OPENALEX_WEB_BASE: "https://openalex.org",
  USERS_API_BASE: "https://user.openalex.org",
  OAUTH_EXCHANGE_SECRET: "s",
  ...over,
});

const req: any = { responseType: "code", clientId: "c", redirectUri: "http://localhost:1/cb", scope: [], state: "st" };

afterEach(() => vi.unstubAllGlobals());

describe("pending requests", () => {
  it("round-trips once, then is gone", async () => {
    const e = env();
    const id = await storePending(e, req, "Claude");
    expect(id).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    const p = await takePending(e, id);
    expect(p?.clientName).toBe("Claude");
    expect(p?.request.state).toBe("st");
    expect(await takePending(e, id)).toBeNull();
  });
  it("rejects malformed ids without touching KV", async () => {
    const e = env();
    expect(await takePending(e, "short")).toBeNull();
    expect(await takePending(e, "../../x".padEnd(30, "a"))).toBeNull();
    expect(await takePending(e, null)).toBeNull();
  });
  it("builds the consent URL", () => {
    const u = new URL(consentUrl(env(), "abc", "Claude", "https://mcp.openalex.org/oauth/callback"));
    expect(u.origin + u.pathname).toBe("https://openalex.org/oauth/consent");
    expect(u.searchParams.get("request")).toBe("abc");
    expect(u.searchParams.get("client")).toBe("Claude");
    expect(u.searchParams.get("return")).toBe("https://mcp.openalex.org/oauth/callback");
  });
});

describe("exchangeCode", () => {
  it("posts the code with the shared secret and checks the request id", async () => {
    const fetchMock = vi.fn(async (_url: any, init: any) => {
      expect(init.headers.Authorization).toBe("Bearer s");
      expect(JSON.parse(init.body)).toEqual({ code: "code1" });
      return new Response(JSON.stringify({ request_id: "r1", user_id: "u", api_key: "k", key_kind: "organization", organization_name: "Univ" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const r = await exchangeCode(env(), "code1", "r1");
    expect(r.api_key).toBe("k");
    expect(fetchMock.mock.calls[0][0]).toBe("https://user.openalex.org/oauth/exchange");
    await expect(exchangeCode(env(), "code1", "other")).rejects.toThrow(/different request/);
  });
  it("surfaces users-api rejections", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "Consent code is invalid or expired." }), { status: 400 })));
    await expect(exchangeCode(env(), "x", "r")).rejects.toMatchObject({ status: 400, message: /invalid or expired/ });
  });
  it("refuses to run without the secret", async () => {
    await expect(exchangeCode(env({ OAUTH_EXCHANGE_SECRET: undefined }), "x", "r")).rejects.toMatchObject({ status: 500 });
  });
});

describe("revokeAllGrants", () => {
  it("walks every page and revokes each grant", async () => {
    const revokeGrant = vi.fn(async () => {});
    const listUserGrants = vi.fn(async (_u: string, o: any) =>
      o?.cursor ? { items: [{ id: "g3" }] } : { items: [{ id: "g1" }, { id: "g2" }], cursor: "next" }
    );
    const n = await revokeAllGrants({ revokeGrant, listUserGrants } as any, "u1");
    expect(n).toBe(3);
    expect(revokeGrant.mock.calls.map((c: any) => c[0])).toEqual(["g1", "g2", "g3"]);
    expect(revokeGrant.mock.calls.every((c: any) => c[1] === "u1")).toBe(true);
  });
});

describe("keyLabel", () => {
  it("names the key in use", () => {
    expect(keyLabel({ keyKind: "personal" })).toBe("your personal OpenAlex key");
    expect(keyLabel({ keyKind: "organization", organizationName: "Univ X" })).toBe("the Univ X organization key");
  });
  it("randomId is url-safe", () => {
    expect(randomId()).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
