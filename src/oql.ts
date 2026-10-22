/** Helpers for the OQL/OQO query path. Pure, unit-tested. */
import { retractedNote, RETRACTED_PER_QUERY_NOTE } from "./filters";

const ENTITIES = ["works", "authors", "institutions", "sources", "funders", "publishers", "topics", "keywords", "awards", "locations", "countries", "languages", "sdgs", "types", "fields", "subfields", "domains", "continents", "licenses", "concepts"];

/**
 * Accept a bare where-clause ("title has (x)") as shorthand for "works where title has (x)".
 * A pipeline query (`get works where ...; then ...`, #1530) starts with `get <entity>` and passes through.
 */
export function normalizeOql(input: string, entity = "works"): string {
  const s = input.trim().replace(/\s+/g, " ");
  const first = s.toLowerCase().split(" ")[0] ?? "";
  // every `get` statement passes: `get works ...`, and the new form's `get the count of ...`, `get non-retracted works`,
  // `get [UBC](I141945490)'s articles` (#1555)
  if (ENTITIES.includes(first) || first === "get") return s;
  return `${entity} where ${s}`;
}

// ---------------------------------------------------------------------------
// The pipeline language (oxjobs #1530, #1537, #1555): `get works where ...; then, group those works by ...; finally,
// summarize using ...`, or `...; then, compare A versus B using ...`. A step opens with `then` (`then,`), `finally,`
// or nothing (`compare`, `summarize`); `calculate` is gone (#1555).
// The string handling here reads today's forms (classic and this step form). The API's echo is the new form once its
// default flips (#1555): a new-form sentence is translated to the step form first (`prepareAnyOql`, below).
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

// A step's opening word, if any: `then`, `then,`, `finally,` (#1555).
const STEP_OPENER = String.raw`^(?:(?:then|finally|next|lastly),?\s+)?`;
const SUMMARY_STEP = new RegExp(STEP_OPENER + String.raw`(?:summarize\s+using|calculate)\b`, "i");
const COMPARE_STEP = new RegExp(STEP_OPENER + String.raw`compare\b`, "i");

/** A new-form number or table: `get the count of works about kelp by year` (#1555). */
export function oqlIsNumbers(oql: string): boolean {
  return /^\s*get\s+the\s/i.test(oql);
}

/** Does the query calculate: a new-form number or table, a `summarize using ...` step, or a `compare ... using ...` step? */
export function oqlHasCalculate(oql: string): boolean {
  return oqlIsNumbers(oql)
    || splitOqlSteps(oql).slice(1).some((s) => SUMMARY_STEP.test(s) || (COMPARE_STEP.test(s) && /\busing\b/i.test(s)));
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
  // the new form searches `about kelp` and `with kelp in the title` (#1555)
  return /\bhas\b|\bsimilar to\b|\babout\b|\bwith\b[^;]*?\bin the (?:title|abstract|full text)\b/i.test(oql);
}

export function oqlHasGroupBy(oql: string): boolean {
  return /\bgroup by\b|\bgroup\s+(?:those\s+\w+|each\s+\S+\s+works)\s+(?:again\s+)?(?:by|into)\b/i.test(oql)
    || splitOqlSteps(oql).slice(1).some((s) => COMPARE_STEP.test(s))   // `compare A versus B` splits too (#1555)
    || oqlThingFirst(splitOqlSteps(oql)[0] ?? "") !== null;           // `get authors ... who published works where` (#1555)
}

// Thing-first (oxjob #1555): `get authors at [UBC](I141945490) since 2022 who published works where ...` is works split
// by the thing, one row per author over the works that match. Any verb, `with` or `of`, an optional count.
const THING_FIRST_HEAD = new RegExp(
  String.raw`^get\s+(authors|institutions|sources|journals|publishers|funders|countries|topics)\b[\s\S]*?` +
  String.raw`\b(?:(?:who|that|which)\s+(?:(?:were|was)\s+(?:the\s+)?corresponding\s+(?:authors?|institutions?)\s+(?:of|on|for)` +
  String.raw`|(?:(?:ever|have|has|also|all)\s+)*[a-z-]+)|with|of)\s+` +
  String.raw`(?:(?:more than|at least|fewer than|at most|over|under)\s+\d+\s+)?works?\b` +
  String.raw`(?:\s+(?:anywhere|at any institution(?:,?\s+in any year)?|in any year|\(at any institution,?\s+in any year\)))?`,
  "i");

