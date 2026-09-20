/**
 * Pure helpers for find_experts (oxjob #1274): candidate counting, evidence attribution from a
 * sample of works, exclusions, ranking. Unit-tested; no I/O.
 */
import { shortId } from "./ids";

export interface Candidate {
  id: string;
  name: string;
  matching_works: number;
  recent_matching_works?: number;
}

export interface Evidence {
  id: string;
  title: string | null;
  year: number | null;
  cited_by_count: number;
  doi: string | null;
}

export interface EvidenceSummary {
  evidence: Evidence[];
  citations_in_sample: number;
  works_in_sample: number;
  latest_year: number | null;
}

/** Count authors across a list of works (for semantic mode, where the API cannot group). */
export function countAuthors(works: any[]): Candidate[] {
  const m = new Map<string, Candidate>();
  for (const w of works) {
    const seen = new Set<string>();
    for (const a of w.authorships ?? []) {
      const id = shortId(a?.author?.id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const c = m.get(id) ?? { id, name: a?.author?.display_name ?? a?.raw_author_name ?? id, matching_works: 0 };
      c.matching_works++;
      m.set(id, c);
    }
  }
  return [...m.values()].sort((a, b) => b.matching_works - a.matching_works);
}

/** Group rows from the API into candidates. */
export function candidatesFromGroups(groups: Array<{ key: string; key_display_name?: string; count: number }>): Candidate[] {
  return groups
    .map((g) => ({ id: shortId(g.key) ?? g.key, name: g.key_display_name ?? g.key, matching_works: g.count }))
    .filter((c) => /^A\d+$/.test(c.id));
}

/** For each candidate id, the sample works that list them: top titles by citations plus totals. */
export function attributeEvidence(works: any[], ids: Iterable<string>, maxTitles = 5): Map<string, EvidenceSummary> {
  const want = new Set(ids);
  const acc = new Map<string, { rows: Evidence[]; cites: number; latest: number | null }>();
  for (const w of works) {
    const authors = new Set<string>();
    for (const a of w.authorships ?? []) {
      const id = shortId(a?.author?.id);
      if (id && want.has(id)) authors.add(id);
    }
    if (!authors.size) continue;
    const row: Evidence = {
      id: shortId(w.id) ?? w.id,
      title: w.display_name ?? null,
      year: w.publication_year ?? null,
      cited_by_count: w.cited_by_count ?? 0,
      doi: w.doi ? String(w.doi).replace(/^https?:\/\/doi\.org\//i, "") : null,
    };
    for (const id of authors) {
      const cur = acc.get(id) ?? { rows: [], cites: 0, latest: null };
      cur.rows.push(row);
      cur.cites += row.cited_by_count;
      if (row.year != null && (cur.latest == null || row.year > cur.latest)) cur.latest = row.year;
      acc.set(id, cur);
    }
  }
  const out = new Map<string, EvidenceSummary>();
  for (const [id, cur] of acc) {
    cur.rows.sort((a, b) => b.cited_by_count - a.cited_by_count || (b.year ?? 0) - (a.year ?? 0));
    out.set(id, { evidence: cur.rows.slice(0, maxTitles), citations_in_sample: cur.cites, works_in_sample: cur.rows.length, latest_year: cur.latest });
  }
  return out;
}

/** Every coauthor id appearing on these works (excluding the anchors themselves). */
export function coauthorIds(works: any[], anchors: Iterable<string>): Set<string> {
  const skip = new Set(anchors);
  const out = new Set<string>();
  for (const w of works) for (const a of w.authorships ?? []) {
    const id = shortId(a?.author?.id);
    if (id && !skip.has(id)) out.add(id);
  }
  return out;
}

/** Does an author profile's current institution fall inside any of these lineages? */
export function currentlyAt(author: any, institutionIds: Set<string>): boolean {
  if (!institutionIds.size) return true;
  for (const i of author?.last_known_institutions ?? []) {
    const own = shortId(i?.id);
    if (own && institutionIds.has(own)) return true;
    for (const l of i?.lineage ?? []) {
      const lid = shortId(l);
      if (lid && institutionIds.has(lid)) return true;
    }
  }
  return false;
}

export function currentCountry(author: any): string | null {
  const cc = author?.last_known_institutions?.[0]?.country_code;
  return cc ? String(cc).toUpperCase() : null;
}

export type ExpertSort = "matching_works" | "recent" | "citations" | "h_index";

export interface ExpertRow {
  id: string;
  name: string;
  matching_works: number;
  recent_matching_works?: number;
  citations_in_sample: number;
  h_index: number | null;
  [k: string]: any;
}

export function rankExperts<T extends ExpertRow>(rows: T[], sort: ExpertSort): T[] {
  const key = (r: T): number[] => {
    switch (sort) {
      case "recent": return [r.recent_matching_works ?? 0, r.matching_works, r.citations_in_sample];
      case "citations": return [r.citations_in_sample, r.matching_works, r.h_index ?? 0];
      case "h_index": return [r.h_index ?? 0, r.matching_works, r.citations_in_sample];
      default: return [r.matching_works, r.citations_in_sample, r.h_index ?? 0];
    }
  };
  return [...rows].sort((a, b) => {
    const ka = key(a), kb = key(b);
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return kb[i] - ka[i];
    return a.name.localeCompare(b.name);
  });
}

export const round3 = (n: number) => Number(n.toFixed(3));

/** Has the author ever been affiliated (affiliation history) with any of these institutions, by lineage? */
export function affiliatedWith(author: any, institutionIds: Set<string>): boolean {
  if (!institutionIds.size) return true;
  if (currentlyAt(author, institutionIds)) return true;
  for (const a of author?.affiliations ?? []) {
    const own = shortId(a?.institution?.id);
    if (own && institutionIds.has(own)) return true;
    for (const l of a?.institution?.lineage ?? []) {
      const lid = shortId(l);
      if (lid && institutionIds.has(lid)) return true;
    }
  }
  return false;
}

/** Sum of the author's own work counts on the given topic ids (from the profile's topics list; null when none listed). */
export function topicWorks(author: any, topicIds: Set<string>): number | null {
  if (!topicIds.size) return null;
  let n = 0, hit = false;
  for (const t of author?.topics ?? []) {
    const id = shortId(t?.id);
    if (id && topicIds.has(id)) { n += t?.count ?? 0; hit = true; }
  }
  return hit ? n : null;
}

/**
 * Split a normalized works OQL query into its where-clause, refusing trailing clauses
 * (group by / sort by / sample / return) that find_experts adds or forbids itself.
 */
export function oqlWhereClause(oql: string): { clause: string } | { error: string } {
  const m = oql.match(/^works\s+where\s+([\s\S]+)$/i);
  if (!m) return { error: "oql must select works (\"works where …\" or a bare where-clause)." };
  const clause = m[1].trim();
  if (/\b(group by|sort by|sample|return)\b/i.test(clause)) return { error: "oql must be a plain selection: find_experts adds its own group by, sort and return clauses." };
  return { clause };
}

/** The same selection restricted to `year >= floor`. */
export function oqlWithYearFloor(clause: string, floor: number): string {
  return `works where (${clause}) and year >= (${floor})`;
}
