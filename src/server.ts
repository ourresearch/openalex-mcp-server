/**
 * Builds the MCP server and registers the OpenAlex tools.
 * One server instance is created per request (stateless Streamable HTTP), bound to an API key.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { OpenAlexClient, OpenAlexError, type ListResponse } from "./openalex";
import { normalizeWorkId, normalizeEntityId, shortId, type EntityType } from "./ids";
import { shapeWork, shapeEntity, serializeWithinBudget, compact } from "./shape";
import {
  workFilterShape, buildWorkFilter, assertSemanticCompatible, GROUP_BY_FIELDS, type GroupByKey,
} from "./filters";

export const SERVER_NAME = "openalex";
export const SERVER_VERSION = "0.1.0";

export const SERVER_INSTRUCTIONS = `OpenAlex is a free, open index of the world's scholarly research: 250M+ works (papers, books, datasets, preprints) with citations, 100M+ author profiles, and every journal, institution, funder and topic they connect to. Data is CC0.

Tool guide:
- search_works: find papers by keyword (Boolean supported) or by meaning (mode="semantic", best for descriptive queries). Filter by year, type, open access, citations, author/institution/source/topic IDs. Sort by relevance, citations or date.
- get_work: full record for one paper by OpenAlex ID, DOI, or PMID (full author list, abstract, topics, funding). Free.
- list_citations: papers that cite a work, or the papers it references.
- search_entities: resolve a name to an OpenAlex ID (authors, institutions, sources/journals, topics, funders, publishers). Names are ambiguous, so resolve first and then filter works by ID.
- get_entity: full profile for an author, institution, source, topic, funder or publisher. Free.
- group_works: count works by author, institution, country, source, year, topic, etc. Answers "who publishes most on X", "how has X grown", "which journals". Cheap and fast.

IDs: works W…, authors A…, sources S…, institutions I…, topics T…, funders F…, publishers P…. Any tool accepts the bare ID or the https://openalex.org/… URL. Link to works with the openalex_url field or https://doi.org/<doi>.`;

export interface ServerContext {
  client: OpenAlexClient;
  /** Called after each tool call for metrics. */
  onToolCall?: (info: { tool: string; ok: boolean; ms: number; credits: number; status?: number }) => void;
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const ok = (payload: Record<string, any>): ToolResult => ({
  content: [{ type: "text", text: serializeWithinBudget(payload) }],
});
const fail = (message: string): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify({ error: message }) }],
  isError: true,
});

const SEARCH_IN = ["title_and_abstract", "fulltext", "title"] as const;
type SearchIn = (typeof SEARCH_IN)[number];

/**
 * Translate (query, mode, search_in) into OpenAlex params. Keyword/exact searches scoped to
 * title+abstract or title travel as filters (title_and_abstract.search:…); full-text and
 * semantic searches use the top-level search params.
 * Returns extra filter clauses and extra query params.
 */
function searchParams(query: string | undefined, mode: "keyword" | "semantic" | "exact", searchIn: SearchIn) {
  const filters: string[] = [];
  const params: Record<string, string> = {};
  if (!query) return { filters, params };
  if (mode === "semantic") {
    params["search.semantic"] = query;
  } else if (searchIn === "fulltext") {
    params[mode === "exact" ? "search.exact" : "search"] = query;
  } else {
    // Commas delimit filters in the OpenAlex filter syntax, so they can't appear inside a value.
    const q = query.replace(/,/g, " ").replace(/\s+/g, " ").trim();
    const field = searchIn === "title" ? "title.search" : "title_and_abstract.search";
    filters.push(`${field}${mode === "exact" ? ".exact" : ""}:${q}`);
  }
  return { filters, params };
}

const searchInSchema = z.enum(SEARCH_IN).optional().describe(
  "Where keyword/exact queries match. title_and_abstract (default) is precise and best for topic searches; fulltext also matches the body text of ~100M works (broader, more noise; large reviews that merely mention a term will rank high); title matches titles only. Ignored for semantic mode."
);

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

const pagingInfo = (meta: ListResponse["meta"], returned: number) => {
  const page = meta.page ?? 1;
  const perPage = meta.per_page ?? returned;
  const hasMore = page * perPage < (meta.count ?? 0) && page * perPage < 10_000;
  return { total_results: meta.count ?? 0, page, returned, next_page: hasMore ? page + 1 : null };
};

