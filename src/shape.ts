/**
 * Response shaping: turn large OpenAlex entity objects into compact, LLM-friendly records.
 * Everything here is pure and unit-tested.
 */
import { shortId } from "./ids";

/** Rebuild plain-text abstract from OpenAlex's inverted index. */
export function abstractFromInvertedIndex(idx: Record<string, number[]> | null | undefined): string | null {
  if (!idx || typeof idx !== "object") return null;
  const words: string[] = [];
  for (const [word, positions] of Object.entries(idx)) {
    for (const p of positions) words[p] = word;
  }
  const text = words.filter((w) => w !== undefined).join(" ").trim();
  return text.length ? text : null;
}

export function truncate(text: string | null | undefined, max: number): string | null {
  if (!text) return null;
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut) + "…";
}

/** Drop null/undefined/empty-array/empty-string values so output stays terse. */
export function compact<T extends Record<string, any>>(obj: T): Partial<T> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string" && v === "") continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out as Partial<T>;
}

export function openalexUrl(id: string | null | undefined): string | null {
  const s = shortId(id);
  return s ? `https://openalex.org/${s}` : null;
}

const round = (n: number | null | undefined, d = 2) =>
  typeof n === "number" && Number.isFinite(n) ? Number(n.toFixed(d)) : null;

// ---------------------------------------------------------------------------
// Works
// ---------------------------------------------------------------------------

export interface ShapeWorkOptions {
  /** Max abstract characters; 0 or undefined = omit abstract. */
  abstractChars?: number;
  /** How many authors to list before collapsing to "+N more". */
  maxAuthors?: number;
  /** Include full detail (all authors with affiliations, topics, locations, funders…). */
  full?: boolean;
}

function authorLine(a: any): string {
  const name = a?.author?.display_name ?? a?.raw_author_name ?? "Unknown";
  const inst = a?.institutions?.[0]?.display_name;
  return inst ? `${name} (${inst})` : name;
}

