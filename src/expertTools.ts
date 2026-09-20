/**
 * find_experts (oxjob #1274): ranked researchers on a topic, with evidence, in one call.
 * Three to five OpenAlex calls on the user's key: a works census grouped by author, an
 * evidence sample, a recency census, one batch profile lookup, and optional coauthor passes.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { OpenAlexClient, type ListResponse } from "./openalex";
import { shortId, idList } from "./ids";
import { compact, openalexUrl } from "./shape";
import { workFilterShape, buildWorkFilter, assertSemanticCompatible, type WorkFilterArgs } from "./filters";
import { normalizeOql } from "./oql";
import {
  countAuthors, candidatesFromGroups, attributeEvidence, coauthorIds, currentlyAt, affiliatedWith, currentCountry,
  topicWorks, rankExperts, round3, oqlWhereClause, oqlWithYearFloor, type Candidate, type ExpertSort,
} from "./experts";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
type Mode = "keyword" | "semantic" | "exact";
type SearchIn = "title_and_abstract" | "fulltext" | "title";

export interface ExpertDeps {
  client: OpenAlexClient;
  run: (tool: string, body: () => Promise<ToolResult>) => () => Promise<ToolResult>;
  ok: (payload: Record<string, any>) => ToolResult;
  fail: (message: string) => ToolResult;
  searchParams: (query: string | undefined, mode: Mode, searchIn: SearchIn) => { filters: string[]; params: Record<string, string> };
  queryEcho: (data: ListResponse) => Record<string, any>;
  modeSchema: z.ZodOptional<z.ZodEnum<any>>;
  searchInSchema: z.ZodOptional<z.ZodEnum<any>>;
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

const SAMPLE_SELECT = "id,doi,display_name,publication_year,cited_by_count,authorships";
const AUTHOR_SELECT = "id,display_name,orcid,works_count,cited_by_count,summary_stats,last_known_institutions,affiliations,topics";
const GROUP_PAGE = 200;
const SAMPLE_SIZE = 100;
const SEMANTIC_SIZE = 50;
const BATCH = 50;

/** The subset of the shared works filters that make sense for an expert census. */
const { from_year, to_year, types, topic_ids, institution_ids, funder_ids, language, core_sources_only, include_retracted, raw_filter } = workFilterShape;
const expertFilterShape = { from_year, to_year, types, topic_ids, institution_ids, funder_ids, language, core_sources_only, include_retracted, raw_filter };

export const FIND_EXPERTS_DESCRIPTION =
  "Find the researchers who work most on a topic, optionally at an institution or in a country, ranked with evidence: " +
  "how many matching works, how many in the last few years, h-index, current institution, topic share, and up to five matching titles each. " +
  "Use it for expert finding, reviewer and panel search (exclude_coauthors_of + exclude_institution_ids for conflicts), collaborator search (institution_ids), " +
  "and \"who at my university works on X\" (institution_ids with institution_scope=\"current\"). " +
  "Describe the topic as a Boolean keyword query (AND, OR, NOT, \"quoted phrases\", wildcards*): the census then covers every matching work in OpenAlex. " +
  "Turn a descriptive paragraph into synonyms grouped with OR and concepts joined with AND rather than using semantic mode, which sees only the 50 most relevant works. " +
  "Topic IDs (topic_ids) are coarse; text is usually better. Pass an OQL selection in `oql` for full control. " +
  "One call replaces the search_entities / group_works / get_entity chain and costs three to five API requests.";

