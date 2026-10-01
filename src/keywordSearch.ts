/**
 * Keyword-aware systematic search (oxjob #1469). Pure helpers, unit-tested.
 *
 * A topic is split into facets ("microplastics", "human health"). Each facet matches a work when its
 * title/abstract text matches OR the work carries one of the facet's keywords; the facets are ANDed.
 * Keywords only ever widen a facet's text search, never replace it (about 11% of works have no keywords),
 * and every facet needs its own keyword: OR'ing a keyword for just one facet pulls in that whole field
 * (#1322 agent trial: 4% and 18% on topic).
 */

export interface Facet {
  label?: string;
  /** Inside of `title/abstract has (...)`: synonyms joined with or, "quoted phrases", "wildcard*" quoted. */
  text?: string;
  /** Keyword ids (slugs like human-health, or https://openalex.org/keywords/... URLs). */
  keyword_ids?: string[];
}

export interface SearchFilters {
  from_year?: number;
  to_year?: number;
  types?: string[];
  open_access_only?: boolean;
  language?: string;
  include_retracted?: boolean;
  /** Extra OQL condition ANDed onto every query, e.g. `country is (BR)`. */
  extra_oql?: string;
}

/** `https://openalex.org/keywords/human-health`, `keywords/human-health` or `human-health` → `human-health`. */
export function keywordSlug(input: string): string {
  return input.trim().replace(/^https?:\/\/(?:api\.)?openalex\.org\//i, "").replace(/^keywords\//i, "").trim().toLowerCase();
}

// Ids are lower-case slugs, some with non-ASCII letters or dashes (work\u2013life-balance); reject only what can't be one.
const SLUG_RE = /^[^\s()"|,]+$/;

/**
 * Quote bare wildcard terms (telework* → "telework*"): OQL runs wildcards on exact text and rejects them
 * unquoted, and agents write them bare often enough to cost a round trip each time (#1469 e2e).
 */
export function quoteWildcards(text: string): string {
  return text.split('"').map((seg, i) => (i % 2 ? seg : seg.replace(/(^|[\s(])([\p{L}\p{N}][\p{L}\p{N}\-']*\*)(?=$|[\s)])/gu, '$1"$2"'))).join('"');
}

export function cleanFacets(facets: Facet[]): Array<{ label: string; text: string | null; keywords: string[] }> {
  return facets.map((f, i) => {
    const text = f.text?.trim() ? quoteWildcards(f.text.trim()) : null;
    const keywords = [...new Set((f.keyword_ids ?? []).map(keywordSlug).filter(Boolean))];
    const bad = keywords.filter((k) => !SLUG_RE.test(k));
    if (bad.length) throw new Error(`Facet ${i + 1}: not keyword ids: ${bad.join(", ")}. Use the ids find_keywords returns, e.g. human-health.`);
    if (!text && !keywords.length) throw new Error(`Facet ${i + 1} needs text, keyword_ids, or both.`);
    return { label: f.label?.trim() || text || keywords.join(" | "), text, keywords };
  });
}

type CleanFacet = ReturnType<typeof cleanFacets>[number];

export const textClause = (f: CleanFacet) => (f.text ? `title/abstract has (${f.text})` : null);
export const keywordClause = (f: CleanFacet) => (f.keywords.length ? `keyword is (${f.keywords.join(" or ")})` : null);

/** The facet's full clause: text or keyword, whichever it has. */
export function facetClause(f: CleanFacet): string {
  const t = textClause(f);
  const k = keywordClause(f);
  return t && k ? `(${t} or ${k})` : (t ?? k)!;
}

export function filterClauses(fl: SearchFilters): string[] {
  const out: string[] = [];
  if (fl.from_year !== undefined && fl.to_year !== undefined && fl.from_year > fl.to_year)
    throw new Error(`from_year (${fl.from_year}) is after to_year (${fl.to_year}).`);
  if (fl.from_year !== undefined) out.push(`year >= (${fl.from_year})`);
  if (fl.to_year !== undefined) out.push(`year <= (${fl.to_year})`);
  if (fl.types?.length) out.push(`type is (${fl.types.join(" or ")})`);
  if (fl.open_access_only) out.push("open access is (true)");
  if (fl.language) out.push(`language is (${fl.language.toLowerCase()})`);
  if (fl.extra_oql?.trim()) out.push(`(${fl.extra_oql.trim()})`);
  if (!fl.include_retracted && !/\bretracted\b/i.test(fl.extra_oql ?? "")) out.push("retracted is (false)");
  return out;
}

const where = (clauses: string[]) => `works where ${clauses.join(" and ")}`;

/**
 * The queries a keyword-aware search reports on.
 * - combined: every facet as (text or keyword), ANDed, plus filters. This is the search to hand back.
 * - text_only: the same search with the keyword halves removed (what a title/abstract search finds).
 * - added_by_keywords: works in combined but not in text_only (found only because of keywords).
 * - per facet (under the filters only): text, keyword, and keyword-not-text; with two or more facets,
 *   also every other facet without this one, so the caller can tell whether this facet narrows anything.
 */
export function buildKeywordSearch(facets: Facet[], filters: SearchFilters) {
  const fs = cleanFacets(facets);
  const fc = filterClauses(filters);
  const combinedBody = [...fs.map(facetClause), ...fc];
  const textFacets = fs.filter((f) => f.text);
  const hasText = textFacets.length === fs.length;
  const textBody = hasText ? [...fs.map((f) => textClause(f)!), ...fc] : null;
  const anyKeywords = fs.some((f) => f.keywords.length);
  const notText = textBody ? `not (${fs.map((f) => textClause(f)!).join(" and ")})` : null;
  const queries = {
    combined: where(combinedBody),
    text_only: textBody ? where(textBody) : null,
    // The not-clause goes before the filters: after `retracted is (false)` the parser reads it as a second retracted value.
    added_by_keywords: notText && anyKeywords ? where([...fs.map(facetClause), notText, ...fc]) : null,
  };
  /** Additions that carry one given keyword (how much each keyword brings in). */
  const addedWith = (keyword: string) => (notText ? where([...fs.map(facetClause), notText, `keyword is (${keyword})`, ...fc]) : null);
  const perFacet = fs.map((f) => {
    const t = textClause(f);
    const k = keywordClause(f);
    return {
      label: f.label,
      text: t ? where([t, ...fc]) : null,
      keyword: k ? where([k, ...fc]) : null,
      keyword_not_text: t && k ? where([k, `not (${t})`, ...fc]) : null,
      others: fs.length > 1 ? where([...fs.filter((g) => g !== f).map(facetClause), ...fc]) : null,
    };
  });
  const warnings: string[] = [];
  const noKw = fs.filter((f) => !f.keywords.length).map((f) => f.label);
  if (anyKeywords && noKw.length) warnings.push(`No keyword for: ${noKw.join(", ")}. That facet matches on text only; look for a keyword with find_keywords if one fits.`);
  const noText = fs.filter((f) => !f.text).map((f) => f.label);
  if (noText.length) warnings.push(`No text for: ${noText.join(", ")}. About 11% of works have no keywords, so add the facet's phrase and synonyms as text too.`);
  return { facets: fs, queries, perFacet, addedWith, warnings };
}
