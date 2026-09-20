/**
 * OAuth glue between @cloudflare/workers-oauth-provider (the OAuth 2.1 authorization server)
 * and OpenAlex identity (users-api + the consent page on openalex.org).
 *
 * Flow (oxjob #1266):
 *   1. Claude hits /authorize. We validate the request, park it in KV as `pending:<id>` and send
 *      the browser to openalex.org/oauth/consent.
 *   2. The consent page (logged-in GUI) asks users-api to sign a short-lived code saying
 *      "user U approved request R with key kind K", then sends the browser to /oauth/callback.
 *   3. /oauth/callback exchanges that code with users-api (shared secret) for the user's API key,
 *      stores it in the encrypted grant props, and redirects back to Claude.
 */
import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";

/** What every authenticated /mcp request receives in ctx.props (AES-GCM encrypted at rest). */
export interface GrantProps {
  userId: string;
  email?: string;
  displayName?: string;
  apiKey: string;
  keyKind: "personal" | "organization";
  organizationName?: string;
  clientName?: string;
}

export interface AuthEnv {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  /** Where the consent page lives, e.g. https://openalex.org */
  OPENALEX_WEB_BASE: string;
  /** users-api base, e.g. https://user.openalex.org */
  USERS_API_BASE: string;
  /** Shared with users-api; authenticates the Worker at /oauth/exchange. */
  OAUTH_EXCHANGE_SECRET?: string;
}

export const PENDING_TTL_SECONDS = 600;
export const SCOPE = "openalex:query";

interface Pending {
  request: AuthRequest;
  clientName: string;
  createdAt: number;
}

const pendingKey = (id: string) => `pending:${id}`;

export function randomId(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return btoa(String.fromCharCode(...buf)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const ID_RE = /^[A-Za-z0-9_-]{20,64}$/;

/** Park a validated authorization request; returns the opaque id the consent page carries. */
export async function storePending(env: AuthEnv, request: AuthRequest, clientName: string): Promise<string> {
  const id = randomId();
  const rec: Pending = { request, clientName, createdAt: Date.now() };
  await env.OAUTH_KV.put(pendingKey(id), JSON.stringify(rec), { expirationTtl: PENDING_TTL_SECONDS });
  return id;
}

/** Load and delete (single use). */
export async function takePending(env: AuthEnv, id: string | null | undefined): Promise<Pending | null> {
  if (!id || !ID_RE.test(id)) return null;
  const raw = await env.OAUTH_KV.get(pendingKey(id));
  if (!raw) return null;
  await env.OAUTH_KV.delete(pendingKey(id));
  try {
    return JSON.parse(raw) as Pending;
  } catch {
    return null;
  }
}

/** Where to send the browser for consent. */
export function consentUrl(env: AuthEnv, requestId: string, clientName: string, callbackUrl: string): string {
  const u = new URL("/oauth/consent", env.OPENALEX_WEB_BASE);
  u.searchParams.set("request", requestId);
  u.searchParams.set("client", clientName);
  u.searchParams.set("return", callbackUrl);
  return u.toString();
}

export interface ExchangeResult {
  request_id: string;
  user_id: string;
  email?: string;
  display_name?: string;
  api_key: string;
  key_kind: "personal" | "organization";
  organization_name?: string | null;
}

export class ExchangeError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "ExchangeError";
  }
}

/** Server-to-server: trade the consent code for the user's identity and API key. */
export async function exchangeCode(env: AuthEnv, code: string, expectedRequestId: string): Promise<ExchangeResult> {
  if (!env.OAUTH_EXCHANGE_SECRET) throw new ExchangeError("OAUTH_EXCHANGE_SECRET is not configured", 500);
  let res: Response;
  try {
    res = await fetch(new URL("/oauth/exchange", env.USERS_API_BASE).toString(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OAUTH_EXCHANGE_SECRET}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ code }),
      signal: AbortSignal.timeout(8000),
    });
  } catch (e: any) {
    throw new ExchangeError(`users-api unreachable (${e?.name ?? "error"})`, 502);
  }
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON */
  }
  if (!res.ok) throw new ExchangeError(body?.message ?? `users-api exchange failed (HTTP ${res.status})`, res.status === 401 || res.status === 403 ? 502 : 400);
  if (!body?.api_key || !body?.user_id || body.request_id !== expectedRequestId) {
    throw new ExchangeError("users-api returned a code for a different request", 400);
  }
  if (body.key_kind !== "personal" && body.key_kind !== "organization") body.key_kind = "personal";
  return body as ExchangeResult;
}

/** Revoke every grant this user holds; the next request then 401s and the client re-authenticates. */
export async function revokeAllGrants(provider: OAuthHelpers, userId: string): Promise<number> {
  let n = 0;
  let cursor: string | undefined;
  do {
    const page = await provider.listUserGrants(userId, { limit: 100, cursor });
    for (const g of page.items) {
      await provider.revokeGrant(g.id, userId);
      n++;
    }
    cursor = page.cursor;
  } while (cursor);
  return n;
}

/** A human label for the key a grant uses, for budget and error messages. */
export function keyLabel(p: Pick<GrantProps, "keyKind" | "organizationName">): string {
  return p.keyKind === "organization"
    ? `the ${p.organizationName ?? "organization"} organization key`
    : "your personal OpenAlex key";
}
