/**
 * Builds the MCP server and registers the OpenAlex tools.
 * One server instance is created per request (stateless Streamable HTTP), bound to an API key.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { OpenAlexClient, OpenAlexError, type ListResponse } from "./openalex";
import { normalizeWorkId, normalizeEntityId, shortId, idList, type EntityType } from "./ids";
import { shapeWork, shapeEntity, serializeWithinBudget, compact } from "./shape";
import {
  workFilterShape, buildWorkFilter, assertSemanticCompatible, GROUP_BY_FIELDS, type GroupByKey,
} from "./filters";
import { titleCoverage, queryCoverage, extractYear, extractDoi, guessTitle, guessSurnames } from "./text";
import { normalizeOql, oqlHasSearch, oqlHasGroupBy, oqlHasSample, oneLine, reproduceUrl, OQL_GROUP_DIMS } from "./oql";

export const SERVER_NAME = "openalex";
export const SERVER_VERSION = "0.2.0";

export const SERVER_INSTRUCTIONS = `OpenAlex is a free, open index of the world's scholarly research: 250M+ works (papers, books, datasets, preprints) with citations, 100M+ author profiles, and every journal, institution, funder and topic they connect to. Data is CC0.

Tools:
- search_works: find papers. Either fill the structured parameters (query + filters) or pass an OQL query for anything complex. preview=true returns just the count and a sample so a query can be tuned cheaply before running it.
- get_work: full record for one paper by OpenAlex ID, DOI, PMID or PMCID. Free.
- resolve_references: check a list of citations (DOIs, PMIDs, or free-text references) against OpenAlex; reports whether each exists and what it matched. Use it to verify bibliographies.
- list_citations: papers citing a work, the works it references, or related works.
- search_entities: find authors, institutions, sources (journals), topics, funders or publishers by name and/or filters. Resolve names to IDs before filtering works by ID. Also the expert-finding tool: authors currently at an institution working on a topic (institution_ids + topic_ids).
- get_entity: full profile for an author, institution, source, topic, funder or publisher. Free.
- group_works: count works along one dimension (author, institution, country, source, year, topic, type, OA status…). Answers "who publishes most on X", "how has X grown", "which journals".
- analyze_works: one-call profile of any set of works (an institution's output, a funder's portfolio, a topic): totals, open-access share, top-cited share, trend by year, and top fields, topics, institutions, countries, sources, funders and authors.

Every works result includes the canonical OQL that produced it (and a reproduce_url), so users can rerun, share, or cite the exact query.

OQL in one minute (full spec: https://help.openalex.org/access/oql/):
  works where title/abstract has ((vaping or "vape*" or "electronic cigarette*") and ("adolescen*" or youth)) and year >= (2018) and type is (article or review)
- Text search: <field> has (...). Fields: title, abstract, title/abstract, full text. Bare words are stemmed; "quotes" are exact; wildcards must be quoted ("psoriat*"); within 3 ("smart", "phone") = proximity.
- Combine with and / or, nest with parentheses. Negate with not inside the parentheses: abstract has (not pediatric), (not (a or b)), country is (not FR).
- Filters: year is (2020) / year >= (2019) / year <= (2023); citation count >= (100); FWCI >= (2.0); open access is (true); retracted is (false); type is (article or review); language is (en); oa status is (gold or diamond).
- Entities take IDs, not names (resolve with search_entities first): institution is (I136199984); author is (A5067184382); source is (S137773608); topic is (T10102); funder is (F4320332161); country is (US or GB).
- Citation links: it cites (W…); it's cited by (W…); it's related to (W…).
- Semantic: title/abstract is similar to ("a sentence describing what you want").
- Aggregation: … group by author | institution | country | source | funder | year | type | topic | field | oa status.
- Field names are the OQL words above (title/abstract, year, citation count), never API column ids (title_and_abstract.search, publication_year). Every value sits in parentheses: year >= (2018), not year >= 2018.
- Sorting is not part of OQL; use the sort parameter.

Recipe for "find references for this passage" or "build a systematic search": split the passage into its claims; for each claim write an AND group of synonyms joined with or; join the groups with or (or with and if every claim must hold); add year/type/retracted filters; run with preview=true, look at the count and sample, tighten with exact phrases, extra terms or not-clauses; then run for real with sort=relevance and a larger limit. Give the user the canonical OQL with the results.

IDs: works W…, authors A…, sources S…, institutions I…, topics T…, funders F…, publishers P…. Any tool accepts the bare ID or the https://openalex.org/… URL. Link to works with openalex_url or https://doi.org/<doi>.`;

export interface ServerContext {
  client: OpenAlexClient;
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
type Mode = "keyword" | "semantic" | "exact";

/** Translate (query, mode, search_in) into OpenAlex filter clauses and query params. */
function searchParams(query: string | undefined, mode: Mode, searchIn: SearchIn) {
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
const modeSchema = z.enum(["keyword", "semantic", "exact"]).optional().describe("Search mode. Default keyword.");

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

const LIST_SELECT = [
  "id", "doi", "display_name", "publication_year", "type", "authorships", "primary_location",
  "open_access", "cited_by_count", "fwci", "primary_topic", "is_retracted", "relevance_score",
];

const pagingInfo = (meta: ListResponse["meta"], returned: number) => {
  const page = meta.page ?? 1;
  const perPage = meta.per_page ?? returned;
  const hasMore = page * perPage < (meta.count ?? 0) && page * perPage < 10_000;
  return { total_results: meta.count ?? 0, page, returned, next_page: hasMore ? page + 1 : null };
};

const groupKey = (key: string) => (/^https?:\/\/openalex\.org\//i.test(key) ? shortId(key.replace(/\/(countries|source-types|institution-types|sdgs|keywords|languages)\//, "/")) : key);

function shapeGroups(data: ListResponse) {
  return (data.group_by ?? []).map((g) =>
    compact({ id: groupKey(g.key) ?? g.key, name: g.key_display_name ?? g.key, count: g.count })
  );
}

/** Canonical OQL echo from a list response. */
const queryEcho = (data: ListResponse) => {
  const oql = oneLine((data.meta as any)?.x_query?.oql);
  return oql ? { oql, reproduce_url: reproduceUrl(oql) } : {};
};

const PREVIEW_SELECT = ["id", "doi", "display_name", "publication_year", "type", "authorships", "primary_location", "cited_by_count", "relevance_score"];

const pct = (part: number, whole: number) => (whole > 0 ? Number(((100 * part) / whole).toFixed(1)) : null);

export function createServer(ctx: ServerContext): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION, title: "OpenAlex" },
    { instructions: SERVER_INSTRUCTIONS, capabilities: { tools: {} } }
  );
  const { client } = ctx;

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

  const fetchWorkId = async (input: string): Promise<string> => {
    const wid = shortId(input);
    if (wid && /^W\d+$/.test(wid)) return wid;
    const w = await client.get("/works/" + encodeURIComponent(normalizeWorkId(input)).replace(/%2F/g, "/"), { select: "id" });
    return shortId(w.id)!;
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
        "mode=\"keyword\" (default) supports Boolean syntax: AND, OR, NOT, \"quoted phrases\", parentheses. " +
        "mode=\"semantic\" matches by meaning and is best for descriptive or long queries (up to 2,000 characters; max 50 results; no min_citations/countries filters). " +
        "mode=\"exact\" matches words without stemming. " +
        "Omit query to list works by filters alone (e.g. everything by an author, institution or funder). " +
        "For anything the structured parameters can't express (nested Boolean groups across fields, exclusions, proximity, exact phrases, wildcards) pass an OQL query in `oql` instead; the syntax is summarized in the server instructions and at https://help.openalex.org/access/oql/. " +
        "Set preview=true to get only the result count, the canonical OQL and a small sample, which is the cheap way to tune a query before running it. " +
        "Every response includes the canonical OQL and a reproduce_url. " +
        "Returns compact records: title, year, authors (first 5), venue, citations, FWCI, open-access link, primary topic, truncated abstract. Use get_work for a full record.",
      inputSchema: {
        oql: z.string().max(20000).optional().describe("An OQL query, e.g. works where title/abstract has ((vaping or \"vape*\" or \"electronic cigarette*\") and (youth or \"adolescen*\")) and year >= (2018). A bare where-clause is accepted. Mutually exclusive with query and the structured filters."),
        oqo: z.record(z.string(), z.any()).optional().describe("The same query as an OQO JSON object (schema: https://help.openalex.org/access/oqo-schema/). Alternative to oql."),
        preview: z.boolean().optional().describe("Return only total_results, canonical OQL and a sample of preview_limit works (no abstracts). Use while tuning a query."),
        preview_limit: z.number().int().min(1).max(25).optional().describe("Sample size for preview. Default 10."),
        preview_sample: z.enum(["top", "random"]).optional().describe("Preview sample: top = highest-ranked (default); random = a random draw from the whole result set, better for judging precision."),
        query: z.string().max(2000).optional().describe("Search text. Keyword mode supports Boolean operators."),
        mode: modeSchema,
        search_in: searchInSchema,
        sort: z.enum(["relevance", "cited_by_count", "publication_date", "fwci"]).optional()
          .describe("Sort order, descending. Default: relevance when there is a query, otherwise cited_by_count."),
        limit: z.number().int().min(1).max(50).optional().describe("Results per page, 1-50. Default 15."),
        page: z.number().int().min(1).max(200).optional().describe("Page number. Default 1."),
        include_abstracts: z.boolean().optional().describe("Include a truncated abstract per result. Default true."),
        ...workFilterShape,
      },
      annotations: { title: "Search works", ...READ_ONLY },
    },
    async (args) =>
      run("search_works", async () => {
        const preview = !!args.preview;
        const previewLimit = args.preview_limit ?? 10;
        const previewRandom = preview && args.preview_sample === "random";
        const structuredKeys = ["query", "mode", "search_in", "sort", "page", ...Object.keys(workFilterShape)] as const;
        const usedStructured = structuredKeys.filter((k) => (args as any)[k] !== undefined);

        // ---- OQL / OQO path ----
        if (args.oql !== undefined || args.oqo !== undefined) {
          if (args.oql !== undefined && args.oqo !== undefined) return fail("Pass either oql or oqo, not both.");
          const disallowed = usedStructured.filter((k) => k !== "sort" && k !== "page");
          if (disallowed.length) return fail(`oql/oqo is a complete query; put year, type and other filters inside it instead of using: ${disallowed.join(", ")}.`);
          const body: Record<string, any> = {};
          let hasSearch = true;
          if (args.oql !== undefined) {
            let q = normalizeOql(args.oql);
            if (previewRandom && !oqlHasSample(q) && !oqlHasGroupBy(q)) q = `${q} sample ${previewLimit}`;
            body.oql = q;
            hasSearch = oqlHasSearch(q);
          } else {
            const o = { ...(args.oqo as Record<string, any>) };
            if (!o.get_rows) o.get_rows = "works";
            if (previewRandom && !o.sample && !(o.group_by?.length)) o.sample = previewLimit;
            body.oqo = o;
            hasSearch = JSON.stringify(o).includes('"operator":"has"') || JSON.stringify(o).includes("similar");
          }
          const sortKey = args.sort ?? (hasSearch ? "relevance" : "cited_by_count");
          const sampled = previewRandom;
          if (!sampled) body.sort = sortKey === "relevance" ? (hasSearch ? "relevance_score:desc" : "cited_by_count:desc") : `${sortKey}:desc`;
          body.per_page = preview ? previewLimit : Math.min(args.limit ?? 15, 50);
          body.page = args.page ?? 1;
          body.select = (preview ? PREVIEW_SELECT : [...LIST_SELECT, ...(args.include_abstracts === false ? [] : ["abstract_inverted_index"])]).join(",");
          const data = await client.post<ListResponse>(body);
          if (data.group_by && data.group_by.length) {
            return ok(compact({ ...queryEcho(data), total_works: data.meta.count, groups: shapeGroups(data) }));
          }
          const results = data.results.map((w) => shapeWork(w, { abstractChars: preview || args.include_abstracts === false ? 0 : 500, maxAuthors: preview ? 1 : 5 }));
          return ok(compact({
            preview: preview || null,
            sample_basis: preview ? (previewRandom ? `random ${results.length} of all matches` : `top ${results.length} by ${sortKey}`) : null,
            ...queryEcho(data),
            ...pagingInfo(data.meta, results.length),
            results,
          }));
        }

        // ---- structured path ----
        const mode = args.mode ?? "keyword";
        const query = args.query?.trim();
        if (!query && mode === "semantic") return fail("Semantic search needs a query.");
        if (mode === "semantic") assertSemanticCompatible(args);
        const sp = searchParams(query, mode, args.search_in ?? "title_and_abstract");
        const filter = buildWorkFilter(args, sp.filters);
        if (!query && !filter) return fail("Provide a query, an oql query, or at least one filter.");
        const sortKey = args.sort ?? (query ? "relevance" : "cited_by_count");
        const sort = sortKey === "relevance" ? (query ? "relevance_score:desc" : "cited_by_count:desc") : `${sortKey}:desc`;
        const params: Record<string, any> = {
          ...sp.params,
          filter,
          per_page: preview ? previewLimit : Math.min(args.limit ?? 15, 50),
          page: args.page ?? 1,
          select: (preview ? PREVIEW_SELECT : [...LIST_SELECT, ...(args.include_abstracts === false ? [] : ["abstract_inverted_index"])]).join(","),
        };
        if (previewRandom && mode !== "semantic") {
          params.sample = previewLimit;
          params.seed = Math.floor(Math.random() * 1e9);
        } else if (!(mode === "semantic" && sortKey === "relevance")) {
          params.sort = sort;
        }
        const data = await client.get<ListResponse>("/works", params);
        const results = data.results.map((w) => shapeWork(w, { abstractChars: preview || args.include_abstracts === false ? 0 : 500, maxAuthors: preview ? 1 : 5 }));
        return ok(compact({
          preview: preview || null,
          sample_basis: preview ? (previewRandom ? `random ${results.length} of all matches` : `top ${results.length} by ${sortKey}`) : null,
          ...queryEcho(data),
          ...pagingInfo(data.meta, results.length),
          query: query ?? null,
          mode: query ? mode : null,
          search_in: query && mode !== "semantic" ? args.search_in ?? "title_and_abstract" : null,
          filter: filter ?? null,
          sort: previewRandom ? null : sort,
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
      inputSchema: { id: z.string().min(1).max(300).describe("OpenAlex work ID, DOI, PMID, or PMCID.") },
      annotations: { title: "Get work", ...READ_ONLY },
    },
    async ({ id }) =>
      run("get_work", async () => {
        const w = await client.get("/works/" + encodeURIComponent(normalizeWorkId(id)).replace(/%2F/g, "/"));
        return ok(shapeWork(w, { full: true }) as Record<string, any>);
      })()
  );

  // -------------------------------------------------------------------------
  // resolve_references
  // -------------------------------------------------------------------------
  server.registerTool(
    "resolve_references",
    {
      title: "Resolve references",
      description:
        "Check up to 25 references against OpenAlex in one call and report what each one matched. " +
        "Each item may be a DOI, PMID, OpenAlex ID, or a free-text citation (e.g. \"Piwowar et al. (2018) The state of OA. PeerJ\"). " +
        "IDs are looked up exactly; free-text citations are matched on title with a confidence rating (exact, likely, uncertain, none). " +
        "Use it to verify a bibliography, detect fabricated or garbled citations, fill in missing DOIs, or turn a reading list into OpenAlex IDs.",
      inputSchema: {
        references: z.array(z.string().min(3).max(600)).min(1).max(25).describe("Citations to resolve, one per item."),
      },
      annotations: { title: "Resolve references", ...READ_ONLY },
    },
    async ({ references }) =>
      run("resolve_references", async () => {
        const resolveOne = async (ref: string) => {
          const input = ref.trim();
          const doi = extractDoi(input);
          const bare = shortId(input);
          const isId = doi || (bare && /^W\d+$/.test(bare)) || /^(pmid:|pmcid:|pmc)?\d{5,9}$/i.test(input);
          if (isId) {
            try {
              const w = await client.get("/works/" + encodeURIComponent(normalizeWorkId(doi ?? input)).replace(/%2F/g, "/"), { select: LIST_SELECT.join(",") });
              return { input, match: "exact", matched_on: doi ? "doi" : "id", work: shapeWork(w) };
            } catch (e: any) {
              if (e instanceof OpenAlexError && e.status === 404) return { input, match: "none", note: "No OpenAlex work has this identifier." };
              throw e;
            }
          }
          const title = guessTitle(input).replace(/,/g, " ");
          const year = extractYear(input);
          const surnames = guessSurnames(input);
          const data = await client.get<ListResponse>("/works", {
            filter: `title.search:${title}`,
            per_page: 5,
            select: LIST_SELECT.join(","),
          });
          const scored = data.results.map((w) => {
            const precision = queryCoverage(title, w.display_name); // guessed title found in candidate
            const recall = titleCoverage(input, w.display_name); // candidate title found in citation
            const yearOk = year === null ? null : w.publication_year != null && Math.abs(w.publication_year - year) <= 1;
            const names = (w.authorships ?? []).map((a: any) => String(a?.author?.display_name ?? a?.raw_author_name ?? "").toLowerCase());
            const authorOk = surnames.length ? surnames.some((sn) => names.some((n: string) => n.includes(sn))) : null;
            const score = precision + 0.5 * recall + (yearOk ? 0.3 : 0) + (authorOk ? 0.3 : 0);
            return { w, precision, recall, yearOk, authorOk, score };
          });
          scored.sort((a, b) => b.score - a.score);
          const best = scored[0];
          if (!best) return { input, match: "none", note: "No work in OpenAlex has a similar title." };
          const corroborated = best.yearOk === true || best.authorOk === true;
          const contradicted = best.yearOk === false || best.authorOk === false;
          let match: "exact" | "likely" | "uncertain" | "none";
          if (best.precision >= 0.9 && best.recall >= 0.9 && !contradicted) match = "exact";
          else if (best.precision >= 0.85 && corroborated && !contradicted) match = "likely";
          else if (best.precision >= 0.6 && !(best.yearOk === false && best.authorOk === false)) match = "uncertain";
          else match = "none";
          return compact({
            input,
            match,
            matched_on: "title",
            title_overlap: Number(best.precision.toFixed(2)),
            year_consistent: best.yearOk,
            author_consistent: best.authorOk,
            work: match === "none" ? undefined : shapeWork(best.w),
            note: match === "none" ? "Closest title in OpenAlex is not a convincing match; the reference may be garbled or fabricated." : match === "uncertain" ? "Partial title match; check the author list and year before trusting it." : undefined,
          });
        };
        const results = await Promise.all(references.map(resolveOne));
        const counts = { exact: 0, likely: 0, uncertain: 0, none: 0 } as Record<string, number>;
        for (const r of results) counts[r.match as string] = (counts[r.match as string] ?? 0) + 1;
        return ok({ summary: counts, results });
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
        "List works connected to a given work: direction=\"citing\" (default) returns works that cite it; \"references\" returns the works it cites; \"related\" returns OpenAlex's related works (similar topic and citation neighbourhood). " +
        "Useful for tracing influence, finding follow-up studies, or reading a paper's bibliography. Supports the same year/type/open-access filters as search_works.",
      inputSchema: {
        work_id: z.string().min(1).max(300).describe("OpenAlex work ID or DOI of the anchor work."),
        direction: z.enum(["citing", "references", "related"]).optional().describe("citing (default), references, or related."),
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
        const wid = await fetchWorkId(args.work_id);
        const direction = args.direction ?? "citing";
        const anchor = direction === "citing" ? `cites:${wid}` : direction === "references" ? `cited_by:${wid}` : `related_to:${wid}`;
        const filter = buildWorkFilter(args, [anchor]);
        const data = await client.get<ListResponse>("/works", {
          filter,
          sort: `${args.sort ?? "cited_by_count"}:desc`,
          per_page: args.limit ?? 15,
          page: args.page ?? 1,
          select: [...LIST_SELECT, ...(args.include_abstracts ? ["abstract_inverted_index"] : [])].join(","),
        });
        const results = data.results.map((w) => shapeWork(w, { abstractChars: args.include_abstracts ? 400 : 0 }));
        return ok(compact({ work_id: wid, direction, ...queryEcho(data), ...pagingInfo(data.meta, results.length), results }));
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
        "Find OpenAlex entities by name and/or filters, returning IDs plus a short profile. Entity types: authors (researchers), institutions (universities, labs, companies), sources (journals, conferences, repositories), topics (research areas), funders, publishers. " +
        "Use it to resolve a name to an ID before filtering works, or as a directory. It is the right tool for expert finding: authors currently at an institution working on a topic (institution_ids + topic_ids, sort by works_count or h_index; each result reports works_in_topic), journals in a field that are open access (sources + topic_ids + is_oa), institutions of a type in a country. " +
        "Author results include current institutions, h-index and top topics so the right person can be picked when names collide.",
      inputSchema: {
        entity_type: entityEnum.describe("Which kind of entity to search."),
        query: z.string().max(500).optional().describe("Name or partial name, e.g. \"Jennifer Doudna\", \"MIT\", \"Nature Communications\", \"CRISPR\". Optional when filters are given."),
        institution_ids: z.array(z.string()).optional().describe("authors: current institution (includes child institutions). institutions: restrict to these or their children."),
        topic_ids: z.array(z.string()).optional().describe("authors/sources/institutions: only those with works in these topics (T…)."),
        country: z.string().length(2).optional().describe("ISO country code: authors (current institution), institutions, sources, funders, publishers."),
        type: z.string().max(40).optional().describe("institutions: education, healthcare, company, government, nonprofit, facility, funder, archive, other. sources: journal, repository, conference, ebook platform, book series."),
        has_orcid: z.boolean().optional().describe("authors: only profiles with an ORCID."),
        is_oa: z.boolean().optional().describe("sources: only fully open-access venues."),
        is_in_doaj: z.boolean().optional().describe("sources: only venues listed in DOAJ."),
        max_apc_usd: z.number().int().min(0).optional().describe("sources: article processing charge at most this many USD (0 = no APC)."),
        min_works_count: z.number().int().min(0).optional().describe("Minimum number of works."),
        min_h_index: z.number().int().min(0).optional().describe("authors/sources/institutions: minimum h-index."),
        sort: z.enum(["relevance", "works_count", "cited_by_count", "h_index"]).optional().describe("Default: relevance when there is a query, otherwise works_count. Descending."),
        limit: z.number().int().min(1).max(50).optional().describe("Results per page, 1-50. Default 10."),
        page: z.number().int().min(1).max(100).optional().describe("Page number. Default 1."),
        raw_filter: z.string().max(1000).optional().describe("Escape hatch: extra filter expression appended verbatim, using the syntax at https://help.openalex.org/api/filtering/ for this entity type."),
      },
      annotations: { title: "Search entities", ...READ_ONLY },
    },
    async (args) =>
      run("search_entities", async () => {
        const kind = args.entity_type as EntityType;
        const query = args.query?.trim();
        const f: string[] = [];
        const inst = idList(args.institution_ids).join("|");
        const topics = idList(args.topic_ids).join("|");
        const cc = args.country?.toUpperCase();
        if (inst) {
          if (kind === "authors") f.push(`last_known_institutions.lineage:${inst}`);
          else if (kind === "institutions") f.push(`lineage:${inst}`);
          else return fail(`institution_ids applies to authors and institutions, not ${kind}.`);
        }
        if (topics) {
          if (kind === "authors" || kind === "sources" || kind === "institutions") f.push(`topics.id:${topics}`);
          else return fail(`topic_ids applies to authors, sources and institutions, not ${kind}.`);
        }
        if (cc) {
          if (kind === "authors") f.push(`last_known_institutions.country_code:${cc}`);
          else if (kind === "publishers") f.push(`country_codes:${cc}`);
          else if (kind === "topics") return fail("country does not apply to topics.");
          else f.push(`country_code:${cc}`);
        }
        if (args.type) {
          if (kind === "institutions" || kind === "sources") f.push(`type:${args.type.trim().toLowerCase().replace(/,/g, " ")}`);
          else return fail(`type applies to institutions and sources, not ${kind}.`);
        }
        if (args.has_orcid !== undefined) {
          if (kind !== "authors") return fail("has_orcid applies to authors only.");
          f.push(`has_orcid:${args.has_orcid}`);
        }
        if (args.is_oa !== undefined) { if (kind !== "sources") return fail("is_oa applies to sources only."); f.push(`is_oa:${args.is_oa}`); }
        if (args.is_in_doaj !== undefined) { if (kind !== "sources") return fail("is_in_doaj applies to sources only."); f.push(`is_in_doaj:${args.is_in_doaj}`); }
        if (args.max_apc_usd !== undefined) { if (kind !== "sources") return fail("max_apc_usd applies to sources only."); f.push(`apc_usd:<${args.max_apc_usd + 1}`); }
        if (args.min_works_count) f.push(`works_count:>${args.min_works_count - 1}`);
        if (args.min_h_index) {
          if (kind === "topics") return fail("min_h_index does not apply to topics.");
          f.push(`summary_stats.h_index:>${args.min_h_index - 1}`);
        }
        if (args.raw_filter?.trim()) f.push(args.raw_filter.trim());
        if (!query && !f.length) return fail("Provide a query or at least one filter.");
        const sortKey = args.sort ?? (query ? "relevance" : "works_count");
        const sort = sortKey === "relevance" ? (query ? undefined : "works_count:desc") : sortKey === "h_index" ? "summary_stats.h_index:desc" : `${sortKey}:desc`;
        const data = await client.get<ListResponse>(`/${kind}`, {
          search: query || undefined,
          filter: f.length ? f.join(",") : undefined,
          sort,
          per_page: args.limit ?? 10,
          page: args.page ?? 1,
        });
        const topicIds = idList(args.topic_ids);
        const results = data.results.map((e) => shapeEntity(kind, e, false, topicIds));
        return ok(compact({ entity_type: kind, query: query ?? null, filter: f.length ? f.join(",") : null, ...queryEcho(data), ...pagingInfo(data.meta, results.length), results }));
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
  const groupByEnum = z.enum(Object.keys(GROUP_BY_FIELDS) as [GroupByKey, ...GroupByKey[]]);

  server.registerTool(
    "group_works",
    {
      title: "Count works by author, institution, year, topic, etc.",
      description:
        "Aggregate works matching a query and/or filters, counting them by one dimension: author, institution, institution_type, country, source (journal), publisher, funder, year, type, topic, subfield, field, domain, keyword, oa_status, is_oa, top_10_percent, top_1_percent, language, or sdg. " +
        "Answers \"who are the top authors on X\", \"which institutions publish most on Y\", \"how has research on Z grown per year\", \"which journals carry the most papers on W\", \"who does institution A collaborate with\" (institution_ids + group_by institution). " +
        "Returns each group's ID, display name and work count, sorted by count. Keyword/exact queries aggregate over all matching works; semantic queries aggregate over the 50 most relevant works only. " +
        "Accepts an OQL query in `oql` for complex selections (the group by is added from group_by if the query has none). " +
        "Note: group_by author over institution-filtered works also counts co-authors from other institutions; for \"researchers AT institution X on topic Y\" use search_entities with institution_ids and topic_ids instead.",
      inputSchema: {
        group_by: groupByEnum.describe("Dimension to count by."),
        oql: z.string().max(20000).optional().describe("OQL query selecting the works to count (see search_works). Mutually exclusive with query and the structured filters."),
        query: z.string().max(2000).optional().describe("Optional search text (same as search_works)."),
        mode: modeSchema,
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
        const field = GROUP_BY_FIELDS[args.group_by as GroupByKey];
        const limit = args.limit ?? 25;
        if (args.oql !== undefined) {
          const used = ["query", "mode", "search_in", ...Object.keys(workFilterShape)].filter((k) => (args as any)[k] !== undefined);
          if (used.length) return fail(`oql is a complete query; put filters inside it instead of using: ${used.join(", ")}.`);
          let q = normalizeOql(args.oql);
          if (!oqlHasGroupBy(q)) {
            const dim = OQL_GROUP_DIMS[args.group_by as string];
            if (!dim) return fail(`group_by "${args.group_by}" is not available with oql; use one of: ${Object.keys(OQL_GROUP_DIMS).join(", ")}.`);
            q = `${q} group by ${dim}`;
          }
          const data = await client.post<ListResponse>({ oql: q, per_page: limit });
          const groups = shapeGroups(data);
          if (args.group_by === "year") groups.sort((a: any, b: any) => Number(a.id) - Number(b.id));
          return ok(compact({ group_by: args.group_by, ...queryEcho(data), total_works: data.meta.count, groups_returned: groups.length, groups }));
        }
        if (mode === "semantic") {
          if (!query) return fail("Semantic mode needs a query.");
          assertSemanticCompatible(args);
          const filter = buildWorkFilter(args);
          const data = await client.get<ListResponse>("/works", {
            "search.semantic": query, filter, per_page: 50,
            select: "id,publication_year,type,language,authorships,primary_location,primary_topic,open_access,keywords,funders,sustainable_development_goals,citation_normalized_percentile",
          });
          const groups = countLocally(data.results, args.group_by as GroupByKey).slice(0, limit);
          return ok(compact({
            group_by: args.group_by, query, mode, filter: filter ?? null,
            basis: `the ${data.results.length} most semantically relevant works (OpenAlex cannot aggregate semantic search over the full corpus)`,
            total_works: data.results.length, groups_returned: groups.length, groups,
          }));
        }
        const sp = searchParams(query, mode, args.search_in ?? "title_and_abstract");
        const filter = buildWorkFilter(args, sp.filters);
        const data = await client.get<ListResponse>("/works", { ...sp.params, filter, group_by: field, per_page: limit });
        const groups = shapeGroups(data);
        if (args.group_by === "year") groups.sort((a: any, b: any) => Number(a.id) - Number(b.id));
        return ok(compact({ group_by: args.group_by, query: query ?? null, filter: filter ?? null, ...queryEcho(data), total_works: data.meta.count, groups_returned: groups.length, groups }));
      })()
  );

  // -------------------------------------------------------------------------
  // analyze_works
  // -------------------------------------------------------------------------
  const SECTIONS = ["by_year", "by_type", "open_access", "citation_impact", "top_fields", "top_topics", "top_institutions", "top_countries", "top_sources", "top_funders", "top_authors", "collaboration"] as const;
  type Section = (typeof SECTIONS)[number];

  server.registerTool(
    "analyze_works",
    {
      title: "Analyze a set of works",
      description:
        "Build a one-call profile of any set of works defined by a query and/or filters: an institution's output, a funder's portfolio, an author's career, a topic, a country, a journal. " +
        "Returns total works, open-access share by status, share of works in the top 10% and top 1% most-cited (field-normalized), counts by year and by type, and the top fields, topics, institutions, countries, sources, funders and authors, plus international and industry collaboration shares. " +
        "Use it for research-office, library, and funder reporting questions (\"summarize our 2024 research\", \"how much of NIH-funded work at UW is open access\", \"who does MIT collaborate with on AI\"). " +
        "Pick sections to keep the response small. Keyword queries only (no semantic mode). Each section costs one cheap API call.",
      inputSchema: {
        query: z.string().max(2000).optional().describe("Optional keyword search text (Boolean supported)."),
        search_in: searchInSchema,
        sections: z.array(z.enum(SECTIONS)).optional().describe("Which sections to compute. Default: all."),
        top_n: z.number().int().min(3).max(50).optional().describe("How many entries per top_* list. Default 10."),
        ...workFilterShape,
      },
      annotations: { title: "Analyze works", ...READ_ONLY },
    },
    async (args) =>
      run("analyze_works", async () => {
        const query = args.query?.trim();
        const sp = searchParams(query, "keyword", args.search_in ?? "title_and_abstract");
        const filter = buildWorkFilter(args, sp.filters);
        if (!query && !filter) return fail("Provide a query or at least one filter.");
        const want = new Set<Section>(args.sections?.length ? args.sections : [...SECTIONS]);
        const topN = args.top_n ?? 10;
        const base = { ...sp.params, filter };
        const g = (field: string, per_page: number) => client.get<ListResponse>("/works", { ...base, group_by: field, per_page });

        const jobs: Record<string, Promise<ListResponse>> = {};
        jobs.total = client.get<ListResponse>("/works", { ...base, per_page: 1, select: "id" });
        if (want.has("by_year")) jobs.year = g("publication_year", 200);
        if (want.has("by_type")) jobs.type = g("type", 20);
        if (want.has("open_access")) jobs.oa = g("open_access.oa_status", 10);
        if (want.has("citation_impact")) { jobs.top10 = g("citation_normalized_percentile.is_in_top_10_percent", 2); jobs.top1 = g("citation_normalized_percentile.is_in_top_1_percent", 2); }
        if (want.has("top_fields")) jobs.fields = g("primary_topic.field.id", topN);
        if (want.has("top_topics")) jobs.topics = g("primary_topic.id", topN);
        if (want.has("top_institutions")) jobs.institutions = g("authorships.institutions.id", topN);
        if (want.has("top_countries")) jobs.countries = g("authorships.countries", topN);
        if (want.has("top_sources")) jobs.sources = g("primary_location.source.id", topN);
        if (want.has("top_funders")) jobs.funders = g("funders.id", topN);
        if (want.has("top_authors")) jobs.authors = g("authorships.author.id", topN);
        if (want.has("collaboration")) { jobs.countriesDistinct = g("countries_distinct_count", 50); jobs.instTypes = g("authorships.institutions.type", 10); }

        const keys = Object.keys(jobs);
        const settled = await Promise.all(keys.map((k) => jobs[k]));
        const r: Record<string, ListResponse> = {};
        keys.forEach((k, i) => (r[k] = settled[i]));
        const total = r.total.meta.count ?? 0;
        const trueCount = (d?: ListResponse) => d?.group_by?.find((x) => x.key_display_name === "true" || x.key === "1" || x.key === "true")?.count ?? 0;

        const out: Record<string, any> = { query: query ?? null, filter: filter ?? null, ...queryEcho(r.total), total_works: total };
        if (r.year) out.by_year = shapeGroups(r.year).map((x: any) => ({ year: Number(x.id), works: x.count })).sort((a: any, b: any) => a.year - b.year);
        if (r.type) out.by_type = shapeGroups(r.type).map((x: any) => ({ type: x.id, works: x.count, share_pct: pct(x.count, total) }));
        if (r.oa) {
          const oaGroups = shapeGroups(r.oa);
          const oaWorks = oaGroups.filter((x: any) => x.id !== "closed").reduce((s: number, x: any) => s + x.count, 0);
          out.open_access = { oa_works: oaWorks, oa_share_pct: pct(oaWorks, total), by_status: oaGroups.map((x: any) => ({ status: x.id, works: x.count, share_pct: pct(x.count, total) })) };
        }
        if (r.top10) {
          const t10 = trueCount(r.top10), t1 = trueCount(r.top1);
          out.citation_impact = {
            works_in_top_10_percent: t10, top_10_percent_share_pct: pct(t10, total),
            works_in_top_1_percent: t1, top_1_percent_share_pct: pct(t1, total),
            note: "Field-normalized citation percentiles; a random set of works would have ~10% and ~1%.",
          };
        }
        const top = (d?: ListResponse) => d ? shapeGroups(d).map((x: any) => ({ ...x, share_pct: pct(x.count, total) })) : undefined;
        if (r.fields) out.top_fields = top(r.fields);
        if (r.topics) out.top_topics = top(r.topics);
        if (r.institutions) out.top_institutions = top(r.institutions);
        if (r.countries) out.top_countries = top(r.countries);
        if (r.sources) out.top_sources = top(r.sources);
        if (r.funders) out.top_funders = top(r.funders);
        if (r.authors) out.top_authors = top(r.authors);
        if (r.countriesDistinct) {
          const intl = (r.countriesDistinct.group_by ?? []).filter((x) => Number(x.key) >= 2).reduce((s, x) => s + x.count, 0);
          const company = (r.instTypes.group_by ?? []).find((x) => x.key === "company")?.count ?? 0;
          out.collaboration = {
            international_works: intl, international_share_pct: pct(intl, total),
            works_with_company_coauthor: company, company_share_pct: pct(company, total),
            by_institution_type: shapeGroups(r.instTypes).map((x: any) => ({ type: x.id, works: x.count })),
          };
        }
        out.api_calls = keys.length;
        return ok(compact(out));
      })()
  );

  return server;
}

/** Count top-50 semantic results locally along a group_by dimension. */
function countLocally(works: any[], dim: GroupByKey) {
  const counts = new Map<string, { id: string; name: string; count: number }>();
  const add = (id: string | null | undefined, name: string | null | undefined) => {
    if (!id) return;
    const key = shortId(id) ?? id;
    const cur = counts.get(key) ?? { id: key, name: name ?? key, count: 0 };
    cur.count++;
    counts.set(key, cur);
  };
  for (const w of works) {
    const seen = new Set<string>();
    const once = (id: any, name: any) => { const k = String(id); if (!seen.has(k)) { seen.add(k); add(id, name); } };
    switch (dim) {
      case "author": for (const a of w.authorships ?? []) once(a?.author?.id, a?.author?.display_name); break;
      case "institution": for (const a of w.authorships ?? []) for (const i of a?.institutions ?? []) once(i?.id, i?.display_name); break;
      case "institution_type": for (const a of w.authorships ?? []) for (const i of a?.institutions ?? []) once(i?.type, i?.type); break;
      case "country": for (const a of w.authorships ?? []) for (const c of a?.countries ?? []) once(c, c); break;
      case "source": once(w.primary_location?.source?.id, w.primary_location?.source?.display_name); break;
      case "publisher": once(w.primary_location?.source?.host_organization, w.primary_location?.source?.host_organization_name); break;
      case "funder": for (const f of w.funders ?? []) once(f?.id, f?.display_name); break;
      case "year": once(w.publication_year, String(w.publication_year)); break;
      case "type": once(w.type, w.type); break;
      case "topic": once(w.primary_topic?.id, w.primary_topic?.display_name); break;
      case "subfield": once(w.primary_topic?.subfield?.id, w.primary_topic?.subfield?.display_name); break;
      case "field": once(w.primary_topic?.field?.id, w.primary_topic?.field?.display_name); break;
      case "domain": once(w.primary_topic?.domain?.id, w.primary_topic?.domain?.display_name); break;
      case "keyword": for (const k of w.keywords ?? []) once(k?.id, k?.display_name); break;
      case "oa_status": once(w.open_access?.oa_status, w.open_access?.oa_status); break;
      case "is_oa": once(String(w.open_access?.is_oa), String(w.open_access?.is_oa)); break;
      case "top_10_percent": once(String(!!w.citation_normalized_percentile?.is_in_top_10_percent), String(!!w.citation_normalized_percentile?.is_in_top_10_percent)); break;
      case "top_1_percent": once(String(!!w.citation_normalized_percentile?.is_in_top_1_percent), String(!!w.citation_normalized_percentile?.is_in_top_1_percent)); break;
      case "language": once(w.language, w.language); break;
      case "sdg": for (const s of w.sustainable_development_goals ?? []) once(s?.id, s?.display_name); break;
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count);
}
