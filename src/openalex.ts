/**
 * Thin client for the OpenAlex REST API.
 * Docs: https://help.openalex.org/api/
 */

export const USER_AGENT = "openalex-mcp-server/0.1 (https://github.com/ourresearch/openalex-mcp-server; mailto:support@openalex.org)";

export interface OpenAlexClientOptions {
  apiKey: string;
  baseUrl?: string;
  /** How to name the key in messages, e.g. "your personal OpenAlex key" or "the X organization key". */
  keyLabel?: string;
  /** Called once when OpenAlex rejects the key (401/403): the grant holding it is stale. */
  onUnauthorized?: () => void;
  timeoutMs?: number;
}

export interface Budget {
  remaining?: number;
  limit?: number;
  resetSeconds?: number;
}

export interface ListResponse<T = any> {
  meta: {
    count: number;
    page?: number;
    per_page?: number;
    groups_count?: number | null;
    cost_usd?: number;
  };
  results: T[];
  group_by?: Array<{ key: string; key_display_name: string; count: number }>;
}

export class OpenAlexError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryAfterSeconds?: number,
    /** Worth one automatic retry. */
    public readonly transient = false
  ) {
    super(message);
    this.name = "OpenAlexError";
  }
}

export type Params = Record<string, string | number | boolean | undefined | null>;

