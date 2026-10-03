/** Helpers for the OQL/OQO query path. Pure, unit-tested. */
import { retractedNote, RETRACTED_PER_QUERY_NOTE } from "./filters";

const ENTITIES = ["works", "authors", "institutions", "sources", "funders", "publishers", "topics", "keywords", "awards", "locations", "countries", "languages", "sdgs", "types", "fields", "subfields", "domains", "continents", "licenses", "concepts"];

/**
 * Accept a bare where-clause ("title has (x)") as shorthand for "works where title has (x)".
 * A pipeline query (`get works where ...; then ...`, #1530) starts with `get <entity>` and passes through.
 */
export function normalizeOql(input: string, entity = "works"): string {
  const s = input.trim().replace(/\s+/g, " ");
  const [first = "", second = ""] = s.toLowerCase().split(" ");
  if (ENTITIES.includes(first)) return s;
  if (first === "get" && ENTITIES.includes(second.replace(/;$/, ""))) return s;
  return `${entity} where ${s}`;
}

// ---------------------------------------------------------------------------
// The pipeline language (oxjobs #1530, #1537): `get works where ...; then group those works by ...; then calculate ...`.
// Until the API's launch flip, a query the classic form can say echoes classic; after it, every echo is a
// pipeline. Everything here reads both.
// ---------------------------------------------------------------------------

/** Split a query into its steps at top-level semicolons (outside parentheses and quotes). One step for a classic query. */
export function splitOqlSteps(oql: string): string[] {
  const steps: string[] = [];
  let depth = 0;
  let quote = false;
  let start = 0;
  for (let i = 0; i < oql.length; i++) {
    const c = oql[i];
    if (quote) { if (c === '"') quote = false; continue; }
    if (c === '"') quote = true;
    else if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === ";" && depth === 0) { steps.push(oql.slice(start, i).trim()); start = i + 1; }
  }
  steps.push(oql.slice(start).trim());
  return steps.filter(Boolean);
}

/** Is this a pipeline query (starts with `get`, or has `; then` steps)? */
export function oqlIsPipeline(oql: string): boolean {
  return /^\s*get\s/i.test(oql) || splitOqlSteps(oql).length > 1;
}

/** Does the query have a `then calculate ...` step? */
export function oqlHasCalculate(oql: string): boolean {
  return splitOqlSteps(oql).some((s) => /^then\s+calculate\b/i.test(s));
}

/**
 * Agents often end an OQL query with `sort by cited by count desc`, but sorting is not part of OQL (it's a view
 * parameter), and the parser then misreads the tail as extra values of the last clause ("retracted got more than
 * one value", #1521 e2e). Split it off: returns the query without it and the sort it named, if recognizable.
 */
const SORT_WORDS: Record<string, "relevance" | "cited_by_count" | "publication_date" | "fwci"> = {
  "relevance": "relevance", "relevance score": "relevance", "cited by count": "cited_by_count", "citations": "cited_by_count",
  "cited_by_count": "cited_by_count", "citation count": "cited_by_count", "publication date": "publication_date",
  "date": "publication_date", "publication_date": "publication_date", "year": "publication_date", "fwci": "fwci",
};
export function splitOqlSort(oql: string): { oql: string; sort?: "relevance" | "cited_by_count" | "publication_date" | "fwci"; by?: string; ascending?: boolean; stripped: boolean } {
  // A pipeline doesn't sort either (order is a display setting); agents write `; then sort by mean FWCI` or a
  // trailing `sort by` on the last step. `by` keeps the words so a calculation can order its rows by that column.
  if (!oqlIsPipeline(oql)) {
    const m = oql.match(/^([\s\S]*?)\s+sort(?:ed)? by\s+([a-z_ ]+?)(?:\s+(?:desc|descending|asc|ascending))?\s*$/i);
    if (!m) return { oql, stripped: false };
    return { oql: m[1]!.trim(), sort: SORT_WORDS[m[2]!.trim().toLowerCase()], stripped: true };
  }
  const m = oql.match(/^([\s\S]*?)(?:\s*;\s*then)?\s+sort(?:ed)? by\s+([^;()]+?)(?:\s+(desc|descending|asc|ascending))?\s*;?\s*$/i);
  if (!m) return { oql, stripped: false };
  const by = m[2]!.trim();
  return { oql: m[1]!.trim().replace(/;$/, "").trim(), sort: SORT_WORDS[by.toLowerCase()], by, ascending: /^asc/i.test(m[3] ?? "") || undefined, stripped: true };
}