export function createServer(ctx: ServerContext): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION, title: "OpenAlex" },
    { instructions: SERVER_INSTRUCTIONS, capabilities: { tools: {} } }
  );
  const { client } = ctx;

  /** Wrap a tool body with timing, error mapping and metrics. */
  const run = (tool: string, body: () => Promise<ToolResult>) => async (): Promise<ToolResult> => {
    const t0 = Date.now();
    const before = client.creditsUsed;
    let status: number | undefined;
    let result: ToolResult;
    try {
      result = await body();
    } catch (e: any) {
      if (e instanceof OpenAlexError) status = e.status;
      result = fail(e?.message ?? String(e));
    }
    ctx.onToolCall?.({ tool, ok: !result.isError, ms: Date.now() - t0, credits: client.creditsUsed - before, status });
    return result;
  };

  // -------------------------------------------------------------------------
  // search_works
  // -------------------------------------------------------------------------
  server.registerTool(
    "search_works",
    {
      title: "Search works",
      description:
        "Search OpenAlex for scholarly works (papers, preprints, books, datasets). " +
        "mode=\"keyword\" (default) matches title, abstract and full text and supports Boolean syntax: AND, OR, NOT, \"quoted phrases\", parentheses. " +
        "mode=\"semantic\" matches by meaning and is best for descriptive or long queries (up to 2,000 characters; max 50 results; no min_citations/countries filters). " +
        "mode=\"exact\" matches words without stemming. " +
        "Omit query to list works by filters alone (e.g. everything by an author or institution). " +
        "Returns compact records: title, year, authors (first 5), venue, citations, FWCI, open-access link, primary topic, truncated abstract. Use get_work for a full record.",
      inputSchema: {
        query: z.string().max(2000).optional().describe("Search text. Keyword mode supports Boolean operators."),
        mode: z.enum(["keyword", "semantic", "exact"]).optional().describe("Search mode. Default keyword."),
        search_in: searchInSchema,
        sort: z.enum(["relevance", "cited_by_count", "publication_date", "fwci"]).optional()
          .describe("Sort order. Default: relevance when there is a query, otherwise cited_by_count. Always descending."),
        limit: z.number().int().min(1).max(50).optional().describe("Results per page, 1-50. Default 15."),
        page: z.number().int().min(1).max(200).optional().describe("Page number for paging through more results. Default 1."),
        include_abstracts: z.boolean().optional().describe("Include a truncated abstract per result. Default true."),
        ...workFilterShape,
      },
      annotations: { title: "Search works", ...READ_ONLY },
    },
    async (args) =>
      run("search_works", async () => {
        const mode = args.mode ?? "keyword";
        const query = args.query?.trim();
        if (!query && mode === "semantic") return fail("Semantic search needs a query.");
        if (mode === "semantic") assertSemanticCompatible(args);
        const limit = Math.min(args.limit ?? 15, 50);
        const sp = searchParams(query, mode, args.search_in ?? "title_and_abstract");
        const filter = buildWorkFilter(args, sp.filters);
        if (!query && !filter) return fail("Provide a query or at least one filter.");

        const sortKey = args.sort ?? (query ? "relevance" : "cited_by_count");
        const sort = sortKey === "relevance" ? (query ? "relevance_score:desc" : "cited_by_count:desc") : `${sortKey}:desc`;

        const params: Record<string, any> = {
          ...sp.params,
          filter,
          per_page: limit,
          page: args.page ?? 1,
          select: [
            "id", "doi", "display_name", "publication_year", "type", "authorships", "primary_location",
            "open_access", "cited_by_count", "fwci", "primary_topic", "is_retracted", "relevance_score",
            ...(args.include_abstracts === false ? [] : ["abstract_inverted_index"]),
          ].join(","),
        };
        // Semantic search ignores sort other than relevance; keep others out to avoid a 400.
        if (!(mode === "semantic" && sortKey === "relevance")) params.sort = sort;

        const data = await client.get<ListResponse>("/works", params);
        const results = data.results.map((w) =>
          shapeWork(w, { abstractChars: args.include_abstracts === false ? 0 : 500 })
        );
        return ok(compact({
          ...pagingInfo(data.meta, results.length),
          query: query ?? null,
          mode: query ? mode : null,
          search_in: query && mode !== "semantic" ? args.search_in ?? "title_and_abstract" : null,
          filter: filter ?? null,
          sort,
          results,
        }));
      })()
  );

  // -------------------------------------------------------------------------
  // get_work
  // -------------------------------------------------------------------------
  server.registerTool(
    "get_work",
    {
      title: "Get work",
      description:
        "Fetch the full record for one scholarly work by OpenAlex ID (W2741809807), DOI (10.7717/peerj.4375 or a doi.org URL), PMID, or PMCID. " +
        "Returns all authors with affiliations and ORCIDs, the full abstract, venue, open-access links, topics, keywords, funding, citation counts by year, and related works.",
      inputSchema: {
        id: z.string().min(1).max(300).describe("OpenAlex work ID, DOI, PMID, or PMCID."),
      },
      annotations: { title: "Get work", ...READ_ONLY },
    },
    async ({ id }) =>
      run("get_work", async () => {
        const w = await client.get("/works/" + encodeURIComponent(normalizeWorkId(id)).replace(/%2F/g, "/"));
        return ok(shapeWork(w, { full: true }) as Record<string, any>);
      })()
  );

  // -------------------------------------------------------------------------
  // list_citations
  // -------------------------------------------------------------------------
  server.registerTool(
    "list_citations",
    {
      title: "List citations",
      description:
        "List the works that cite a given work (direction=\"citing\", the default), or the works it references (direction=\"references\"). " +
        "Useful for tracing influence, finding follow-up studies, or reading a paper's bibliography. Supports the same year/type/open-access filters as search_works.",
      inputSchema: {
        work_id: z.string().min(1).max(300).describe("OpenAlex work ID or DOI of the anchor work."),
        direction: z.enum(["citing", "references"]).optional().describe("citing = works that cite it (default); references = works it cites."),
        sort: z.enum(["cited_by_count", "publication_date"]).optional().describe("Default cited_by_count (descending)."),
        limit: z.number().int().min(1).max(50).optional().describe("Results per page, 1-50. Default 15."),
        page: z.number().int().min(1).max(200).optional().describe("Page number. Default 1."),
        include_abstracts: z.boolean().optional().describe("Include a truncated abstract per result. Default false."),
        ...workFilterShape,
      },
      annotations: { title: "List citations", ...READ_ONLY },
    },
    async (args) =>
      run("list_citations", async () => {
        // Resolve DOIs etc. to a W-id first (free singleton call) so the filter is valid.
        let wid = shortId(args.work_id);
        if (!wid || !/^W\d+$/.test(wid)) {
          const w = await client.get("/works/" + encodeURIComponent(normalizeWorkId(args.work_id)).replace(/%2F/g, "/"), { select: "id" });
          wid = shortId(w.id)!;
        }
        const direction = args.direction ?? "citing";
        const filter = buildWorkFilter(args, [direction === "citing" ? `cites:${wid}` : `cited_by:${wid}`]);
        const data = await client.get<ListResponse>("/works", {
          filter,
          sort: `${args.sort ?? "cited_by_count"}:desc`,
          per_page: args.limit ?? 15,
          page: args.page ?? 1,
          select: [
            "id", "doi", "display_name", "publication_year", "type", "authorships", "primary_location",
            "open_access", "cited_by_count", "fwci", "primary_topic", "is_retracted",
            ...(args.include_abstracts ? ["abstract_inverted_index"] : []),
          ].join(","),
        });
        const results = data.results.map((w) => shapeWork(w, { abstractChars: args.include_abstracts ? 400 : 0 }));
        return ok(compact({
          work_id: wid,
          direction,
          ...pagingInfo(data.meta, results.length),
          results,
        }));
      })()
  );

  // -------------------------------------------------------------------------
  // search_entities
  // -------------------------------------------------------------------------
  const entityEnum = z.enum(["authors", "institutions", "sources", "topics", "funders", "publishers"]);

  server.registerTool(
    "search_entities",
    {
      title: "Search authors, institutions, sources, topics, funders, publishers",
      description:
        "Find OpenAlex entities by name and get their IDs plus a short profile: authors (researchers), institutions (universities, labs), sources (journals, conferences, repositories), topics (research areas), funders, or publishers. " +
        "Use this to resolve a name to an ID before filtering works by author_ids, institution_ids, source_ids, etc. " +
        "Author results include current institutions, h-index and top topics so the right person can be picked when names collide.",
      inputSchema: {
        entity_type: entityEnum.describe("Which kind of entity to search."),
        query: z.string().min(1).max(500).describe("Name or partial name, e.g. \"Jennifer Doudna\", \"MIT\", \"Nature Communications\", \"CRISPR\"."),
        limit: z.number().int().min(1).max(25).optional().describe("Max results, 1-25. Default 10."),
        country: z.string().length(2).optional().describe("Restrict institutions/funders/sources to an ISO country code (e.g. \"DE\")."),
      },
      annotations: { title: "Search entities", ...READ_ONLY },
    },
    async (args) =>
      run("search_entities", async () => {
        const kind = args.entity_type as EntityType;
        const filters: string[] = [];
        if (args.country) {
          if (kind === "authors") filters.push(`last_known_institutions.country_code:${args.country.toUpperCase()}`);
          else if (kind === "publishers") filters.push(`country_codes:${args.country.toUpperCase()}`);
          else if (kind !== "topics") filters.push(`country_code:${args.country.toUpperCase()}`);
        }
        const data = await client.get<ListResponse>(`/${kind}`, {
          search: args.query,
          per_page: args.limit ?? 10,
          filter: filters.length ? filters.join(",") : undefined,
        });
        const results = data.results.map((e) => shapeEntity(kind, e));
        return ok({ entity_type: kind, query: args.query, total_results: data.meta.count, results });
      })()
  );

  // -------------------------------------------------------------------------
  // get_entity
  // -------------------------------------------------------------------------
  server.registerTool(
    "get_entity",
    {
      title: "Get author, institution, source, topic, funder or publisher",
      description:
        "Fetch the full profile of one non-work entity by OpenAlex ID, or by ORCID (authors), ROR (institutions), or ISSN (sources). " +
        "Includes works and citation counts, h-index, works/citations by year, top topics, affiliation history (authors), and identifiers.",
      inputSchema: {
        entity_type: entityEnum.describe("Which kind of entity the ID refers to."),
        id: z.string().min(1).max(300).describe("OpenAlex ID (A5067184382, I27837315, S137773608, T10102, F…, P…), ORCID, ROR, or ISSN."),
      },
      annotations: { title: "Get entity", ...READ_ONLY },
    },
    async (args) =>
      run("get_entity", async () => {
        const kind = args.entity_type as EntityType;
        const path = `/${kind}/` + encodeURIComponent(normalizeEntityId(kind, args.id)).replace(/%2F/g, "/").replace(/%3A/g, ":");
        const e = await client.get(path);
        return ok(shapeEntity(kind, e, true) as Record<string, any>);
      })()
  );

  // -------------------------------------------------------------------------
  // group_works
  // -------------------------------------------------------------------------
  server.registerTool(
    "group_works",
    {
      title: "Count works by author, institution, year, topic, etc.",
      description:
        "Aggregate works matching a query and/or filters, counting them by one dimension: author, institution, country, source (journal), publisher, funder, year, type, topic, subfield, field, domain, keyword, oa_status, is_oa, language, or sdg. " +
        "Answers questions like \"who are the top authors on X\", \"which institutions publish most on Y\", \"how has research on Z grown per year\", \"which journals carry the most papers on W\". " +
        "Returns each group's ID, display name and work count, sorted by count. Accepts the same query modes and filters as search_works.",
      inputSchema: {
        group_by: z.enum(Object.keys(GROUP_BY_FIELDS) as [GroupByKey, ...GroupByKey[]]).describe("Dimension to count by."),
        query: z.string().max(2000).optional().describe("Optional search text (same as search_works)."),
        mode: z.enum(["keyword", "semantic", "exact"]).optional().describe("Search mode for query. Default keyword."),
        search_in: searchInSchema,
        limit: z.number().int().min(1).max(200).optional().describe("Max groups to return, 1-200. Default 25."),
        ...workFilterShape,
      },
      annotations: { title: "Group works", ...READ_ONLY },
    },
    async (args) =>
      run("group_works", async () => {
        const mode = args.mode ?? "keyword";
        const query = args.query?.trim();
        if (mode === "semantic") {
          if (!query) return fail("Semantic mode needs a query.");
          assertSemanticCompatible(args);
        }
        const sp = searchParams(query, mode, args.search_in ?? "title_and_abstract");
        const filter = buildWorkFilter(args, sp.filters);
        const field = GROUP_BY_FIELDS[args.group_by as GroupByKey];
        const params: Record<string, any> = { ...sp.params, filter, group_by: field, per_page: args.limit ?? 25 };
        const data = await client.get<ListResponse>("/works", params);
        const groups = (data.group_by ?? []).map((g) =>
          compact({
            id: /^https?:\/\/openalex\.org\//i.test(g.key) ? shortId(g.key) : g.key,
            name: g.key_display_name ?? g.key,
            count: g.count,
          })
        );
        // Year groups come back sorted by count; chronological is more useful.
        if (args.group_by === "year") groups.sort((a: any, b: any) => Number(a.id) - Number(b.id));
        return ok(compact({
          group_by: args.group_by,
          query: query ?? null,
          filter: filter ?? null,
          total_works: data.meta.count,
          groups_returned: groups.length,
          groups,
        }));
      })()
  );

  return server;
}
