/**
 * OQL calculations (oxjob #1537, on #1530's pipeline engine): calculate_works runs a pipeline query
 * (`get works where ...; then group those works by ...; then calculate ...`) and returns the calculated groups,
 * the summary and the price; check_oql runs the API's free check (validity, every limit with its fix,
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

/** Pointer to the pipeline sections of the OQL reference (help.openalex.org/access/oql/, appended to the server instructions), plus what only these tools add. */
export const PIPELINE_GUIDE = `Calculations: write the pipeline form from the OQL reference below (The shape, Splitting into groups, Calculating) and run it with calculate_works. Check a new query with check_oql first (free: each limit with its fix, the time, the price), fix it from the message, then run it. Resolve names to IDs with search_entities first.
Sorting and top N are not in OQL: calculate_works' sort orders a page by a column. To list authors, sources or institutions by their own fields (h-index, 2-year mean citedness), start from them and stop: get authors where last known institution is (I136199984) and h-index > (50).`;

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
        "The full guide is the OQL reference in the server instructions (read_docs topic oql). Check a new query with check_oql first (free: limits with fixes, time estimate, price). " +
        "Returns one row per group, keyed by the OQL words of each calculation (count, mean FWCI, ...), nested splits under groups, the summary (summary.all for the whole starting set; with two or more splits, summary.splits with each split's groups on their own, computed from the works: read these, never sum or average group rows), groups_count and next_page, the price, the canonical OQL and a reproduce_url. " +
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
