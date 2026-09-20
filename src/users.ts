/**
 * Thin client for the OpenAlex users API (user.openalex.org): account, author claims, curations.
 * Authenticates with the same API key the OpenAlex client uses; users-api accepts it as a bearer
 * token on every route the connector needs (oxjob #1269 EXPLORE.md).
 */

export class UsersApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly body?: any) {
    super(message);
    this.name = "UsersApiError";
  }
}

export interface UsersApiOptions {
  apiKey: string;
  baseUrl: string;
  /** Called once when users-api rejects the key (401): the grant holding it is stale. */
  onUnauthorized?: () => void;
  timeoutMs?: number;
}

export interface ClaimRecord {
  id: string;
  author_id: string;
  auto_approved: boolean;
  submitted_at: string | null;
  approved_at: string | null;
  decision: string;
  decided_at: string | null;
  decided_by: string | null;
  decision_note: string | null;
}

export interface MeRecord {
  id: string;
  display_name: string | null;
  email: string;
  author_id: string | null;
  organization_name?: string | null;
  organization_role?: string | null;
  emails?: Array<{ email: string; is_primary?: boolean; verified?: boolean; verified_at?: string | null; is_verified?: boolean }>;
  claim: ClaimRecord | null;
  /** Added by users-api for the connector (#1269 Phase 0); absent on older deploys. */
  claim_eligibility?: "instant" | "review";
  [k: string]: any;
}

export interface CurationRow {
  id: string;
  user_id: string;
  user_name?: string | null;
  entity: "works" | "authors" | "ras";
  entity_id: string;
  property: string;
  value: string;
  previous_value?: string | null;
  action: "add" | "remove" | "replace";
  created: string | null;
  status: "pending" | "applied" | "timed_out";
  is_applied: boolean;
  applied_at: string | null;
}

export interface CurationPayload {
  entity: "works" | "authors";
  entity_id: string;
  property: string;
  action: "add" | "remove" | "replace";
  value: string;
}

export interface BatchItemResult {
  index: number;
  status: number;
  curation?: CurationRow | null;
  skipped?: boolean;
  reason?: string;
  error?: string;
}

export interface BatchResult {
  summary: { total: number; created: number; skipped: number; errors: number };
  results: BatchItemResult[];
}

export class UsersApiClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly onUnauthorized?: () => void;
  private unauthorizedFired = false;
  private readonly timeoutMs: number;

  constructor(opts: UsersApiOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.onUnauthorized = opts.onUnauthorized;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
  }

  me(): Promise<MeRecord> {
    return this.request<MeRecord>("GET", "/users/me");
  }

  /** Public: is this profile already claimed or under review by anyone? */
  claimStatus(authorShortId: string): Promise<{ claimed: boolean; pending: boolean }> {
    return this.request("GET", `/authors/${encodeURIComponent(authorShortId)}/claim-status`);
  }

  claimAuthor(userId: string, authorShortId: string, evidence: string): Promise<{ auto_approved: boolean; claim_id: string; message: string }> {
    return this.request("POST", `/users/${encodeURIComponent(userId)}/author/${encodeURIComponent(authorShortId)}`, { evidence });
  }

  async listCurations(params: Record<string, string | number | undefined>): Promise<{ meta: { count: number; total_count: number; page: number; per_page: number; total_pages: number }; results: CurationRow[] }> {
    const url = new URL(this.baseUrl + "/curations");
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    return this.request("GET", url.pathname + url.search);
  }

  /** Array POST: 207 with per-item results, whatever the individual outcomes. */
  createCurations(items: CurationPayload[]): Promise<BatchResult> {
    return this.request<BatchResult>("POST", "/curations", items, [200, 201, 207]);
  }

  deleteCuration(id: string): Promise<{ deleted: boolean; id: string }> {
    return this.request("DELETE", `/curations/${encodeURIComponent(id)}`);
  }

  private async request<T = any>(method: "GET" | "POST" | "DELETE", path: string, body?: any, okStatuses?: number[]): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.baseUrl + path, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
          "User-Agent": "openalex-mcp-server (mailto:support@openalex.org)",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e: any) {
      const why = e?.name === "TimeoutError" ? "timed out" : `failed (${e?.message ?? e})`;
      throw new UsersApiError(`Request to OpenAlex accounts ${why}. Retry in a moment.`, 0);
    }
    let parsed: any = null;
    try {
      parsed = await res.json();
    } catch {
      /* no JSON body */
    }
    const ok = okStatuses ? okStatuses.includes(res.status) : res.ok;
    if (ok) return parsed as T;
    const message: string = parsed?.message ?? parsed?.error ?? `OpenAlex accounts returned HTTP ${res.status}`;
    if (res.status === 401) {
      if (!this.unauthorizedFired) {
        this.unauthorizedFired = true;
        try { this.onUnauthorized?.(); } catch { /* best effort */ }
      }
      throw new UsersApiError("OpenAlex rejected this connection's key (it was probably rotated). Reconnect the OpenAlex connector to log in again.", 401, parsed);
    }
    throw new UsersApiError(message, res.status, parsed);
  }
}