export function shapeWork(w: any, opts: ShapeWorkOptions = {}) {
  const maxAuthors = opts.maxAuthors ?? 5;
  const authorships: any[] = Array.isArray(w.authorships) ? w.authorships : [];
  const loc = w.primary_location ?? {};
  const src = loc.source ?? {};
  const oa = w.open_access ?? {};
  const abstractText = abstractFromInvertedIndex(w.abstract_inverted_index);

  const base: Record<string, any> = {
    id: shortId(w.id),
    doi: w.doi ? String(w.doi).replace(/^https?:\/\/doi\.org\//i, "") : null,
    title: w.display_name ?? w.title ?? null,
    year: w.publication_year ?? null,
    type: w.type ?? null,
    venue: src.display_name ?? loc.raw_source_name ?? null,
    venue_id: shortId(src.id),
    cited_by_count: w.cited_by_count ?? null,
    fwci: round(w.fwci),
    is_oa: typeof oa.is_oa === "boolean" ? oa.is_oa : null,
    oa_url: oa.oa_url ?? null,
    is_retracted: w.is_retracted ? true : null,
    relevance_score: typeof w.relevance_score === "number" ? round(w.relevance_score, 3) : null,
    openalex_url: openalexUrl(w.id),
  };

  if (opts.full) {
    base.publication_date = w.publication_date ?? null;
    base.language = w.language ?? null;
    base.authors = authorships.map((a) =>
      compact({
        name: a?.author?.display_name ?? a?.raw_author_name ?? null,
        id: shortId(a?.author?.id),
        orcid: a?.author?.orcid ? String(a.author.orcid).replace(/^https?:\/\/orcid\.org\//i, "") : null,
        position: a?.author_position ?? null,
        is_corresponding: a?.is_corresponding ? true : null,
        institutions: (a?.institutions ?? []).map((i: any) => i?.display_name).filter(Boolean),
      })
    );
    base.abstract = abstractText;
    base.primary_topic = w.primary_topic
      ? compact({
          id: shortId(w.primary_topic.id),
          name: w.primary_topic.display_name,
          subfield: w.primary_topic.subfield?.display_name,
          field: w.primary_topic.field?.display_name,
          domain: w.primary_topic.domain?.display_name,
        })
      : null;
    base.topics = (w.topics ?? []).slice(0, 5).map((t: any) => t?.display_name).filter(Boolean);
    base.keywords = (w.keywords ?? []).slice(0, 10).map((k: any) => k?.display_name).filter(Boolean);
    base.oa_status = oa.oa_status ?? null;
    base.license = loc.license ?? null;
    base.landing_page_url = loc.landing_page_url ?? null;
    base.pdf_url = loc.pdf_url ?? w.best_oa_location?.pdf_url ?? null;
    base.volume = w.biblio?.volume ?? null;
    base.issue = w.biblio?.issue ?? null;
    base.pages =
      w.biblio?.first_page && w.biblio?.last_page
        ? `${w.biblio.first_page}-${w.biblio.last_page}`
        : w.biblio?.first_page ?? null;
    base.referenced_works_count = w.referenced_works_count ?? null;
    base.citation_percentile = round(w.citation_normalized_percentile?.value);
    base.funders = (w.funders ?? []).map((f: any) => f?.display_name).filter(Boolean);
    base.awards = (w.awards ?? [])
      .slice(0, 10)
      .map((g: any) => compact({ funder: g?.funder_display_name, award_id: g?.funder_award_id }));
    base.sustainable_development_goals = (w.sustainable_development_goals ?? [])
      .slice(0, 3)
      .map((s: any) => s?.display_name)
      .filter(Boolean);
    base.citations_by_year = (w.counts_by_year ?? [])
      .slice(0, 6)
      .map((c: any) => ({ year: c.year, citations: c.cited_by_count }));
    base.related_works = (w.related_works ?? []).slice(0, 5).map((r: string) => shortId(r));
    base.pmid = w.ids?.pmid ? String(w.ids.pmid).replace(/^.*\//, "") : null;
    base.pmcid = w.ids?.pmcid ? String(w.ids.pmcid).replace(/^.*\//, "") : null;
    base.has_fulltext = w.has_fulltext ? true : null;
    base.updated_date = w.updated_date ? String(w.updated_date).slice(0, 10) : null;
  } else {
    const shown = authorships.slice(0, maxAuthors).map(authorLine);
    const extra = authorships.length - shown.length;
    base.authors = extra > 0 ? [...shown, `+${extra} more`] : shown;
    base.primary_topic = w.primary_topic?.display_name ?? null;
    if (opts.abstractChars && abstractText) base.abstract = truncate(abstractText, opts.abstractChars);
  }
  return compact(base);
}

// ---------------------------------------------------------------------------
// Other entities
// ---------------------------------------------------------------------------

export type EntityKind = "authors" | "institutions" | "sources" | "topics" | "funders" | "publishers";

export function shapeEntity(kind: EntityKind, e: any, full = false, requestedTopicIds: string[] = []) {
  const common: Record<string, any> = {
    id: shortId(e.id),
    name: e.display_name ?? null,
    works_count: e.works_count ?? null,
    cited_by_count: e.cited_by_count ?? null,
    relevance_score: typeof e.relevance_score === "number" ? round(e.relevance_score, 1) : null,
    openalex_url: openalexUrl(e.id),
  };
  const stats = e.summary_stats ?? {};
  const topicNames = (e.topics ?? [])
    .slice(0, full ? 10 : 3)
    .map((t: any) => (t?.display_name ? (typeof t.count === "number" ? `${t.display_name} (${t.count})` : t.display_name) : null))
    .filter(Boolean);
  const worksInTopic = requestedTopicIds.length
    ? (e.topics ?? [])
        .filter((t: any) => requestedTopicIds.includes(shortId(t?.id) ?? ""))
        .reduce((sum: number, t: any) => sum + (typeof t.count === "number" ? t.count : 0), 0)
    : null;
  const countsByYear = full
    ? (e.counts_by_year ?? []).slice(0, 6).map((c: any) => ({ year: c.year, works: c.works_count, citations: c.cited_by_count }))
    : undefined;

  switch (kind) {
    case "authors": {
      const affs = (e.affiliations ?? []).map((a: any) =>
        compact({
          institution: a?.institution?.display_name,
          id: shortId(a?.institution?.id),
          country: a?.institution?.country_code,
          years: Array.isArray(a?.years) && a.years.length ? `${Math.min(...a.years)}-${Math.max(...a.years)}` : null,
        })
      );
      return compact({
        ...common,
        orcid: e.orcid ? String(e.orcid).replace(/^https?:\/\/orcid\.org\//i, "") : null,
        h_index: stats.h_index ?? null,
        i10_index: full ? stats.i10_index ?? null : null,
        current_institutions: (e.last_known_institutions ?? []).map((i: any) => i?.display_name).filter(Boolean),
        affiliation_history: full ? affs : undefined,
        works_in_topic: worksInTopic,
        topics: topicNames,
        alternate_names: full ? (e.display_name_alternatives ?? []).slice(0, 5) : undefined,
        counts_by_year: countsByYear,
      });
    }
    case "institutions":
      return compact({
        ...common,
        ror: e.ror ? String(e.ror).replace(/^https?:\/\/ror\.org\//i, "") : null,
        country: e.country_code ?? null,
        type: e.type ?? null,
        city: full ? e.geo?.city ?? null : null,
        homepage: full ? e.homepage_url ?? null : null,
        h_index: full ? stats.h_index ?? null : null,
        acronyms: full ? (e.display_name_acronyms ?? []) : undefined,
        parent_institutions: full
          ? (e.associated_institutions ?? []).filter((a: any) => a?.relationship === "parent").map((a: any) => a?.display_name)
          : undefined,
        topics: full ? topicNames : undefined,
        counts_by_year: countsByYear,
      });
    case "sources":
      return compact({
        ...common,
        type: e.type ?? null,
        issn_l: e.issn_l ?? null,
        publisher: e.host_organization_name ?? null,
        is_oa: typeof e.is_oa === "boolean" ? e.is_oa : null,
        is_in_doaj: e.is_in_doaj ? true : null,
        is_core: typeof e.is_core === "boolean" ? e.is_core : null,
        h_index: stats.h_index ?? null,
        two_year_mean_citedness: round(stats["2yr_mean_citedness"]),
        apc_usd: e.apc_usd ?? null,
        country: e.country_code ?? null,
        homepage: full ? e.homepage_url ?? null : null,
        listed_in: full ? (e.listed_in ?? []) : undefined,
        topics: full ? topicNames : undefined,
        counts_by_year: countsByYear,
      });
    case "topics":
      return compact({
        ...common,
        description: truncate(e.description, full ? 600 : 200),
        subfield: e.subfield?.display_name ?? null,
        field: e.field?.display_name ?? null,
        domain: e.domain?.display_name ?? null,
        keywords: full ? (e.keywords ?? []).slice(0, 15) : undefined,
        siblings: full ? (e.siblings ?? []).slice(0, 8).map((s: any) => compact({ id: shortId(s?.id), name: s?.display_name })) : undefined,
      });
    case "funders":
      return compact({
        ...common,
        country: e.country_code ?? null,
        description: truncate(e.description, 200),
        awards_count: e.awards_count ?? null,
        alternate_names: full ? (e.alternate_titles ?? []).slice(0, 5) : undefined,
        homepage: full ? e.homepage_url ?? null : null,
        counts_by_year: countsByYear,
      });
    case "publishers":
      return compact({
        ...common,
        parent_publisher: e.parent_publisher?.display_name ?? null,
        countries: e.country_codes ?? [],
        hierarchy_level: full ? e.hierarchy_level ?? null : null,
        homepage: full ? e.homepage_url ?? null : null,
        counts_by_year: countsByYear,
      });
  }
}

// ---------------------------------------------------------------------------
// Output budget
// ---------------------------------------------------------------------------

/** Rough token estimate; Claude caps tool results at 25k tokens. */
export const MAX_RESULT_CHARS = 80_000;

/**
 * Serialize a payload whose `results` array may be shrunk to fit the budget.
 * Strategy: drop abstracts first, then trim results, and say so in `truncation_note`.
 */
export function serializeWithinBudget(payload: Record<string, any>, maxChars = MAX_RESULT_CHARS): string {
  let text = JSON.stringify(payload);
  if (text.length <= maxChars) return text;

  const results: any[] | undefined = payload.results;
  if (Array.isArray(results)) {
    const noAbstracts = results.map((r) => {
      if (r && typeof r === "object" && "abstract" in r) {
        const { abstract, ...rest } = r;
        return rest;
      }
      return r;
    });
    let p2 = { ...payload, results: noAbstracts, truncation_note: "Abstracts omitted to fit the response size limit; use get_work for a full record." };
    text = JSON.stringify(p2);
    if (text.length <= maxChars) return text;
    while (noAbstracts.length > 1 && text.length > maxChars) {
      noAbstracts.pop();
      p2 = { ...p2, results: noAbstracts, truncation_note: `Response trimmed to ${noAbstracts.length} results to fit the size limit; request fewer results per page or use paging.` };
      text = JSON.stringify(p2);
    }
    return text;
  }
  return text.slice(0, maxChars);
}
