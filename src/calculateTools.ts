/**
 * OQL calculations (oxjob #1537, on #1530's pipeline engine): calculate_works runs a pipeline query
 * (`get works where ...; then group those works by ...; then calculate ...`) and returns the calculated groups,
 * the total row and the price; check_oql runs the API's free check (validity, every limit with its fix,
 * the time estimate, the price).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { OpenAlexClient, ListResponse } from "./openalex";
import { compact, shapeEntity, type EntityKind } from "./shape";
import { prepareOql, oqlHasGroupBy, oqlHasCalculate, oqlHasSample, splitOqlSteps, queryEcho } from "./oql";
import { shapeCalculation, calculationResult, shapeCheck } from "./calculate";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export interface CalculateDeps {
  client: OpenAlexClient;
  run: (tool: string, body: () => Promise<ToolResult>) => () => Promise<ToolResult>;
  ok: (payload: Record<string, any>) => ToolResult;
  fail: (message: string) => ToolResult;
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

/** The pipeline language for models, condensed from #1530's one-page guide (work/oql_guide_rung1.md). Goes into the server instructions. */
export const PIPELINE_GUIDE = `Calculations (calculate_works, check_oql) use OQL's pipeline form: steps joined by "; then", each doing one thing.
- Start: get works where <conditions> (same conditions as any OQL query).
- Split: then group those works by <field> (year, type, open access status, language, country, institution, institution type, author, source, source type, publisher, funder, topic, subfield, field, domain, keyword, SDG, license, or a yes/no field). Split again with then group those works again by <field>; up to 3 splits.
- Split by named values: group those works by institution in (I63966007, I97018004, I136199984): one group each, in that order, empty ones included (up to 100).
- Split by searches: group those works by title-abstract search in (("machine learning"), ("edge AI" NOT cloud)) (up to 100; at most 5 AND/OR/NOT each).
- Split by conditions, to compare sets: group those works into ((institution is (I99464096)), (country is (BE))); periods too: into ((year >= (2016) and year <= (2019)), (year >= (2021))).
- Bins: group those works into citation count bins at (1, 10, 100) gives 0, 1-9, 10-99, 100+; into FWCI bins of (0.5) gives equal widths. A decimal (FWCI) can only be split into bins.
- Filter the groups with where: by author where count of those works > (10) and h-index > (20) (a calculation tests each group's works; any other field belongs to the group itself; put a count filter first or the query may be too slow); that author is not in (col_abc123); co-author is not (A5023888391) on author groups, collaborator is not (I63966007) on institution groups.
- Calculate, always last: then calculate count, mean FWCI, median citation count, sum APC paid, min date, max date, percent open access, percent of those works (each group's share of the set it came from). After a split by entities, a field of the groups themselves sits beside each group: group those works by author; then calculate count, h-index. A field of the works always needs a calculation (mean authors count, never authors count).
- Every grouped result has a total row for the whole starting set, with the same calculations and inner splits. Start from the widest set you want to compare against (the world, a country) and don't add an "everything else" group: the total row is the baseline.
- Not in the language yet: sorting or top N (rows come back by count; calculate_works' sort orders a page by a column), walking to related things (each author of those works), whole queries inside in (...). To list things with their own fields (journals by 2-year mean citedness, authors by h-index), start from those things and stop: get authors where last known institution is (I136199984) and h-index > (50).
- Values go in parentheses; entities by OpenAlex ID (resolve names with search_entities first), countries by two-letter code, types by slug. Write every value out, no "...".
- Limits: 3 splits; 100 items in a list, search list or condition split; 10,000 groups per nested split (one split pages through any number); about 10 seconds a query. A query over a limit fails with a message naming the limit and the fix.
- check_oql is free: check a new calculation first, fix it from the message, then run it with calculate_works.
Examples:
- MIT's papers by open access status: get works where institution is (I63966007); then group those works by open access status; then calculate count, mean FWCI
- KU Leuven and Belgium against the world since 2016, by SDG: get works where year >= (2016); then group those works into ((institution is (I99464096)), (country is (BE))); then group those works again by SDG; then calculate count, percent of those works
- Kelp authors with more than 10 kelp papers and an h-index above 20: get works where title-abstract has (kelp); then group those works by author where count of those works > (10) and h-index > (20); then calculate count, mean FWCI
- CRISPR's headline numbers: get works where topic is (T10878); then calculate count, mean FWCI, percent open access, median citation count`;

const LIST_KINDS: EntityKind[] = ["authors", "institutions", "sources", "topics", "funders", "publishers"];