/** The start of a thing-first query: { head (up to `works`), thing, body (`where ...` and the rest) }, or null. */
export function oqlThingFirst(first: string): { head: string; thing: string; body: string } | null {
  const m = first.trim().match(THING_FIRST_HEAD);
  if (!m) return null;
  const body = first.trim().slice(m[0].length).trim();
  if (body && !/^where\b/i.test(body)) return null;
  return { head: m[0], thing: m[1]!.toLowerCase(), body };
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
  const at = steps.findIndex((s, i) => i > 0 && SUMMARY_STEP.test(s));
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

// the new form says it before the noun: `get non-retracted works`, `get retracted articles` (#1555)
const NEW_FORM_RETRACTED = new RegExp(String.raw`\bnon-retracted\b|\bretracted\s+(?:works|articles|reviews|preprints|books|book chapters|datasets|conference papers|dissertations|editorials|letters|reports)\b`, "i");

/** Does the query already carry its own retracted filter (`retracted is (…)`, `is_retracted`, `it's retracted`, `non-retracted`)? */
export function oqlMentionsRetracted(oql: string): boolean {
  return /\bretracted\s+is\b|\bis_retracted\b|\bit'?s\s+(?:not\s+)?retracted\b|\bnot\s+retracted\b/i.test(oql)
    || NEW_FORM_RETRACTED.test(oql);
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
  // `get authors at [UBC] since 2022 who published works where ...`: the works it names (#1555)
  const tf = oqlThingFirst(first);
  const m = tf ? [first, tf.head, tf.body] : first.match(/^(get\s+)?works\b\s*([\s\S]*)$/i);
  if (!m) return { oql: q, applied: false };
  let lead = tf ? tf.head : m[1] ? "get works" : "works";
  let body = m[2]!.trim();
  // a start from a saved list keeps its place: `get works in the collection [Our lab](col_x) where ...` (#1555)
  const coll = body.match(/^in\s+(?:the\s+)?(?:collection|set)\s+(?:\[[^\]]*\])?\([^)]*\)|^in\s+\([^)]*\)/i);
  if (coll) { lead = `${lead} ${coll[0]}`; body = body.slice(coll[0].length).trim(); }
  const whereMatch = body.match(/^where\b\s*([\s\S]*)$/i);
  const [clause, tail] = whereMatch ? splitOqlTail(whereMatch[1]!) : ["", body];
  const where = clause ? `${lead} where (${clause}) and retracted is (false)` : `${lead} where retracted is (false)`;
  return { oql: [tail ? `${where} ${tail}` : where, ...rest].join("; "), applied: true };
}

// ---------------------------------------------------------------------------
// The new form (OQL core v3, oxjob #1555): one `get` sentence (`get works about kelp since 2020`, `get the count of
// non-retracted works about kelp by year, highest first`) plus `Only ...` / `Show ...` sentences. Once the API's
// default flips, its echo reads this way and agents paste it back. The string handling above reads today's forms, so
// a sentence is translated to today's step form first, by the API's free check (`?oql_style=pipeline`); the order a
// sentence states travels as the sort param, since the step form has none.
// ---------------------------------------------------------------------------

/** `get <entity> where ...` (or `;`, or nothing), optionally from a collection: today's start of a statement. */
const TODAYS_HEAD = new RegExp(
  String.raw`^get\s+(?:${ENTITIES.join("|")})\b(?:\s+in\s+(?:the\s+)?(?:collection|set)\s+(?:\[[^\]]*\])?\([^)]*\))?\s*(?:where\b|;|$)`, "i");

/** Is this a new-form sentence (rather than one of today's forms)? */
export function oqlIsSentence(oql: string): boolean {
  const q = oql.trim();
  return /^get\s/i.test(q) && splitOqlSteps(q).length === 1 && !TODAYS_HEAD.test(q) && oqlThingFirst(q) === null;
}

/** The free check, which also translates a query to the form asked for. */
export interface OqlChecker { checkOql(oql: string, style?: string): Promise<any> }

/** An OQO's sort_by as the API's sort param (`publication_date:desc`), or undefined. */
function sortParam(sortBy: any): string | undefined {
  if (!Array.isArray(sortBy) || !sortBy.length) return undefined;
  return sortBy.map((s: any) => `${s.column_id}:${s.direction === "asc" ? "asc" : "desc"}`).join(",");
}

/**
 * A sentence in today's step form, with the order it states as a sort param. The text is unchanged when the API can't
 * read it, so the run reports the API's own error.
 */
export async function sentenceInTodaysForm(api: OqlChecker, oql: string): Promise<{ oql: string; sort?: string }> {
  try {
    const r = await api.checkOql(oql, "pipeline");
    const text = oneLine(r?.oql);
    if (text) return { oql: text, sort: sortParam(r?.oqo?.sort_by) };
  } catch {
    /* the run reports it */
  }
  return { oql };
}

/** `prepareOql` for any form: a new-form sentence goes to today's step form first (one free API call). */
export async function prepareAnyOql(api: OqlChecker, input: string, includeRetracted: boolean) {
  const q = input.trim();
  const t = oqlIsSentence(q) ? await sentenceInTodaysForm(api, q) : { oql: q };
  return { ...prepareOql(t.oql, includeRetracted), statedSort: t.sort, fromSentence: t.oql !== q };
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
