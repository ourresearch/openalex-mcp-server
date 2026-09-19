/**
 * Thin client for the OpenAlex REST API.
 * Docs: https://help.openalex.org/api/
 */

export const USER_AGENT = "openalex-mcp-server/0.1 (https://github.com/ourresearch/openalex-mcp-server; mailto:support@openalex.org)";

export interface OpenAlexClientOptions {
  apiKey: string;
  baseUrl?: string;
  /** True when the key came from the client (bring-your-own-key), not from the server. */
  byok?: boolean;
  timeoutMs?: number;
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
  readonly byok: boolean;
  private readonly timeoutMs: number;
  /** Credits spent through this client instance (sum of X-RateLimit-Credits-Used). */
  creditsUsed = 0;
  /** Last seen daily budget headers, for diagnostics. */
  lastBudget: { remaining?: number; limit?: number; resetSeconds?: number } = {};

  constructor(opts: OpenAlexClientOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? "https://api.openalex.org").replace(/\/+$/, "");
    this.byok = opts.byok ?? false;
    this.timeoutMs = opts.timeoutMs ?? 25_000;
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

  private async getOnce<T = any>(path: string, params: Params = {}): Promise<T> {
    const url = this.buildUrl(path, params);
    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "User-Agent": USER_AGENT,
          Accept: "application/json",
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
      const hours = retry > 0 ? Math.ceil(retry / 3600) : undefined;
      const who = this.byok
        ? "Your OpenAlex API key has used up its daily budget"
        : "The OpenAlex MCP server has hit its daily API budget";
      const when = hours ? ` It resets in about ${hours} hour${hours === 1 ? "" : "s"} (midnight UTC).` : "";
      const fix = this.byok
        ? " Add prepaid usage or a plan at https://openalex.org/pricing, or wait for the reset."
        : " Single-record lookups (get_work, get_entity) are free and still work; other tools will work again after the reset, or connect with your own OpenAlex API key.";
      throw new OpenAlexError(`${who}.${when}${fix}`, 429, retry || undefined);
    }
    if (res.status === 400) {
      throw new OpenAlexError(`OpenAlex rejected the query: ${trimFieldList(apiMessage ?? "bad request")}`, 400);
    }
    if (res.status === 401 || res.status === 403) {
      throw new OpenAlexError(
        this.byok
          ? "OpenAlex rejected the API key you connected with. Check it at https://openalex.org/settings/api."
          : "The OpenAlex MCP server's API key was rejected. Please report this to support@openalex.org.",
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
