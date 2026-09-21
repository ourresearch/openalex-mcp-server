/** Helpers for the OQL/OQO query path. Pure, unit-tested. */

const ENTITIES = ["works", "authors", "institutions", "sources", "funders", "publishers", "topics", "keywords", "awards", "locations", "countries", "languages", "sdgs", "types", "fields", "subfields", "domains", "continents", "licenses", "concepts"];

/** Accept a bare where-clause ("title has (x)") as shorthand for "works where title has (x)". */
export function normalizeOql(input: string, entity = "works"): string {
  const s = input.trim().replace(/\s+/g, " ");
  const first = s.split(/\s+/)[0]?.toLowerCase() ?? "";
  if (ENTITIES.includes(first)) return s;
  return `${entity} where ${s}`;
}

/** Does the query contain a text-search clause (so relevance sorting is meaningful)? */
export function oqlHasSearch(oql: string): boolean {
  return /\bhas\b|\bis similar to\b/i.test(oql);
}

export function oqlHasGroupBy(oql: string): boolean {
  return /\bgroup by\b/i.test(oql);
}

export function oqlHasSample(oql: string): boolean {
  return /\bsample\s+\d+/i.test(oql);
}

/** One-line canonical OQL from the API's meta.x_query echo. */
export function oneLine(oql: string | null | undefined): string | null {
  if (!oql) return null;
  return oql.replace(/\s+/g, " ").trim();
}

export function reproduceUrl(oql: string | null | undefined): string | null {
  const o = oneLine(oql);
  return o ? "https://api.openalex.org/?oql=" + encodeURIComponent(o) : null;
}

/** OQL group-by dimension names for the group_works keys (verified against the API). */
export const OQL_GROUP_DIMS: Record<string, string> = {
  author: "author", institution: "institution", institution_type: "institution type", country: "country",
  source: "source", publisher: "publisher", funder: "funder", year: "year", type: "type", topic: "topic",
  subfield: "subfield", field: "field", domain: "domain", keyword: "keyword", oa_status: "oa status",
  is_oa: "open access", language: "language", sdg: "sdg",
};

// ---------------------------------------------------------------------------
// Retractions (oxjob #1281): works queries hide retracted works unless the query says otherwise.
// ---------------------------------------------------------------------------

/** Does the query already carry its own retracted filter (`retracted is (…)`, `is_retracted`, `it's retracted`)? */
export function oqlMentionsRetracted(oql: string): boolean {
  return /\bretracted\s+is\b|\bis_retracted\b|\bit'?s\s+(?:not\s+)?retracted\b|\bnot\s+retracted\b/i.test(oql);
}

const TAIL_RE = /^(?:group\s+by|sort\s+by|sample\s+\d|return\b|limit\b)/i;

/** Split a where-clause body into [clause, tail] at the first top-level group by / sort by / sample / return / limit. */
export function splitOqlTail(body: string): [string, string] {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"') { quote = c; continue; }
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && (i === 0 || /\s/.test(body[i - 1]!)) && TAIL_RE.test(body.slice(i))) {
      return [body.slice(0, i).trim(), body.slice(i).trim()];
    }
  }
  return [body.trim(), ""];
}

/**
 * Add `retracted is (false)` to a works query unless it already filters on retracted.
 * `works where X sort by y` → `works where (X) and retracted is (false) sort by y`; a bare `works` gets a where clause.
 * Non-works queries are returned untouched.
 */
export function oqlExcludeRetracted(oql: string): { oql: string; applied: boolean } {
  const q = oql.trim();
  if (oqlMentionsRetracted(q)) return { oql: q, applied: false };
  const m = q.match(/^works\b\s*([\s\S]*)$/i);
  if (!m) return { oql: q, applied: false };
  const rest = m[1]!.trim();
  const whereMatch = rest.match(/^where\b\s*([\s\S]*)$/i);
  const [clause, tail] = whereMatch ? splitOqlTail(whereMatch[1]!) : ["", rest];
  const where = clause ? `works where (${clause}) and retracted is (false)` : "works where retracted is (false)";
  return { oql: tail ? `${where} ${tail}` : where, applied: true };
}