/** Does the query contain a text-search clause (so relevance sorting is meaningful)? */
export function oqlHasSearch(oql: string): boolean {
  return /\bhas\b|\bis similar to\b/i.test(oql);
}

export function oqlHasGroupBy(oql: string): boolean {
  return /\bgroup by\b|\bgroup\s+those\s+\w+\s+(?:again\s+)?(?:by|into)\b/i.test(oql);
}

export function oqlHasSample(oql: string): boolean {
  return /\bsample\s+\(?\s*\d+/i.test(oql);
}

/** Add a random sample of n: `sample n` on a classic query, a `then sample (n) of those works` step on a pipeline. */
export function oqlAddSample(oql: string, n: number): string {
  return oqlIsPipeline(oql) ? `${oql}; then sample (${n}) of those works` : `${oql} sample ${n}`;
}

/** Add a split: `group by dim` on a classic query; on a pipeline a step before the calculation, which stays last. */
export function oqlAddGroupBy(oql: string, dim: string): string {
  if (!oqlIsPipeline(oql)) return `${oql} group by ${dim}`;
  const steps = splitOqlSteps(oql);
  const at = steps.findIndex((s) => /^then\s+calculate\b/i.test(s));
  steps.splice(at < 0 ? steps.length : at, 0, `then group those works by ${dim}`);
  return steps.join("; ");
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

/** Canonical OQL echo (one line) and a URL that reruns it, from a list response. */
export function queryEcho(data: { meta?: any }): { oql?: string; reproduce_url?: string | null } {
  const oql = oneLine(data?.meta?.x_query?.oql);
  return oql ? { oql, reproduce_url: reproduceUrl(oql) } : {};
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
 * Non-works queries are returned untouched. In a pipeline (a classic query is a one-step pipeline) the default goes on
 * the starting set; a later step that splits or calculates on retracted (`percent retracted`) wants them in.
 */
export function oqlExcludeRetracted(oql: string): { oql: string; applied: boolean } {
  const q = oql.trim();
  if (oqlMentionsRetracted(q)) return { oql: q, applied: false };
  const [first = "", ...rest] = splitOqlSteps(q);
  if (rest.some((s) => /\bretracted\b/i.test(s))) return { oql: q, applied: false };
  const m = first.match(/^(get\s+)?works\b\s*([\s\S]*)$/i);
  if (!m) return { oql: q, applied: false };
  const lead = m[1] ? "get works" : "works";
  const body = m[2]!.trim();
  const whereMatch = body.match(/^where\b\s*([\s\S]*)$/i);
  const [clause, tail] = whereMatch ? splitOqlTail(whereMatch[1]!) : ["", body];
  const where = clause ? `${lead} where (${clause}) and retracted is (false)` : `${lead} where retracted is (false)`;
  return { oql: [tail ? `${where} ${tail}` : where, ...rest].join("; "), applied: true };
}

/**
 * The query as the works tools run it: shorthand expanded, a trailing sort split off (OQL has none), and retracted
 * works left out unless asked for, with the note that says which.
 */
export function prepareOql(input: string, includeRetracted: boolean) {
  const sort = splitOqlSort(normalizeOql(input));
  if (includeRetracted) return { oql: sort.oql, sort, retractedWorks: oqlMentionsRetracted(sort.oql) ? RETRACTED_PER_QUERY_NOTE : retractedNote(true) };
  const r = oqlExcludeRetracted(sort.oql);
  return { oql: r.oql, sort, retractedWorks: r.applied ? retractedNote(false) : RETRACTED_PER_QUERY_NOTE };
}
