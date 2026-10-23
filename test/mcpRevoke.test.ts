import { describe, it, expect, vi, afterEach } from "vitest";

// oxjob #1762: a tool id with ".." segments must not reach another API path, and only a 401 (the key itself refused)
// revokes a grant: just the grant that made the request, never every grant the user holds. The OAuth library imports
// cloudflare:workers, so it is faked: /mcp goes to the API handler with the grant's props, the rest to the public one.
const PROPS = { userId: "user-1", apiKey: "k-personal", keyKind: "personal", personalApiKey: "k-personal" };
vi.mock("@cloudflare/workers-oauth-provider", () => {
  class AuthorizationError extends Error {}
  class OAuthProvider {
    constructor(private opts: any) {}
    fetch(req: Request, env: any, ctx: any) {
      return new URL(req.url).pathname.startsWith("/mcp")
        ? this.opts.apiHandler.fetch(req, env, Object.assign(ctx, { props: PROPS }))
        : this.opts.defaultHandler.fetch(req, env, ctx);
    }
  }
  return { AuthorizationError, OAuthProvider };
});
vi.mock("../src/sentry", () => ({
  reportError: () => {},
  withErrorReporting: (_inv: any, _name: string, fn: () => any) => fn(),
}));

const worker = (await import("../src/index")).default;

afterEach(() => vi.unstubAllGlobals());

async function callTool(name: string, args: Record<string, any>, api: (url: string) => Response) {
  const fetchMock = vi.fn(async (url: any) => api(String(url)));
  vi.stubGlobal("fetch", fetchMock);
  const provider = { revokeGrant: vi.fn(async () => {}), listUserGrants: vi.fn(async () => ({ items: [] })) };
  const waits: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => { waits.push(p); }, passThroughOnException: () => {} } as any;
  const env = {
    ENVIRONMENT: "test", OPENALEX_API_BASE: "https://api.openalex.org", MCP_PUBLIC_URL: "https://mcp.example.test/mcp",
    OPENALEX_WEB_BASE: "https://openalex.org", USERS_API_BASE: "https://user.openalex.org", OAUTH_KV: {}, OAUTH_PROVIDER: provider,
  } as any;
  const res = await worker.fetch(new Request("https://mcp.example.test/mcp", {
    method: "POST",
    headers: { Authorization: "Bearer user-1:grant-9:secret", "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  }), env, ctx);
  const body: any = await res.json();
  await Promise.all(waits);
  return { result: body.result, provider, urls: fetchMock.mock.calls.map((c) => String(c[0])) };
}

const json = (status: number, body: any) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("/mcp ids and grant revocation", () => {
  it("refuses a work id with dot segments before any request", async () => {
    for (const id of ["../snapshots/credentials", "10.1234/../../../../../snapshots/credentials"]) {
      const { result, provider, urls } = await callTool("get_work", { id }, () => json(403, { error: "Plan upgrade required" }));
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/not a work ID/);
      expect(urls).toEqual([]);
      expect(provider.revokeGrant).not.toHaveBeenCalled();
    }
  });

  it("resolve_references reports a dot-segment DOI as no match and requests nothing", async () => {
    const { result, urls } = await callTool("resolve_references", { references: ["Smith 2020. doi:10.1234/../../../../../snapshots/credentials"] }, () => json(200, { results: [] }));
    expect(urls.filter((u) => u.includes("snapshots"))).toEqual([]);
    expect(JSON.parse(result.content[0].text).results[0].match).toBe("none");
  });

  it("revokes nothing on a 403 (a plan refusal for a key that works)", async () => {
    const { result, provider } = await callTool("get_work", { id: "W2741809807" }, () => json(403, { error: "Plan upgrade required", message: "Upgrade." }));
    expect(result.isError).toBe(true);
    expect(provider.revokeGrant).not.toHaveBeenCalled();
    expect(provider.listUserGrants).not.toHaveBeenCalled();
  });

  it("revokes only this request's grant on a 401", async () => {
    const { result, provider } = await callTool("get_work", { id: "W2741809807" }, () => json(401, { error: "Invalid or missing API key" }));
    expect(result.isError).toBe(true);
    expect(provider.revokeGrant).toHaveBeenCalledTimes(1);
    expect(provider.revokeGrant).toHaveBeenCalledWith("grant-9", "user-1");
    expect(provider.listUserGrants).not.toHaveBeenCalled();
  });
});
