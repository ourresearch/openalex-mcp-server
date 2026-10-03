/**
 * In-process exercise of calculate_works, check_oql and the pipeline paths of search_works / group_works (oxjob #1537).
 * Usage: npx tsx --import ./scripts/md-loader.mjs scripts/local-calculate.ts  (OPENALEX_ORG_API_KEY, else OPENALEX_API_KEY)
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server";
import { OpenAlexClient } from "../src/openalex";

const key = (process.env.OPENALEX_ORG_API_KEY ?? process.env.OPENALEX_API_KEY)!;
const server = createServer({ client: new OpenAlexClient({ apiKey: key }) });
const [ct, st] = InMemoryTransport.createLinkedPair();
await server.connect(st);
const client = new Client({ name: "local", version: "0" });
await client.connect(ct);
const call = async (name: string, args: Record<string, any>) => {
  const t0 = Date.now();
  const r: any = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? "";
  console.log(`\n=== ${name} ${JSON.stringify(args)} (${Date.now() - t0} ms, ~${Math.round(text.length / 4)} tok)${r.isError ? " ERROR" : ""}`);
  console.log(text.length > 2500 ? text.slice(0, 2500) + " …" : text);
  if (r.content?.[1]) console.log("[2nd block]", r.content[1].text);
};

const CRISPR = "get works where topic is (T10878); then group those works by institution in (I63966007, I97018004, I136199984); then calculate count, mean FWCI, percent open access";
await call("calculate_works", { oql: CRISPR });
await call("check_oql", { oql: CRISPR });
await call("check_oql", { oql: "get works where topic is (T10878); then group those works by year; then group those works again by type; then group those works again by country; then group those works again by language; then calculate count" });
await call("check_oql", { oql: "get works where topic is (T10878); then group those works by FWCI; then calculate count" });
await call("check_oql", { oql: "works where title has (kelp)" });
await call("calculate_works", { oql: "get works where year >= (2016) and country is (KE); then group those works into ((institution is (I99464096)), (country is (BE))); then group those works again by type; then calculate count, percent of those works" });
await call("calculate_works", { oql: "get works where title-abstract has (kelp); then group those works by author where count of those works > (10) and h-index > (20); then calculate count, mean FWCI, h-index", limit: 5, sort: "mean FWCI" });
await call("calculate_works", { oql: "get works where topic is (T10878); then calculate count, mean FWCI, percent open access, median citation count" });
await call("calculate_works", { oql: "get works where topic is (T10878); then group those works by institution; then calculate count, mean FWCI", limit: 3, page: 2 });
await call("calculate_works", { oql: "get authors where last known institution is (I136199984) and h-index > (50)", limit: 3 });
await call("calculate_works", { oql: "get works where year >= (2000); then group those works by author; then group those works again by year; then calculate count" });
await call("calculate_works", { oql: "get works where topic is (T10878)" });
await call("search_works", { oql: CRISPR });
await call("search_works", { oql: "get works where title has (kelp) and year >= (2024)", preview: true, preview_limit: 3 });
await call("search_works", { oql: "get works where title has (kelp) and year >= (2024)", preview: true, preview_limit: 3, preview_sample: "random" });
await call("group_works", { oql: "get works where topic is (T10878); then calculate count, mean FWCI", group_by: "oa_status" });
await call("group_works", { oql: "get works where topic is (T10878)", group_by: "year", limit: 3 });
// what agents paste back after the API's launch flip (every echo in the pipeline form; preview with ?oql_style=pipeline)
await call("search_works", { oql: "get works where title has (kelp) and retracted is (false)", preview: true, preview_limit: 2 });
await call("search_works", { oql: "get works where title has (kelp)", preview: true, preview_limit: 2, preview_sample: "random" });
await call("group_works", { oql: "get works where title has (kelp);\nthen group those works by year", group_by: "year", limit: 3 });
await call("calculate_works", { oql: "get works where title has (kelp) and year >= (2020);\nthen group those works by year", limit: 3 });
// today's queries, unchanged
await call("search_works", { oql: "works where title has (kelp)", preview: true, preview_limit: 2 });
await call("group_works", { oql: "works where title has (kelp)", group_by: "year", limit: 3 });
await client.close();