export class OpenAlexClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  readonly keyLabel: string;
  private readonly onUnauthorized?: () => void;
  private unauthorizedFired = false;
  private readonly timeoutMs: number;
  /** Credits spent through this client instance (sum of X-RateLimit-Credits-Used). */
  creditsUsed = 0;
  /** Last seen daily budget headers (X-RateLimit-Remaining/Limit/Reset). */
  lastBudget: Budget = {};

  constructor(opts: OpenAlexClientOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? "https://api.openalex.org").replace(/\/+$/, "");
    this.keyLabel = opts.keyLabel ?? "your OpenAlex key";
    this.onUnauthorized = opts.onUnauthorized;
    this.timeoutMs = opts.timeoutMs ?? 25_000;
  }

  /**
   * One line about the daily budget, or null when there is plenty left. Appended to tool
   * results so the model can warn the user before the key runs dry (oxjob #1266).
   */
  budgetNote(): string | null {
    return budgetNote(this.lastBudget, this.keyLabel);
  }

  buildUrl(path: string, params: Params = {}): string {
    const url = new URL(this.baseUrl + (path.startsWith("/") ? path : "/" + path));
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === "") continue;
      url.searchParams.set(k, String(v));
    }
    return url.toString();
  }

  /** GET with one automatic retry on transient failures (query timeout, 1 rps semantic limit, 5xx). */
  async get<T = any>(path: string, params: Params = {}): Promise<T> {
    try {
      return await this.getOnce<T>(path, params);
    } catch (e) {
      if (e instanceof OpenAlexError && e.transient) {
        await new Promise((r) => setTimeout(r, Math.min(3000, (e.retryAfterSeconds ?? 1) * 1000 + 200)));
        return await this.getOnce<T>(path, params);
      }
      throw e;
    }
  }

  /** POST an OQL/OQO query to the API root (no URL length limit). Same retry policy as get(). */
  async post<T = any>(body: Record<string, any>): Promise<T> {
    try {
      return await this.request<T>(this.baseUrl + "/", { method: "POST", body: JSON.stringify(body), contentType: "application/json" });
    } catch (e) {
      if (e instanceof OpenAlexError && e.transient) {
        await new Promise((r) => setTimeout(r, Math.min(3000, (e.retryAfterSeconds ?? 1) * 1000 + 200)));
        return await this.request<T>(this.baseUrl + "/", { method: "POST", body: JSON.stringify(body), contentType: "application/json" });
      }
      throw e;
    }
  }

  private async getOnce<T = any>(path: string, params: Params = {}): Promise<T> {
    return this.request<T>(this.buildUrl(path, params), { method: "GET" });
  }

  private async request<T = any>(url: string, init: { method: "GET" | "POST"; body?: string; contentType?: string }): Promise<T> {
    let res: Response;
    try {
      res = await fetch(url, {
        method: init.method,
        body: init.body,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "User-Agent": USER_AGENT,
          Accept: "application/json",
          ...(init.contentType ? { "Content-Type": init.contentType } : {}),
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e: any) {
      const why = e?.name === "TimeoutError" ? "timed out" : `failed (${e?.message ?? e})`;
      throw new OpenAlexError(`Request to OpenAlex ${why}. Try a narrower query or retry in a moment.`, 0);
    }

    const used = Number(res.headers.get("x-ratelimit-credits-used") ?? 0);
    if (Number.isFinite(used)) this.creditsUsed += used;
    const remaining = res.headers.get("x-ratelimit-remaining");
    const limit = res.headers.get("x-ratelimit-limit");
    const reset = res.headers.get("x-ratelimit-reset");
    this.lastBudget = {
      remaining: remaining ? Number(remaining) : undefined,
      limit: limit ? Number(limit) : undefined,
      resetSeconds: reset ? Number(reset) : undefined,
    };

    if (res.ok) {
      return (await res.json()) as T;
    }

    let body: any = null;
    try {
      body = await res.json();
    } catch {
      /* non-JSON error body */
    }
    const apiMessage: string | undefined = body?.message ?? body?.error;

    if (res.status === 404) {
      throw new OpenAlexError(apiMessage ?? "Not found in OpenAlex. Check the ID or DOI.", 404);
    }
    if (res.status === 429) {
      const retry = Number(res.headers.get("retry-after") ?? body?.retryAfter ?? this.lastBudget.resetSeconds ?? 0);
      if (retry > 0 && retry <= 3) {
        throw new OpenAlexError(apiMessage ?? "OpenAlex rate limit hit; retry shortly.", 429, retry, true);
      }
      const who = `${capitalize(this.keyLabel)} has used up its daily OpenAlex budget`;
      const when = resetPhrase(retry > 0 ? retry : this.lastBudget.resetSeconds);
      const fix = " Single-record lookups (get_work, get_entity) are free and still work. For more: add prepaid usage or a plan at https://openalex.org/pricing (takes effect immediately, no reconnect needed), or wait for the reset.";
      throw new OpenAlexError(`${who}.${when}${fix}`, 429, retry || undefined);
    }
    if (res.status === 400) {
      const v = body?.validation;
      if (v && Array.isArray(v.errors) && v.errors.length) {
        const lines = v.errors.map((e: any) => {
          const where = typeof e.position === "number" ? ` (at character ${e.position})` : "";
          return `${e.message}${where}`;
        });
        throw new OpenAlexError(`Query is not valid OQL${lines.length > 1 ? ":" : ":"} ${lines.join(" | ")}`, 400);
      }
      throw new OpenAlexError(`OpenAlex rejected the query: ${trimFieldList(apiMessage ?? "bad request")}`, 400);
    }
    if (res.status === 401 || res.status === 403) {
      if (!this.unauthorizedFired) {
        this.unauthorizedFired = true;
        try { this.onUnauthorized?.(); } catch { /* best effort */ }
      }
      throw new OpenAlexError(
        `OpenAlex rejected ${this.keyLabel} (it was probably rotated at https://openalex.org/settings/api). Reconnect the OpenAlex connector to log in again.`,
        res.status
      );
    }
    if (res.status === 504 || body?.reason === "query_timeout") {
      throw new OpenAlexError(
        "The query took too long and OpenAlex stopped it. Narrow it: fewer OR terms, add a year or type filter, or use keyword mode instead of semantic.",
        504, 1, true
      );
    }
    throw new OpenAlexError(`OpenAlex returned HTTP ${res.status}${apiMessage ? `: ${apiMessage}` : ""}. Retry in a moment.`, res.status, undefined, res.status >= 500);
  }
}

/** OpenAlex 400s for bad filters list every valid field; keep the message readable. */
function trimFieldList(msg: string): string {
  const idx = msg.indexOf("Valid fields are");
  if (idx === -1 || msg.length < 600) return msg;
  return msg.slice(0, idx).trim() + " See https://help.openalex.org/api/filtering/ for valid filter fields.";
}

const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

function resetPhrase(seconds: number | undefined): string {
  if (!seconds || seconds <= 0) return "";
  if (seconds < 3600) return ` It resets in about ${Math.max(1, Math.round(seconds / 60))} minutes (midnight UTC).`;
  const hours = Math.ceil(seconds / 3600);
  return ` It resets in about ${hours} hour${hours === 1 ? "" : "s"} (midnight UTC).`;
}

/** Warn when under 20% or under 2,000 credits; silent otherwise. Exported for tests. */
export function budgetNote(b: Budget, keyLabel: string): string | null {
  if (b.remaining === undefined || !Number.isFinite(b.remaining)) return null;
  const limit = b.limit && Number.isFinite(b.limit) ? b.limit : undefined;
  const low = b.remaining < 2000 || (limit !== undefined && limit > 0 && b.remaining / limit < 0.2);
  if (!low) return null;
  const left = limit !== undefined ? `${b.remaining.toLocaleString("en-US")} of ${limit.toLocaleString("en-US")} credits` : `${b.remaining.toLocaleString("en-US")} credits`;
  const dollars = ` (about $${(b.remaining / 10000).toFixed(2)})`;
  return `Budget: ${left}${dollars} left today on ${keyLabel}.${resetPhrase(b.resetSeconds)} More at https://openalex.org/pricing.`;
}
