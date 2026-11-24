/**
 * Which redirect URIs an OAuth client here may use (oxjob #2323).
 *
 * Registration is open (DCR, by design) and CIMD clients name their own URIs, so the redirect URI is the one thing
 * that decides where an authorization code goes. The MCP authorization spec (2025-11-25, Communication Security):
 * "All redirect URIs MUST be either localhost or use HTTPS." So a plain-http URI is refused unless its host is a
 * loopback address (native apps such as Claude Code listen on http://localhost:<port>/callback, RFC 8252 7.3).
 * Private-use schemes (cursor://..., RFC 8252 7.1) stay allowed: native clients use them, and the library already
 * refuses javascript:, data:, file: and the like.
 */

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export const MAX_REDIRECT_URIS = 10;
export const MAX_REDIRECT_URI_LENGTH = 512;
export const MAX_CLIENT_NAME_LENGTH = 120;

/** Why this redirect URI is not allowed, or null when it is. */
export function redirectUriProblem(uri: string): string | null {
  if (uri.length > MAX_REDIRECT_URI_LENGTH) return `redirect URIs must be at most ${MAX_REDIRECT_URI_LENGTH} characters`;
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return "redirect URI is not a valid URL";
  }
  if (u.protocol === "http:" && !LOOPBACK_HOSTS.has(u.hostname)) {
    return "redirect URIs must use https, or http only on localhost (MCP authorization spec)";
  }
  return null;
}

/** Why this dynamic client registration is refused, or null to allow it. Input is the raw registration body. */
export function registrationProblem(meta: Record<string, unknown>): string | null {
  const uris = meta.redirect_uris;
  if (Array.isArray(uris)) {
    if (uris.length > MAX_REDIRECT_URIS) return `at most ${MAX_REDIRECT_URIS} redirect_uris`;
    for (const uri of uris) {
      const problem = typeof uri === "string" ? redirectUriProblem(uri) : "redirect_uris must be strings";
      if (problem) return problem;
    }
  }
  if (typeof meta.client_name === "string" && meta.client_name.length > MAX_CLIENT_NAME_LENGTH) {
    return `client_name must be at most ${MAX_CLIENT_NAME_LENGTH} characters`;
  }
  return null;
}
