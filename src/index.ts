/**
 * Cloudflare Worker entry: an OAuth 2.1 authorization server (workers-oauth-provider) wrapped
 * around the OpenAlex MCP server, served over Streamable HTTP at /mcp.
 *
 * Every /mcp request carries a bearer token issued here; the grant behind it holds the
 * OpenAlex API key of the user who consented at openalex.org (see auth.ts). There is no
 * shared server key and no header passthrough: every call spends the user's own budget.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { OAuthProvider, AuthorizationError } from "@cloudflare/workers-oauth-provider";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server";
import { OpenAlexClient } from "./openalex";
import { UsersApiClient } from "./users";
import {
  type AuthEnv, type GrantProps, SCOPE, storePending, takePending, consentUrl, exchangeCode, ExchangeError,
  revokeAllGrants, keyLabel,
} from "./auth";

export interface Env extends AuthEnv {
  ENVIRONMENT: string;
  OPENALEX_API_BASE: string;
  /** Exact public MCP endpoint URL; doubles as the OAuth resource identifier (RFC 9728). */
  MCP_PUBLIC_URL: string;
  ANALYTICS?: AnalyticsEngineDataset;
}

const DOCS_URL = "https://help.openalex.org/api/mcp/";

const MCP_CORS = {
  origin: "*",
  allowHeaders: ["Content-Type", "Authorization", "Accept", "Mcp-Session-Id", "Mcp-Protocol-Version", "Last-Event-ID"],
  exposeHeaders: ["Mcp-Session-Id", "Mcp-Protocol-Version", "WWW-Authenticate"],
  allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
};

// ---------------------------------------------------------------------------------------------
// Public handler: landing page, health, and the two halves of the consent round-trip.
// ---------------------------------------------------------------------------------------------
const publicApp = new Hono<{ Bindings: Env }>();
publicApp.use("/mcp", cors(MCP_CORS));
publicApp.use("/mcp/*", cors(MCP_CORS));

publicApp.get("/", (c) =>
  c.json({
    name: SERVER_NAME,
    version: SERVER_VERSION,
    description: "Official OpenAlex MCP server. Connect an MCP client (e.g. Claude) to the /mcp endpoint and log in with your OpenAlex account.",
    mcp_endpoint: c.env.MCP_PUBLIC_URL,
    transport: "streamable-http",
    auth: "oauth2",
    docs: DOCS_URL,
    source: "https://github.com/ourresearch/openalex-mcp-server",
    support: "support@openalex.org",
  })
);

publicApp.get("/health", (c) =>
  c.json({ ok: true, env: c.env.ENVIRONMENT, oauth: true, exchange_secret: Boolean(c.env.OAUTH_EXCHANGE_SECRET) })
);

/** OAuth authorization endpoint: validate, park the request, send the user to openalex.org to consent. */
publicApp.get("/authorize", async (c) => {
  const env = c.env;
  let request;
  try {
    request = await env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  } catch (e: any) {
    if (e instanceof AuthorizationError) {
      // redirectUri is only set once the client and redirect_uri validated (never redirect blind).
      if (e.redirectUri) {
        const u = new URL(e.redirectUri);
        u.searchParams.set("error", e.code);
        u.searchParams.set("error_description", e.description);
        if (e.state) u.searchParams.set("state", e.state);
        if (e.issuer) u.searchParams.set("iss", e.issuer);
        return c.redirect(u.toString(), 302);
      }
      return c.json({ error: e.code, error_description: e.description }, 400);
    }
    return c.json({ error: "invalid_request", error_description: e?.message ?? String(e) }, 400);
  }
  const client = await env.OAUTH_PROVIDER.lookupClient(request.clientId);
  const clientName = (client?.clientName ?? "An MCP client").slice(0, 120);
  const id = await storePending(env, request, clientName);
  const callback = new URL("/oauth/callback", c.req.url).toString();
  return c.redirect(consentUrl(env, id, clientName, callback), 302);
});

/** The consent page sends the browser back here with either a signed code or an error. */
publicApp.get("/oauth/callback", async (c) => {
  const env = c.env;
  const q = new URL(c.req.url).searchParams;
  const pending = await takePending(env, q.get("request"));
  if (!pending) {
    return c.html(errorPage("This sign-in link has expired or was already used. Go back to Claude and connect again."), 400);
  }
  const back = (error: string, description: string) => {
    const u = new URL(pending.request.redirectUri);
    u.searchParams.set("error", error);
    u.searchParams.set("error_description", description);
    if (pending.request.state) u.searchParams.set("state", pending.request.state);
    if (pending.request.issuer) u.searchParams.set("iss", pending.request.issuer);
    return c.redirect(u.toString(), 302);
  };
  if (q.get("error")) return back("access_denied", "The user declined to connect their OpenAlex account.");
  const code = q.get("code");
  if (!code) return back("access_denied", "No consent code was returned.");

  let identity;
  try {
    identity = await exchangeCode(env, code, q.get("request")!);
  } catch (e: any) {
    const status = e instanceof ExchangeError ? e.status : 500;
    console.error("oauth exchange failed", status, e?.message);
    return back(status >= 500 ? "temporarily_unavailable" : "access_denied", status >= 500 ? "OpenAlex accounts are unavailable right now; try again in a minute." : e?.message ?? "Consent could not be verified.");
  }

  const props: GrantProps = {
    userId: identity.user_id,
    email: identity.email,
    displayName: identity.display_name,
    apiKey: identity.api_key,
    keyKind: identity.key_kind,
    organizationName: identity.organization_name ?? undefined,
    clientName: pending.clientName,
    personalApiKey: identity.personal_api_key ?? (identity.key_kind === "personal" ? identity.api_key : undefined),
  };
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: pending.request,
    userId: identity.user_id,
    metadata: { clientName: pending.clientName, keyKind: identity.key_kind, organizationName: identity.organization_name ?? null, grantedAt: new Date().toISOString() },
    scope: [SCOPE],
    props,
  });
  return c.redirect(redirectTo, 302);
});

