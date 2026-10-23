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
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { OAuthProvider, AuthorizationError } from "@cloudflare/workers-oauth-provider";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server";
import { OpenAlexClient } from "./openalex";
import { UsersApiClient } from "./users";
import {
  type AuthEnv, type GrantProps, SCOPE, storePending, takePending, consentUrl, exchangeCode, ExchangeError,
  grantIdOf, keyLabel, pendingCookieName, isPendingCookie, PENDING_TTL_SECONDS,
} from "./auth";
import { ICON_PNG_BASE64 } from "./icon";
import { reportError, withErrorReporting, type SentryEnv } from "./sentry";

export interface Env extends AuthEnv, SentryEnv {
  ENVIRONMENT: string;
  OPENALEX_API_BASE: string;
  /** `core` previews the API's new-form OQL echo before its default flips (#1555); unset in wrangler.jsonc. */
  OQL_STYLE?: string;
  /** Exact public MCP endpoint URL; doubles as the OAuth resource identifier (RFC 9728). */
  MCP_PUBLIC_URL: string;
  /** "true" to register find_experts (staging only until oxjob #1274 v2). */
  FIND_EXPERTS?: string;
  KEYWORD_SEARCH?: string;
  ALERT_TOOLS?: string;
  /** ChatGPT plugin-directory domain verification token (oxjob #1294); served verbatim at /.well-known/openai-apps-challenge. */
  OPENAI_APPS_CHALLENGE?: string;
  ANALYTICS?: AnalyticsEngineDataset;
}

const DOCS_URL = "https://help.openalex.org/api/mcp/";

const MCP_CORS = {
  origin: "*",
  allowHeaders: ["Content-Type", "Authorization", "Accept", "Mcp-Session-Id", "Mcp-Protocol-Version", "Last-Event-ID"],
  exposeHeaders: ["Mcp-Session-Id", "Mcp-Protocol-Version", "WWW-Authenticate"],
  allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
};

/** Hono's default error handler (log, plain 500) plus a Sentry report (oxjob #1685): Hono catches route errors itself. */
function onAppError(err: Error, c: { text: (body: string, status: 500) => Response }): Response {
  if ("getResponse" in err && typeof err.getResponse === "function") return err.getResponse() as Response;
  console.error(err);
  reportError(err, { site: "route", handled: false });
  return c.text("Internal Server Error", 500);
}

// ---------------------------------------------------------------------------------------------
// Public handler: landing page, health, and the two halves of the consent round-trip.
// ---------------------------------------------------------------------------------------------
const publicApp = new Hono<{ Bindings: Env }>();
publicApp.onError(onAppError);
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

