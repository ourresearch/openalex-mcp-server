/**
 * Headless OAuth login for tests: performs the exact flow an MCP client performs, with the one
 * browser step (the consent page on openalex.org) replaced by a direct call to users-api using a
 * test user's API key. No backdoor in the Worker: every hop is the production code path.
 *
 *   discovery → DCR → /authorize (capture pending id) → users-api /oauth/consent →
 *   /oauth/callback (capture auth code) → /oauth/token (PKCE) → access + refresh tokens
 */
import { createHash, randomBytes } from "node:crypto";

export interface LoginOptions {
  /** The MCP endpoint, e.g. http://localhost:8788/mcp */
  mcpUrl: string;
  /** users-api base the WORKER talks to; the test also posts consent there. */
  usersApiBase: string;
  /** A real user's OpenAlex API key (the "logged-in user" on the consent page). */
  userApiKey: string;
  clientName?: string;
}

export interface LoginResult {
  accessToken: string;
  refreshToken?: string;
  clientId: string;
  tokenEndpoint: string;
  keyKind?: string;
  organizationName?: string | null;
  /** Refresh with the current refresh token; rotates it. */
  refresh: () => Promise<{ accessToken: string; refreshToken?: string }>;
}

const b64url = (buf: Buffer) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function must(res: Response, what: string): Promise<any> {
  const text = await res.text();
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status} ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { throw new Error(`${what}: non-JSON body ${text.slice(0, 200)}`); }
}

function locationOf(res: Response, what: string): URL {
  const loc = res.headers.get("location");
  if (res.status < 300 || res.status > 399 || !loc) throw new Error(`${what}: expected a redirect, got HTTP ${res.status}`);
  return new URL(loc);
}

export async function oauthLogin(opts: LoginOptions): Promise<LoginResult> {
  const mcp = new URL(opts.mcpUrl);
  const origin = mcp.origin;
  const clientName = opts.clientName ?? "openalex-mcp smoke";

  // 1. Unauthenticated request must 401 with a resource_metadata challenge (what Claude looks for).
  const probe = await fetch(mcp, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
  if (probe.status !== 401) throw new Error(`unauthenticated /mcp: expected 401, got ${probe.status}`);
  const challenge = probe.headers.get("www-authenticate") ?? "";
  const rm = challenge.match(/resource_metadata="([^"]+)"/);
  if (!rm) throw new Error(`no resource_metadata in WWW-Authenticate: ${challenge}`);
  const prm = await must(await fetch(rm[1]), "protected resource metadata");
  if (prm.resource !== opts.mcpUrl) throw new Error(`resource metadata resource=${prm.resource} != ${opts.mcpUrl}`);
  const issuer: string = prm.authorization_servers?.[0] ?? origin;

  // 2. Authorization server metadata.
  const as = await must(await fetch(new URL("/.well-known/oauth-authorization-server", issuer)), "AS metadata");
  if (!as.code_challenge_methods_supported?.includes("S256")) throw new Error("S256 not advertised");
  const { authorization_endpoint, token_endpoint, registration_endpoint } = as;
  if (!registration_endpoint) throw new Error("no registration_endpoint (DCR)");

  // 3. Dynamic client registration (public client, loopback redirect like Claude Code).
  const redirectUri = "http://localhost:53682/callback";
  const reg = await must(
    await fetch(registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: clientName,
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    }),
    "client registration"
  );
  const clientId: string = reg.client_id;

  // 4. /authorize → consent redirect carrying the pending request id.
  const verifier = b64url(randomBytes(32));
  const challengeS256 = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(12));
  const authz = new URL(authorization_endpoint);
  authz.search = new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: redirectUri, scope: "openalex:query", state,
    code_challenge: challengeS256, code_challenge_method: "S256", resource: opts.mcpUrl,
  }).toString();
  const consent = locationOf(await fetch(authz, { redirect: "manual" }), "/authorize");
  if (!/\/oauth\/consent$/.test(consent.pathname)) throw new Error(`/authorize sent us to ${consent}`);
  const requestId = consent.searchParams.get("request");
  const returnUrl = consent.searchParams.get("return");
  if (!requestId || !returnUrl) throw new Error(`consent URL missing request/return: ${consent}`);
  if (consent.searchParams.get("client") !== clientName) throw new Error(`consent page shows client=${consent.searchParams.get("client")}`);

  // 5. What the consent page does when the user clicks Allow.
  const consentRes = await must(
    await fetch(new URL("/oauth/consent", opts.usersApiBase), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${opts.userApiKey}` },
      body: JSON.stringify({ request_id: requestId, client_name: clientName }),
    }),
    "users-api /oauth/consent"
  );

  // 6. Callback → Worker exchanges the code with users-api and redirects to the client with an auth code.
  const cb = new URL(returnUrl);
  cb.searchParams.set("request", requestId);
  cb.searchParams.set("code", consentRes.code);
  const back = locationOf(await fetch(cb, { redirect: "manual" }), "/oauth/callback");
  if (back.searchParams.get("error")) throw new Error(`callback error: ${back.searchParams.get("error")}: ${back.searchParams.get("error_description")}`);
  if (back.origin + back.pathname !== redirectUri) throw new Error(`callback redirected to ${back}`);
  if (back.searchParams.get("state") !== state) throw new Error("state mismatch");
  const authCode = back.searchParams.get("code");
  if (!authCode) throw new Error("no auth code in callback redirect");

  // 7. Token.
  const tokenReq = (params: Record<string, string>) =>
    fetch(token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params).toString() });
  const tok = await must(
    await tokenReq({ grant_type: "authorization_code", code: authCode, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier, resource: opts.mcpUrl }),
    "token"
  );
  let refreshToken: string | undefined = tok.refresh_token;

  return {
    accessToken: tok.access_token,
    refreshToken,
    clientId,
    tokenEndpoint: token_endpoint,
    keyKind: consentRes.key_kind,
    organizationName: consentRes.organization_name,
    refresh: async () => {
      if (!refreshToken) throw new Error("no refresh token");
      const r = await must(await tokenReq({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, resource: opts.mcpUrl }), "refresh");
      refreshToken = r.refresh_token ?? refreshToken;
      return { accessToken: r.access_token, refreshToken: r.refresh_token };
    },
  };
}

/** Expect the token endpoint to reject a refresh token with invalid_grant. */
export async function expectInvalidGrant(tokenEndpoint: string, clientId: string, refreshToken: string, resource: string): Promise<void> {
  const res = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, resource }).toString(),
  });
  const body: any = await res.json().catch(() => ({}));
  if (res.ok || body.error !== "invalid_grant") throw new Error(`expected invalid_grant, got HTTP ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
}
