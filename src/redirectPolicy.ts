/**
 * Which redirect URIs an OAuth client here may use (oxjob #2323).
 *
 * Registration is open (DCR, by design) and CIMD clients name their own URIs, so the redirect URI is the one thing
 * that decides where an authorization code goes. The MCP authorization spec (2025-11-25, Communication Security):
 * "All redirect URIs MUST be either localhost or use HTTPS." So a plain-http URI is refused unless its host is a
 * loopback address (native apps such as Claude Code listen on http://localhost:<port>/callback, RFC 8252 7.3), and
 * so is every other network or browser-internal scheme (ftp:, ws:, javascript:, data:, ...).
 * Private-use app schemes (cursor://..., RFC 8252 7.1) stay allowed: they open a native app on the user's own device,
 * and native MCP clients use them.
 *
 * The same rule runs at registration, at /authorize (clients registered before the rule, and CIMD documents, which
 * skip registration) and again just before the final redirect (requests parked before a deploy).
 */

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Schemes that reach the network or the browser itself rather than a native app: only https (and loopback http) pass. */
const REFUSED_SCHEMES = new Set([
  "http:", "ftp:", "ws:", "wss:", "file:", "gopher:",
  "javascript:", "vbscript:", "data:", "blob:", "about:", "mailto:", "filesystem:", "view-source:",
]);

export const MAX_REDIRECT_URIS = 10;
export const MAX_REDIRECT_URI_LENGTH = 512;
export const MAX_CLIENT_NAME_LENGTH = 120;

/** Why this redirect URI may not receive an authorization code, or null when it may. */
export function redirectUriProblem(uri: string): string | null {
  // WHATWG URL parsing silently drops tabs and newlines ("java\tscript:" parses as javascript:), so refuse them first.
  if (/[\s\x00-\x1f\x7f-\x9f]/.test(uri)) return "redirect URI must not contain spaces or control characters";
  if (uri.includes("#")) return "redirect URI must not contain a fragment (RFC 6749 3.1.2)";
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return "redirect URI is not a valid URL";
  }
  if (u.username || u.password) return "redirect URI must not contain a user name or password";
  if (u.protocol === "https:") return null;
  if (u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname)) return null;
  if (REFUSED_SCHEMES.has(u.protocol)) {
    return "redirect URIs must use https, or http only on localhost (MCP authorization spec)";
  }
  return null;
}

export interface RegistrationProblem {
  code: "invalid_redirect_uri" | "invalid_client_metadata";
  description: string;
}

/** Why this dynamic client registration is refused, or null to allow it. Input is the raw registration body. */
export function registrationProblem(meta: Record<string, unknown>): RegistrationProblem | null {
  const uris = meta.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0) {
    return { code: "invalid_redirect_uri", description: "redirect_uris is required" };
  }
  if (uris.length > MAX_REDIRECT_URIS) {
    return { code: "invalid_redirect_uri", description: `at most ${MAX_REDIRECT_URIS} redirect_uris` };
  }
  for (const uri of uris) {
    if (typeof uri !== "string") return { code: "invalid_redirect_uri", description: "redirect_uris must be strings" };
    if (uri.length > MAX_REDIRECT_URI_LENGTH) {
      return { code: "invalid_redirect_uri", description: `redirect URIs must be at most ${MAX_REDIRECT_URI_LENGTH} characters` };
    }
    const problem = redirectUriProblem(uri);
    if (problem) return { code: "invalid_redirect_uri", description: problem };
  }
  if (typeof meta.client_name === "string" && meta.client_name.length > MAX_CLIENT_NAME_LENGTH) {
    return { code: "invalid_client_metadata", description: `client_name must be at most ${MAX_CLIENT_NAME_LENGTH} characters` };
  }
  return null;
}
