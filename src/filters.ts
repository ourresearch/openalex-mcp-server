/**
 * Build OpenAlex `filter=` strings from structured tool arguments.
 * Filter docs: https://help.openalex.org/api/filtering/
 */
import { z } from "zod";
import { idList } from "./ids";

export const WORK_TYPES = [
  "article", "review", "preprint", "book", "book-chapter", "dissertation", "dataset",
  "report", "editorial", "letter", "erratum", "retraction", "paratext", "libguides",
  "reference-entry", "peer-review", "standard", "supplementary-materials", "grant", "other",
] as const;

export const OA_STATUSES = ["gold", "green", "hybrid", "bronze", "diamond", "closed"] as const;

/** Shared filter fields for works. Used by search_works, group_works and list_citations. */
export const workFilterShape = {
  from_year: z.number().int().min(1000).max(2100).optional()
    .describe("Earliest publication year, inclusive (e.g. 2020)."),
  to_year: z.number().int().min(1000).max(2100).optional()
    .describe("Latest publication year, inclusive."),
  types: z.array(z.enum(WORK_TYPES)).optional()
    .describe("Only these work types (OR). Common: article, review, preprint, book-chapter, dataset."),
  open_access_only: z.boolean().optional()
    .describe("Only works with a free-to-read copy."),
  oa_status: z.array(z.enum(OA_STATUSES)).optional()
    .describe("Only these open-access statuses (OR)."),
  min_citations: z.number().int().min(0).optional()
    .describe("Minimum cited_by_count. Not supported with semantic search."),
  author_ids: z.array(z.string()).optional()
    .describe("OpenAlex author IDs (e.g. A5067184382). Resolve names with search_entities first."),
  institution_ids: z.array(z.string()).optional()
    .describe("OpenAlex institution IDs (e.g. I27837315). Matches any author's affiliation."),
  source_ids: z.array(z.string()).optional()
    .describe("OpenAlex source (journal/repository) IDs (e.g. S137773608)."),
  topic_ids: z.array(z.string()).optional()
    .describe("OpenAlex topic IDs (e.g. T10102)."),
  funder_ids: z.array(z.string()).optional()
    .describe("OpenAlex funder IDs (e.g. F4320332161)."),
  publisher_ids: z.array(z.string()).optional()
    .describe("OpenAlex publisher IDs (e.g. P4310319908)."),
  countries: z.array(z.string().length(2)).optional()
    .describe("ISO-3166 alpha-2 country codes of author institutions (OR), e.g. [\"US\",\"GB\"]. Not supported with semantic search."),
  language: z.string().length(2).optional()
    .describe("ISO-639-1 language code, e.g. \"en\"."),
  core_sources_only: z.boolean().optional()
    .describe("Only works published in 'core' sources: reputable, well-indexed journals and repositories (see https://help.openalex.org/data/sources/). Useful to exclude low-quality venues."),
  include_retracted: z.boolean().optional()
    .describe("Include retracted works. Default false: retracted works are hidden and the response says so (retracted_works). Also honoured with oql, where the default adds a `retracted is (false)` clause unless the query has its own."),
  raw_filter: z.string().max(2000).optional()
    .describe("Escape hatch: extra OpenAlex filter expression appended verbatim, using the syntax documented at https://help.openalex.org/api/filtering/ (e.g. \"has_abstract:true,primary_topic.field.id:17\"). Combined with the structured filters above using AND."),
};

export type WorkFilterArgs = z.infer<z.ZodObject<typeof workFilterShape>>;

export function joinIds(ids: string[] | undefined): string | null {
  const list = idList(ids);
  return list.length ? list.join("|") : null;
}