/** Listing icon: the connectors directory and clients read the favicon from the server origin. */
const iconResponse = () => {
  const bytes = Uint8Array.from(atob(ICON_PNG_BASE64), (ch) => ch.charCodeAt(0));
  return new Response(bytes, { headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" } });
};
publicApp.get("/favicon.ico", () => iconResponse());
publicApp.get("/icon-512.png", () => iconResponse());

/** ChatGPT plugin directory: the OpenAI portal issues a token that must be served verbatim at this path (oxjob #1294). */
publicApp.get("/.well-known/openai-apps-challenge", (c) =>
  c.env.OPENAI_APPS_CHALLENGE ? c.text(c.env.OPENAI_APPS_CHALLENGE) : c.notFound()
);

publicApp.get("/health", (c) =>
  c.json({ ok: true, env: c.env.ENVIRONMENT, oauth: true, exchange_secret: Boolean(c.env.OAUTH_EXCHANGE_SECRET) })
);

/** The pending-request cookie (see pendingCookieName): `__Host-`, so Secure, Path=/ and no Domain. */
const PENDING_COOKIE = { prefix: "host", httpOnly: true, secure: true, sameSite: "Lax", path: "/" } as const;

/** OAuth authorization endpoint: validate, park the request, send the user to openalex.org to consent. */
publicApp.get("/authorize", async (c) => {
  const env = c.env;
  let request;
  try {
    request = await env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  } catch (e: any) {
    if (e instanceof AuthorizationError) {
      // Never redirect an error to e.redirectUri. Every client here registered itself (open DCR, or CIMD, where the
      // client's own document names its URIs), so a redirect_uri that matched proves only that the requester chose
      // it: redirecting there would make this host an open redirector (RFC 9700 section 4.11.2). Show it here instead.
      return c.html(errorPage(`This connection request is not valid (${e.code}: ${e.description}). Go back to your app and connect again.`), 400);
    }
    return c.json({ error: "invalid_request", error_description: e?.message ?? String(e) }, 400);
  }
  const client = await env.OAUTH_PROVIDER.lookupClient(request.clientId);
  const clientName = (client?.clientName ?? "An MCP client").slice(0, 120);
  const id = await storePending(env, request, clientName);
  // Lax survives the consent page's top-level GET back from openalex.org; see pendingCookieName.
  setCookie(c, pendingCookieName(id), id, { ...PENDING_COOKIE, maxAge: PENDING_TTL_SECONDS });
  const callback = new URL("/oauth/callback", c.req.url).toString();
  return c.redirect(consentUrl(env, id, clientName, callback), 302);
});

/** The consent page sends the browser back here with either a signed code or an error. */
publicApp.get("/oauth/callback", async (c) => {
  const env = c.env;
  const q = new URL(c.req.url).searchParams;
  const requestId = q.get("request");
  // Only the browser that started this sign-in at /authorize: otherwise a bare callback link would redirect anyone to
  // the client's self-registered redirect_uri with no step of theirs (an open redirector). Checked before the single
  // use, so a stray link can't spend someone else's sign-in.
  if (!requestId || !isPendingCookie(requestId, getCookie(c, pendingCookieName(requestId), "host"))) {
    return c.html(errorPage("This sign-in link didn't start in this browser, or it has expired. Go back to your app and connect again."), 400);
  }
  const pending = await takePending(env, requestId);
  if (!pending) {
    return c.html(errorPage("This sign-in link has expired or was already used. Go back to Claude and connect again."), 400);
  }
  deleteCookie(c, pendingCookieName(requestId), PENDING_COOKIE);
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
    identity = await exchangeCode(env, code, requestId);
  } catch (e: any) {
    const status = e instanceof ExchangeError ? e.status : 500;
    console.error("oauth exchange failed", status, e?.message);
    if (status >= 500) reportError(e, { site: "oauth_exchange", extra: { status } });
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
mcpApp.onError(onAppError);
mcpApp.use("/mcp", cors(MCP_CORS));
mcpApp.use("/mcp/*", cors(MCP_CORS));

async function handleMcp(c: any) {
  const env = c.env as Env;
  const props = (c.executionCtx as any)?.props as GrantProps | undefined;
  if (!props?.apiKey || !props.userId) {
    return c.json({ error: "invalid_token", error_description: "This connection has no OpenAlex account attached. Reconnect and log in." }, 401);
  }
  // A 401 from OpenAlex or users-api: the user rotated (or deleted) the key this grant holds. Revoke this grant only, so
  // this client re-authenticates; the user's other grants (other clients, other keys) revoke themselves on their own 401.
  const grantId = grantIdOf(c.req.header("Authorization"), props.userId);
  const revokeThisGrant = () => {
    if (!grantId) return;
    c.executionCtx?.waitUntil?.(env.OAUTH_PROVIDER.revokeGrant(grantId, props.userId).catch((e: any) => {
      console.error("revoke failed", e?.message);
      reportError(e, { site: "revoke_grant" });
    }));
  };
  const client = new OpenAlexClient({
    apiKey: props.apiKey,
    baseUrl: env.OPENALEX_API_BASE,
    oqlStyle: env.OQL_STYLE,
    keyLabel: keyLabel(props),
    onUnauthorized: revokeThisGrant,
  });
  // users-api authenticates the *user's* key only; org-key grants made before #1269 carry no personal key.
  const personalKey = props.personalApiKey ?? (props.keyKind === "personal" ? props.apiKey : undefined);
  const users = personalKey
    ? new UsersApiClient({
        apiKey: personalKey,
        baseUrl: env.USERS_API_BASE,
        onUnauthorized: revokeThisGrant,
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
    features: { findExperts: env.FIND_EXPERTS === "true", keywordSearch: env.KEYWORD_SEARCH === "true", alertTools: env.ALERT_TOOLS === "true" },
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
    return withErrorReporting({ env, waitUntil: (p) => ctx.waitUntil(p), request }, "fetch",
      () => providerFor(env).fetch(request, env, ctx));
  },
  /** Nightly KV sweep for expired grants/tokens (cron trigger in wrangler.jsonc). */
  scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const inv = { env, waitUntil: (p: Promise<unknown>) => ctx.waitUntil(p) };
    ctx.waitUntil(providerFor(env).purgeExpiredData(env).catch((e: any) => {
      console.error("purge failed", e?.message);
      reportError(e, { site: "purge_expired", inv });
    }));
  },
};
