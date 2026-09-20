/**
 * ORCID helpers: canonical form + check digit, and the public registry read.
 * The public API needs no token; records default to "Everyone" visibility (only email is private
 * by default), so most authors' works lists are readable anonymously (oxjob #1269 EXPLORE.md).
 */

const ORCID_RE = /^(?:https?:\/\/(?:www\.)?orcid\.org\/)?(\d{4})-?(\d{4})-?(\d{4})-?(\d{3})([0-9X])\/?$/i;

/** ISO 7064 mod 11-2 check character over the 15 digits. */
function checkChar(digits15: string): string {
  let total = 0;
  for (const ch of digits15) total = ((total + Number(ch)) * 2) % 11;
  const r = (12 - total) % 11;
  return r === 10 ? "X" : String(r);
}

/** "0000-0002-1825-0097" in any accepted form -> "0000-0002-1825-0097"; null if malformed or bad check digit. */
export function normalizeOrcid(input: string | null | undefined): string | null {
  if (!input) return null;
  const m = input.trim().match(ORCID_RE);
  if (!m) return null;
  const digits = m[1] + m[2] + m[3] + m[4];
  const check = m[5].toUpperCase();
  if (checkChar(digits) !== check) return null;
  return `${m[1]}-${m[2]}-${m[3]}-${m[4]}${check}`;
}

export const orcidUrl = (orcid: string) => `https://orcid.org/${orcid}`;

export interface OrcidWork {
  put_code: number | null;
  title: string | null;
  year: number | null;
  type: string | null;
  doi: string | null;
  pmid: string | null;
  external_ids: Array<{ type: string; value: string }>;
}

/** Flatten the public v3.0 works summary into one row per work group (the preferred summary). */
export function parseOrcidWorks(body: any): OrcidWork[] {
  const groups: any[] = Array.isArray(body?.group) ? body.group : [];
  const out: OrcidWork[] = [];
  for (const g of groups) {
    const summaries: any[] = Array.isArray(g?.["work-summary"]) ? g["work-summary"] : [];
    const s = summaries[0];
    if (!s) continue;
    const ids: Array<{ type: string; value: string }> = [];
    for (const src of [g?.["external-ids"], s?.["external-ids"]]) {
      for (const e of src?.["external-id"] ?? []) {
        const type = String(e?.["external-id-type"] ?? "").toLowerCase();
        const value = String(e?.["external-id-normalized"]?.value ?? e?.["external-id-value"] ?? "").trim();
        if (type && value && !ids.some((x) => x.type === type && x.value.toLowerCase() === value.toLowerCase())) ids.push({ type, value });
      }
    }
    const doi = ids.find((x) => x.type === "doi")?.value ?? null;
    const pmid = ids.find((x) => x.type === "pmid")?.value ?? null;
    const year = Number(s?.["publication-date"]?.year?.value);
    out.push({
      put_code: typeof s?.["put-code"] === "number" ? s["put-code"] : null,
      title: s?.title?.title?.value ?? null,
      year: Number.isFinite(year) ? year : null,
      type: s?.type ?? null,
      doi: doi ? doi.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").toLowerCase() : null,
      pmid,
      external_ids: ids,
    });
  }
  return out;
}

export class OrcidError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "OrcidError";
  }
}

/** Read the public works list. 404 = no such record; an empty list usually means the works are private. */
export async function fetchOrcidWorks(orcid: string, timeoutMs = 10_000): Promise<OrcidWork[]> {
  let res: Response;
  try {
    res = await fetch(`https://pub.orcid.org/v3.0/${orcid}/works`, {
      headers: { Accept: "application/json", "User-Agent": "openalex-mcp-server (mailto:support@openalex.org)" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e: any) {
    throw new OrcidError(`ORCID registry unreachable (${e?.name ?? "error"})`, 502);
  }
  if (res.status === 404) throw new OrcidError(`No ORCID record ${orcid}.`, 404);
  if (!res.ok) throw new OrcidError(`ORCID registry returned HTTP ${res.status}.`, res.status);
  return parseOrcidWorks(await res.json());
}