/** Build the comma-joined filter string. Returns null if nothing to filter. */
export function buildWorkFilter(args: WorkFilterArgs, extra: string[] = []): string | null {
  const parts: string[] = [...extra];
  const { from_year, to_year } = args;
  if (from_year !== undefined && to_year !== undefined) {
    if (from_year > to_year) throw new Error(`from_year (${from_year}) is after to_year (${to_year}).`);
    parts.push(from_year === to_year ? `publication_year:${from_year}` : `publication_year:${from_year}-${to_year}`);
  } else if (from_year !== undefined) {
    parts.push(`publication_year:>${from_year - 1}`);
  } else if (to_year !== undefined) {
    parts.push(`publication_year:<${to_year + 1}`);
  }
  if (args.types?.length) parts.push(`type:${args.types.join("|")}`);
  if (args.open_access_only) parts.push("is_oa:true");
  if (args.oa_status?.length) parts.push(`open_access.oa_status:${args.oa_status.join("|")}`);
  if (args.min_citations !== undefined && args.min_citations > 0) parts.push(`cited_by_count:>${args.min_citations - 1}`);
  const a = joinIds(args.author_ids); if (a) parts.push(`authorships.author.id:${a}`);
  const i = joinIds(args.institution_ids); if (i) parts.push(`authorships.institutions.lineage:${i}`);
  const s = joinIds(args.source_ids); if (s) parts.push(`primary_location.source.id:${s}`);
  const t = joinIds(args.topic_ids); if (t) parts.push(`topics.id:${t}`);
  const f = joinIds(args.funder_ids); if (f) parts.push(`funders.id:${f}`);
  const p = joinIds(args.publisher_ids); if (p) parts.push(`primary_location.source.host_organization_lineage:${p}`);
  if (args.countries?.length) parts.push(`authorships.institutions.country_code:${args.countries.map((c) => c.toUpperCase()).join("|")}`);
  if (args.language) parts.push(`language:${args.language.toLowerCase()}`);
  if (args.core_sources_only) parts.push("primary_location.source.is_core:true");
  if (!args.include_retracted) parts.push("is_retracted:false");
  if (args.raw_filter?.trim()) parts.push(args.raw_filter.trim());
  return parts.length ? parts.join(",") : null;
}

/** Semantic search rejects a couple of filters; fail early with a clear message. */
export function assertSemanticCompatible(args: WorkFilterArgs) {
  if (args.min_citations !== undefined && args.min_citations > 0)
    throw new Error("min_citations is not supported with semantic search. Use keyword mode, or drop the citation floor and sort afterwards.");
  if (args.countries?.length)
    throw new Error("countries is not supported with semantic search. Use keyword mode, or filter by institution_ids instead.");
}

export const GROUP_BY_FIELDS = {
  author: "authorships.author.id",
  institution: "authorships.institutions.id",
  institution_type: "authorships.institutions.type",
  country: "authorships.countries",
  source: "primary_location.source.id",
  publisher: "primary_location.source.host_organization",
  funder: "funders.id",
  year: "publication_year",
  type: "type",
  topic: "primary_topic.id",
  subfield: "primary_topic.subfield.id",
  field: "primary_topic.field.id",
  domain: "primary_topic.domain.id",
  keyword: "keywords.id",
  oa_status: "open_access.oa_status",
  is_oa: "is_oa",
  top_10_percent: "citation_normalized_percentile.is_in_top_10_percent",
  top_1_percent: "citation_normalized_percentile.is_in_top_1_percent",
  language: "language",
  sdg: "sustainable_development_goals.id",
} as const;

export type GroupByKey = keyof typeof GROUP_BY_FIELDS;

/** What the response says about retracted works (oxjob #1281). */
export const RETRACTED_EXCLUDED_NOTE = "excluded by default; set include_retracted=true to include them";
export const RETRACTED_INCLUDED_NOTE = "included; retracted rows carry is_retracted: true";
export const RETRACTED_PER_QUERY_NOTE = "as filtered by the query's own retracted clause";
export const retractedNote = (included: boolean) => (included ? RETRACTED_INCLUDED_NOTE : RETRACTED_EXCLUDED_NOTE);
