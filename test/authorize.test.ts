import { describe, it, expect, vi } from "vitest";

// oxjob #1762: /authorize must never auto-redirect an error to a redirect URI the client registered itself (open DCR
// or CIMD). The OAuth library imports cloudflare:workers, so it is faked: its provider hands every request to the
// public handler, and parseAuthRequest is scripted per test.
vi.mock("@cloudflare/workers-oauth-provider", () => {
  class AuthorizationError extends Error {
    code: string; description: string; redirectUri?: string; state?: string; issuer?: string;
    constructor(code: string, o: { description: string; redirectUri?: string; state?: string; issuer?: string }) {
      super(o.description);
      this.code = code;
      this.description = o.description;
      this.redirectUri = o.redirectUri;
      this.state = o.state;
      this.issuer = o.issuer;
    }
  }
  class OAuthProvider {
    constructor(private opts: any) { (globalThis as any).__oauthProviderOptions = opts; }
    fetch(req: Request, env: any, ctx: any) { return this.opts.defaultHandler.fetch(req, env, ctx); }
  }
  return { AuthorizationError, OAuthProvider };
});
vi.mock("../src/sentry", () => ({
  reportError: () => {},
  withErrorReporting: (_inv: any, _name: string, fn: () => any) => fn(),
}));

const { AuthorizationError } = (await import("@cloudflare/workers-oauth-provider")) as any;
const worker = (await import("../src/index")).default;

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as any;
const env = (parseAuthRequest: () => Promise<any>, kv = new Map<string, string>()) => ({
  ENVIRONMENT: "test",
  OPENALEX_API_BASE: "https://api.openalex.org",
  MCP_PUBLIC_URL: "https://mcp.example.test/mcp",
  OPENALEX_WEB_BASE: "https://openalex.org",
  USERS_API_BASE: "https://user.openalex.org",
  OAUTH_KV: { put: async (k: string, v: string) => { kv.set(k, v); }, get: async (k: string) => kv.get(k) ?? null, delete: async (k: string) => { kv.delete(k); } },
  OAUTH_PROVIDER: { parseAuthRequest, lookupClient: async () => ({ clientName: "Some client" }) },
}) as any;

const authorize = (e: any) => worker.fetch(new Request("https://mcp.example.test/authorize?response_type=token&client_id=c1&redirect_uri=https%3A%2F%2Felsewhere.example%2Flanding&state=s1"), e, ctx);

describe("/authorize errors", () => {
  it("are shown on this host, never redirected to the self-registered redirect_uri", async () => {
    for (const code of ["unsupported_response_type", "invalid_request", "invalid_target"]) {
      const res = await authorize(env(async () => {
        throw new AuthorizationError(code, { description: "PKCE is required", redirectUri: "https://elsewhere.example/landing", state: "s1", issuer: "https://mcp.example.test" });
      }));
      expect(res.status).toBe(400);
      expect(res.headers.get("location")).toBeNull();
      const html = await res.text();
      expect(html).toContain(code);
      expect(html).not.toContain("elsewhere.example");
    }
  });

  it("escape the library's description", async () => {
    const res = await authorize(env(async () => { throw new AuthorizationError("invalid_request", { description: "<script>x</script>" }); }));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("&lt;script&gt;");
  });

  it("refuse a plain-http remote redirect URI from an older client or CIMD document (#2323)", async () => {
    const kv = new Map<string, string>();
    const res = await authorize(env(async () => ({ responseType: "code", clientId: "c1", redirectUri: "http://attacker.example/cb", scope: [], state: "s1" }), kv));
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.text()).not.toContain("attacker.example");
    expect(kv.size).toBe(0);
  });

  it("let a loopback http redirect URI through to the consent page (#2323)", async () => {
    const res = await authorize(env(async () => ({ responseType: "code", clientId: "c1", redirectUri: "http://localhost:33418/callback", scope: [], state: "s1" })));
    expect(res.status).toBe(302);
  });

  it("refuse other network and browser schemes, fragments and user info (#2323)", async () => {
    for (const redirectUri of ["ftp://attacker.example/cb", "ws://attacker.example/cb", "https://attacker.example/cb#x", "https://user@attacker.example/cb", "java\tscript:alert(1)"]) {
      const kv = new Map<string, string>();
      const res = await authorize(env(async () => ({ responseType: "code", clientId: "c1", redirectUri, scope: [], state: "s1" }), kv));
      expect(res.status, redirectUri).toBe(400);
      expect(res.headers.get("location")).toBeNull();
      expect(kv.size).toBe(0);
    }
  });

  it("leave a valid request going to the consent page", async () => {
    const kv = new Map<string, string>();
    const res = await authorize(env(async () => ({ responseType: "code", clientId: "c1", redirectUri: "https://elsewhere.example/landing", scope: [], state: "s1" }), kv));
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!).origin + new URL(res.headers.get("location")!).pathname).toBe("https://openalex.org/oauth/consent");
    expect(kv.size).toBe(1);
  });
});

describe("/oauth/callback (#2323)", () => {
  it("refuses a request parked before the redirect rule shipped, without redirecting", async () => {
    const id = "a".repeat(43);
    const kv = new Map<string, string>([[`pending:${id}`, JSON.stringify({ request: { responseType: "code", clientId: "c1", redirectUri: "http://attacker.example/cb", scope: [], state: "s1" }, clientName: "Claude", createdAt: Date.now() })]]);
    const res = await worker.fetch(new Request(`https://mcp.example.test/oauth/callback?request=${id}&code=x`), env(async () => ({}), kv), ctx);
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.text()).not.toContain("attacker.example");
  });
});

describe("registration callback (#2323)", () => {
  // The library rejects a registration when the callback returns an object ({code, description, status}) and allows
  // it on undefined (workers-oauth-provider 0.10.3, handleClientRegistration).
  const callback = () => (globalThis as any).__oauthProviderOptions.clientRegistrationCallback;

  it("refuses a plain-http remote redirect URI with invalid_redirect_uri", async () => {
    await authorize(env(async () => ({ responseType: "code", clientId: "c1", redirectUri: "https://elsewhere.example/landing", scope: [], state: "s1" })));
    expect(callback()({ clientMetadata: { redirect_uris: ["http://attacker.example/cb"] } })).toMatchObject({ code: "invalid_redirect_uri", status: 400 });
  });

  it("refuses an over-long client_name with invalid_client_metadata", () => {
    expect(callback()({ clientMetadata: { redirect_uris: ["https://a.example/cb"], client_name: "x".repeat(121) } })).toMatchObject({ code: "invalid_client_metadata", status: 400 });
  });

  it("allows Claude Code's loopback registration", () => {
    expect(callback()({ clientMetadata: { client_name: "Claude Code", redirect_uris: ["http://localhost:33418/callback"] } })).toBeUndefined();
  });
});