publicApp.notFound((c) => c.json({ error: "Not found. The MCP endpoint is /mcp.", docs: DOCS_URL }, 404));

function errorPage(message: string): string {
  const esc = message.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);
  return `<!doctype html><meta charset="utf-8"><title>OpenAlex MCP</title><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1>OpenAlex</h1><p>${esc}</p></body>`;
}

// ---------------------------------------------------------------------------------------------
// Protected handler: the MCP server. The library has already validated the bearer token and
// decrypted the grant props for us.
// ---------------------------------------------------------------------------------------------
const mcpApp = new Hono<{ Bindings: Env }>();
mcpApp.use("/mcp", cors(MCP_CORS));
mcpApp.use("/mcp/*", cors(MCP_CORS));

async function handleMcp(c: any) {
  const env = c.env as Env;
  const props = (c.executionCtx as any)?.props as GrantProps | undefined;
  if (!props?.apiKey || !props.userId) {
    return c.json({ error: "invalid_token", error_description: "This connection has no OpenAlex account attached. Reconnect and log in." }, 401);
  }
  const client = new OpenAlexClient({
    apiKey: props.apiKey,
    baseUrl: env.OPENALEX_API_BASE,
    keyLabel: keyLabel(props),
    onUnauthorized: () => {
      // The user rotated (or lost) the key we hold: drop every grant so the client re-authenticates.
      c.executionCtx?.waitUntil?.(revokeAllGrants(env.OAUTH_PROVIDER, props.userId).catch((e: any) => console.error("revoke failed", e?.message)));
    },
  });
  // users-api authenticates the *user's* key only; org-key grants made before #1269 carry no personal key.
  const personalKey = props.personalApiKey ?? (props.keyKind === "personal" ? props.apiKey : undefined);
  const users = personalKey
    ? new UsersApiClient({
        apiKey: personalKey,
        baseUrl: env.USERS_API_BASE,
        onUnauthorized: () => {
          c.executionCtx?.waitUntil?.(revokeAllGrants(env.OAUTH_PROVIDER, props.userId).catch((e: any) => console.error("revoke failed", e?.message)));
        },
      })
    : null;
  const server = createServer({
    client,
    users,
    account: {
      userId: props.userId,
      email: props.email,
      displayName: props.displayName,
      keyKind: props.keyKind,
      organizationName: props.organizationName,
      clientName: props.clientName,
      usersApiReady: Boolean(personalKey),
    },
    onToolCall: (info) => {
      try {
        env.ANALYTICS?.writeDataPoint({
          indexes: [info.tool],
          blobs: [info.tool, info.ok ? "ok" : "error", props.keyKind, env.ENVIRONMENT, props.userId],
          doubles: [info.ms, info.credits, info.status ?? 0],
        });
      } catch {
        /* metrics are best-effort */
      }
    },
  });
  // Stateless: no session IDs, every request is independent. Plain JSON responses keep
  // things simple for clients that don't need streaming.
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(c.req.raw);
  } finally {
    c.executionCtx?.waitUntil?.(transport.close().then(() => server.close()).catch(() => {}));
  }
}

mcpApp.all("/mcp", handleMcp);
mcpApp.all("/mcp/*", handleMcp);
mcpApp.notFound((c) => c.json({ error: "Not found. The MCP endpoint is /mcp.", docs: DOCS_URL }, 404));

// ---------------------------------------------------------------------------------------------
// The OAuth provider. `resourceMetadata.resource` must be the exact public MCP URL, which differs
// between staging and production, so the provider is built per environment (once, then cached).
// ---------------------------------------------------------------------------------------------
const providers = new Map<string, OAuthProvider<Env>>();

function providerFor(env: Env): OAuthProvider<Env> {
  const resource = env.MCP_PUBLIC_URL;
  let p = providers.get(resource);
  if (p) return p;
  p = new OAuthProvider<Env>({
    apiRoute: "/mcp",
    apiHandler: { fetch: (req, env, ctx) => mcpApp.fetch(req, env, ctx) },
    defaultHandler: { fetch: (req, env, ctx) => publicApp.fetch(req, env, ctx) },
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    // Claude's directory prefers CIMD (client_id = the client's own HTTPS metadata URL) over DCR for
    // high-traffic servers, but Claude Code and older clients still use DCR: support both.
    clientIdMetadataDocumentEnabled: true,
    clientRegistrationEndpoint: "/oauth/register",
    scopesSupported: [SCOPE],
    resourceMetadata: {
      resource,
      scopes_supported: [SCOPE],
      bearer_methods_supported: ["header"],
      resource_name: "OpenAlex MCP server",
    },
    accessTokenTTL: 3600,
    refreshTokenTTL: 60 * 60 * 24 * 90,
    clientRegistrationTTL: 60 * 60 * 24 * 90,
  });
  providers.set(resource, p);
  return p;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return providerFor(env).fetch(request, env, ctx);
  },
  /** Nightly KV sweep for expired grants/tokens (cron trigger in wrangler.jsonc). */
  scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(providerFor(env).purgeExpiredData(env).catch((e: any) => console.error("purge failed", e?.message)));
  },
};