export function registerCalculateTools(server: McpServer, deps: CalculateDeps): void {
  const { client, run, fail } = deps;

  server.registerTool(
    "calculate_works",
    {
      title: "Calculate over works (OQL pipeline)",
      description:
        "Run an OQL calculation and get the calculated groups: split a set of works by one to three fields, named values, searches, conditions or bins, and calculate count, mean/median/sum/min/max of a number, percent of a yes/no field, or each group's share. " +
        "Write it as a pipeline: get works where <conditions>; then group those works by <field>; then calculate <measures>, e.g. " +
        "get works where topic is (T10878); then group those works by institution in (I63966007, I97018004, I136199984); then calculate count, mean FWCI, percent open access. " +
        "The full pipeline guide is in the server instructions. Check a new query with check_oql first (free: limits with fixes, time estimate, price). " +
        "Returns one row per group, keyed by the OQL words of each calculation (count, mean FWCI, ...), nested splits under groups, the total row for the whole starting set, groups_count and next_page, the price, the canonical OQL and a reproduce_url. " +
        "A query with no split or calculation gets then calculate count; a query that starts from authors, institutions, sources, topics, funders or publishers with no split lists them with their own fields. Retracted works are left out unless include_retracted=true or the query says otherwise.",
      inputSchema: {
        oql: z.string().max(20000).describe("A pipeline OQL query, e.g. get works where country is (KE) and year >= (2015); then group those works by year; then calculate percent open access."),
        limit: z.number().int().min(1).max(200).optional().describe("Groups per page (the outer split), 1-200. Default 50. Groups come back by count."),
        page: z.number().int().min(1).max(200).optional().describe("Page of groups. Default 1."),
        sort: z.string().max(100).optional().describe("Order this page's rows by a calculated column, e.g. \"mean FWCI\" (descending). OQL itself has no sort; the API picks each page's groups by count."),
        include_retracted: z.boolean().optional().describe("Include retracted works. Default false."),
      },
      annotations: { title: "Calculate over works", ...READ_ONLY },
    },
    async (args) =>
      run("calculate_works", async () => {
        const prep = prepareOql(args.oql, !!args.include_retracted);
        let q = prep.oql;
        const limit = args.limit ?? 50;
        const page = args.page ?? 1;
        const steps = splitOqlSteps(q);
        const start = steps[0]!.match(/^(?:get\s+)?(\w+)/i)?.[1]?.toLowerCase() ?? "works";
        const bare = steps.length === 1 && !oqlHasGroupBy(q) && !oqlHasSample(q);
        if (start !== "works" && bare) {
          const kind = start as EntityKind;
          if (!LIST_KINDS.includes(kind)) return fail(`calculate_works lists ${LIST_KINDS.join(", ")} with their own fields; "${start}" isn't one of them.`);
          const data = await client.post<ListResponse>({ oql: q, per_page: limit, page });
          return deps.ok(compact({
            ...queryEcho(data), total_results: data.meta.count,
            page, next_page: page * limit < (data.meta.count ?? 0) ? page + 1 : null,
            results: data.results.map((e: any) => shapeEntity(kind, e)),
          }));
        }
        if (bare && !oqlHasCalculate(q)) q = `${q}; then calculate count`;
        const data = await client.post<ListResponse>({ oql: q, per_page: limit, page });
        return calculationResult(compact({
          retracted_works: start === "works" ? prep.retractedWorks : undefined,
          ...shapeCalculation(data, { page, sortBy: args.sort ?? prep.sort.by, ascending: args.sort ? false : prep.sort.ascending }),
        }));
      })()
  );

  server.registerTool(
    "check_oql",
    {
      title: "Check an OQL query (free)",
      description:
        "Free check of any OQL query before running it, the calculation pipelines above all: whether it is valid, every problem with its fix (a parse error, a fourth split, too many groups, too slow), the time estimate against the ~10-second budget, the price in credits and USD, and the canonical text with each entity's name in brackets so you can confirm the IDs mean what you think. " +
        "The query is checked as calculate_works would run it (retracted works left out unless include_retracted=true). When it is not valid, apply the fix and check again.",
      inputSchema: {
        oql: z.string().max(6000).describe("The OQL query to check."),
        include_retracted: z.boolean().optional().describe("Check it with retracted works included. Default false, as the tools run it."),
      },
      annotations: { title: "Check an OQL query", ...READ_ONLY },
    },
    async (args) =>
      run("check_oql", async () => {
        const prep = prepareOql(args.oql, !!args.include_retracted);
        const body = await client.checkOql(prep.oql);
        return deps.ok(compact({
          ...shapeCheck(body),
          checked_oql: prep.oql,
          retracted_works: prep.retractedWorks,
          sort_note: prep.sort.stripped ? "OQL has no sort; the trailing sort was removed (calculate_works' sort orders a page of rows by a calculated column)." : undefined,
          cost_of_this_check: "free",
        }));
      })()
  );
}
