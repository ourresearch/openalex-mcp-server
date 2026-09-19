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