export function registerExpertTools(server: McpServer, deps: ExpertDeps) {
  const { client, run, ok, fail, searchParams, queryEcho } = deps;

  server.registerTool(
    "find_experts",
    {
      title: "Find experts on a topic",
      description: FIND_EXPERTS_DESCRIPTION,
      inputSchema: {
        query: z.string().max(2000).optional().describe("The topic as search text. Keyword mode supports Boolean syntax; prefer a rich Boolean query over a plain phrase (e.g. (CRISPR OR Cas9 OR \"base editor*\") AND (\"off-target\" OR specificity))."),
        mode: deps.modeSchema.describe("keyword (default; Boolean; whole corpus) | exact (no stemming) | semantic (by meaning; only the 50 most relevant works are seen, so counts are partial)."),
        search_in: deps.searchInSchema,
        oql: z.string().max(20000).optional().describe("A works selection in OQL (any where-clause, no group by / sort by / sample). Mutually exclusive with query, mode, search_in and the works filters; institution_ids and topic_ids go inside the OQL then. institution_scope, country and the exclusions still apply."),
        institution_scope: z.enum(["current", "any_affiliation"]).optional().describe("With institution_ids: current (default) keeps only people whose current institution is inside the given institutions (their lineage); any_affiliation keeps anyone who has ever been affiliated there, including people who have since moved."),
        country: z.string().length(2).optional().describe("ISO-3166 alpha-2 code: keep only people whose current institution is in this country."),
        recent_years: z.number().int().min(1).max(10).optional().describe("Window for recent_matching_works and the recent sort, in calendar years including this one. Default 3."),
        exclude_author_ids: z.array(z.string()).optional().describe("Author IDs to drop (the applicant, the person asking, already-chosen panelists)."),
        exclude_institution_ids: z.array(z.string()).optional().describe("Drop people whose current institution is inside these (conflict of interest, \"not from our own university\")."),
        exclude_coauthors_of: z.array(z.string()).max(10).optional().describe("Author IDs: drop anyone who coauthored with any of them within recent_years (reviewer conflicts). One extra API call per ID."),
        min_matching_works: z.number().int().min(1).optional().describe("Fewer matching works than this and a person is a one-off coauthor, not an expert. Default 2; lower it for very narrow topics."),
        sort: z.enum(["matching_works", "recent", "citations", "h_index"]).optional().describe("matching_works (default): most matching works, citations as tiebreak. recent: most matching works within recent_years (rising researchers, active reviewers). citations: citations to their matching works in the evidence sample. h_index: overall standing."),
        limit: z.number().int().min(1).max(50).optional().describe("How many experts to return. Default 10."),
        ...expertFilterShape,
      },
      annotations: { title: "Find experts", ...READ_ONLY },
    },
    async (args) =>
      run("find_experts", async () => {
        const limit = args.limit ?? 10;
        const sort: ExpertSort = args.sort ?? "matching_works";
        const recentYears = args.recent_years ?? 3;
        const recentFloor = new Date().getUTCFullYear() - recentYears + 1;
        const minWorks = args.min_matching_works ?? 2;
        const scope = args.institution_scope ?? "current";
        const country = args.country?.toUpperCase();
        const instIds = new Set(idList(args.institution_ids));
        const exclAuthors = new Set(idList(args.exclude_author_ids));
        const exclInst = new Set(idList(args.exclude_institution_ids));
        const anchors = idList(args.exclude_coauthors_of);
        const topicIds = new Set(idList(args.topic_ids));
        const notes: string[] = [];

        // ---- Census: candidates, evidence sample, recency counts ----------------------------
        let candidates: Candidate[];
        let sample: any[];
        let recentByAuthor: Map<string, number> | null = null;
        let basis: string;
        let echo: Record<string, any> = {};
        let totalWorks: number;
        let filterUsed: string | null = null;
        const sampleSort = sort === "recent" ? "publication_date:desc" : "cited_by_count:desc";

        if (args.oql !== undefined) {
          const used = ["query", "mode", "search_in", ...Object.keys(expertFilterShape)].filter((k) => (args as any)[k] !== undefined);
          if (used.length) return fail(`oql is a complete selection; put year, type, institution and other filters inside it instead of using: ${used.join(", ")}.`);
          const q = normalizeOql(args.oql);
          const parsed = oqlWhereClause(q);
          if ("error" in parsed) return fail(parsed.error);
          const [groups, sampleData, recent] = await Promise.all([
            client.post<ListResponse>({ oql: `${q} group by author`, per_page: GROUP_PAGE }),
            client.post<ListResponse>({ oql: q, per_page: SAMPLE_SIZE, sort: sampleSort, select: SAMPLE_SELECT }),
            client.post<ListResponse>({ oql: `${oqlWithYearFloor(parsed.clause, recentFloor)} group by author`, per_page: GROUP_PAGE }),
          ]);
          candidates = candidatesFromGroups(groups.group_by ?? []);
          sample = sampleData.results;
          recentByAuthor = new Map(candidatesFromGroups(recent.group_by ?? []).map((c) => [c.id, c.matching_works]));
          totalWorks = groups.meta.count ?? 0;
          echo = queryEcho(sampleData);
          basis = `the ${candidates.length} most frequent authors across ${totalWorks.toLocaleString("en-US")} matching works`;
        } else {
          const mode: Mode = (args.mode as Mode) ?? "keyword";
          const query = args.query?.trim();
          const filterArgs = args as unknown as WorkFilterArgs;
          if (mode === "semantic") {
            if (!query) return fail("Semantic mode needs a query.");
            assertSemanticCompatible(filterArgs);
            const filter = buildWorkFilter(filterArgs);
            const data = await client.get<ListResponse>("/works", { "search.semantic": query, filter, per_page: SEMANTIC_SIZE, select: SAMPLE_SELECT });
            sample = data.results;
            candidates = countAuthors(sample);
            recentByAuthor = new Map(countAuthors(sample.filter((w) => (w.publication_year ?? 0) >= recentFloor)).map((c) => [c.id, c.matching_works]));
            totalWorks = sample.length;
            filterUsed = filter;
            basis = `the authors of the ${sample.length} most semantically relevant works only (OpenAlex cannot aggregate semantic search over the full corpus)`;
            notes.push("Semantic mode sees only the top 50 works, so matching_works are partial and people outside those works are missed. For a census, rerun in keyword mode with a Boolean query built from this description.");
          } else {
            const sp = searchParams(query, mode, (args.search_in as SearchIn) ?? "title_and_abstract");
            const extra = [...sp.filters];
            if (country) extra.push(`authorships.institutions.country_code:${country}`);
            const filter = buildWorkFilter(filterArgs, extra);
            if (!query && !filter) return fail("Provide a query, an oql selection, or at least one filter (topic_ids, institution_ids, …).");
            filterUsed = filter;
            const base = { ...sp.params, filter, per_page: GROUP_PAGE, group_by: "authorships.author.id" };
            const [groups, sampleData, recent] = await Promise.all([
              client.get<ListResponse>("/works", base),
              client.get<ListResponse>("/works", { ...sp.params, filter, per_page: SAMPLE_SIZE, sort: sampleSort, select: SAMPLE_SELECT }),
              client.get<ListResponse>("/works", { ...base, filter: [filter, `publication_year:>${recentFloor - 1}`].filter(Boolean).join(",") }),
            ]);
            candidates = candidatesFromGroups(groups.group_by ?? []);
            sample = sampleData.results;
            recentByAuthor = new Map(candidatesFromGroups(recent.group_by ?? []).map((c) => [c.id, c.matching_works]));
            totalWorks = groups.meta.count ?? 0;
            echo = queryEcho(sampleData);
            basis = `the ${candidates.length} most frequent authors across ${totalWorks.toLocaleString("en-US")} matching works`;
          }
        }

        // ---- Cheap exclusions, then the candidate pool for profile lookup ------------------
        const considered = candidates.length;
        const excludedByList = candidates.filter((c) => exclAuthors.has(c.id)).length;
        const belowMin = candidates.filter((c) => !exclAuthors.has(c.id) && c.matching_works < minWorks).length;
        let pool = candidates.filter((c) => !exclAuthors.has(c.id) && c.matching_works >= minWorks);
        const narrowing = instIds.size > 0 || !!country || exclInst.size > 0 || anchors.length > 0;
        const poolSize = narrowing ? 2 * BATCH : Math.min(Math.max(limit * 3, 20), BATCH);
        pool = pool.slice(0, poolSize);
        if (excludedByList) notes.push(`${excludedByList} candidate${excludedByList === 1 ? "" : "s"} dropped by exclude_author_ids.`);
        if (belowMin) notes.push(`${belowMin} candidate${belowMin === 1 ? "" : "s"} had fewer than ${minWorks} matching works (min_matching_works).`);

        const chunks: string[][] = [];
        for (let i = 0; i < pool.length; i += BATCH) chunks.push(pool.slice(i, i + BATCH).map((c) => c.id));
        const [profilePages, coauthorSets] = await Promise.all([
          Promise.all(chunks.map((ids) => client.get<ListResponse>("/authors", { filter: `ids.openalex:${ids.join("|")}`, per_page: BATCH, select: AUTHOR_SELECT }))),
          Promise.all(anchors.map((a) => client.get<ListResponse>("/works", { filter: `authorships.author.id:${a},publication_year:>${recentFloor - 1}`, per_page: 200, select: "id,authorships" }))),
        ]);
        const profiles = new Map<string, any>();
        for (const page of profilePages) for (const a of page.results) { const id = shortId(a.id); if (id) profiles.set(id, a); }
        const conflicted = new Set<string>();
        coauthorSets.forEach((page, i) => { for (const id of coauthorIds(page.results, [anchors[i]])) conflicted.add(id); });
        for (const a of anchors) conflicted.add(a);

        // ---- Scope on the person (current institution, country, conflicts) ----------------
        const drops: Record<string, number> = {};
        const drop = (why: string) => { drops[why] = (drops[why] ?? 0) + 1; };
        const kept: Candidate[] = [];
        for (const c of pool) {
          const p = profiles.get(c.id);
          if (!p) { drop("no longer have an author profile (merged or deleted)"); continue; }
          if (instIds.size && scope === "current" && !currentlyAt(p, instIds)) { drop("not currently at the given institution(s)"); continue; }
          if (instIds.size && scope === "any_affiliation" && !affiliatedWith(p, instIds)) { drop("never affiliated with the given institution(s)"); continue; }
          if (country && currentCountry(p) !== country) { drop(`current institution not in ${country}`); continue; }
          if (exclInst.size && currentlyAt(p, exclInst)) { drop("currently at an excluded institution"); continue; }
          if (conflicted.has(c.id)) { drop(`coauthored with an exclude_coauthors_of author since ${recentFloor}`); continue; }
          kept.push(c);
        }
        for (const [why, n] of Object.entries(drops)) notes.push(`${n} candidate${n === 1 ? "" : "s"} dropped: ${why}.`);

        // ---- Evidence and ranking ------------------------------------------------------------
        const evidence = attributeEvidence(sample, kept.map((c) => c.id), 5);
        const rows = kept.map((c) => {
          const p = profiles.get(c.id);
          const ev = evidence.get(c.id);
          const worksCount: number | null = p.works_count ?? null;
          const inst = (p.last_known_institutions ?? []).map((i: any) => compact({ id: shortId(i?.id), name: i?.display_name, country: i?.country_code }));
          return {
            id: c.id,
            name: p.display_name ?? c.name,
            orcid: p.orcid ? String(p.orcid).replace(/^https?:\/\/orcid\.org\//i, "") : null,
            openalex_url: openalexUrl(c.id),
            current_institutions: inst,
            country: currentCountry(p),
            matching_works: c.matching_works,
            recent_matching_works: recentByAuthor?.get(c.id) ?? 0,
            works_count: worksCount,
            topic_share: worksCount ? round3(Math.min(1, c.matching_works / worksCount)) : null,
            works_on_given_topics: topicWorks(p, topicIds),
            h_index: p.summary_stats?.h_index ?? null,
            cited_by_count: p.cited_by_count ?? null,
            citations_in_sample: ev?.citations_in_sample ?? 0,
            latest_matching_year: ev?.latest_year ?? null,
            evidence: ev?.evidence ?? [],
            top_topics: (p.topics ?? []).slice(0, 3).map((t: any) => t?.display_name).filter(Boolean),
          };
        });
        const experts = rankExperts(rows, sort).slice(0, limit).map((r) => compact(r));
        if (experts.length < limit && kept.length < pool.length) notes.push(`Only ${experts.length} of the requested ${limit} survived the institution/country/conflict filters; the census considered the top ${pool.length} candidates. Broaden the query, use institution_scope="any_affiliation", or lower min_matching_works.`);
        if (scope === "any_affiliation" && instIds.size) notes.push("institution_scope=any_affiliation: people listed may have since moved; check current_institutions.");
        notes.push(`Evidence titles come from the ${sample.length} ${sort === "recent" ? "most recent" : "most cited"} matching works; a person's evidence can be empty when none of their matching works are in that sample.`);

        return ok(compact({
          query: args.query ?? null,
          mode: args.oql !== undefined ? null : args.mode ?? "keyword",
          basis,
          total_matching_works: totalWorks,
          filter: filterUsed,
          ...echo,
          recent_years: recentYears,
          recent_since: recentFloor,
          sort,
          candidates_considered: considered,
          profiles_checked: pool.length,
          returned: experts.length,
          experts,
          notes,
        }));
      })()
  );
}
