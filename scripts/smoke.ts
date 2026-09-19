/**
 * Live smoke test: connects to a running server and exercises every tool.
 * Usage: MCP_URL=http://localhost:8788/mcp npx tsx scripts/smoke.ts
 *        OPENALEX_API_KEY=... to test bring-your-own-key.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.env.MCP_URL ?? "http://localhost:8788/mcp";
const key = process.env.SMOKE_BYOK_KEY;

const transport = new StreamableHTTPClientTransport(new URL(url), key ? { requestInit: { headers: { Authorization: `Bearer ${key}` } } } : undefined);
const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`connected to ${url}; ${tools.length} tools`);
let failures = 0;
for (const t of tools) {
  const problems: string[] = [];
  if (!t.title && !t.annotations?.title) problems.push("missing title");
  if (t.annotations?.readOnlyHint !== true && t.annotations?.destructiveHint === undefined) problems.push("missing readOnlyHint/destructiveHint");
  if (t.name.length > 64) problems.push("name > 64 chars");
  console.log(`  - ${t.name}${problems.length ? "  !! " + problems.join(", ") : ""}`);
  failures += problems.length;
}

const calls: Array<[string, Record<string, any>, (r: any) => void]> = [
  ["search_works", { query: "CRISPR off-target effects", from_year: 2020, sort: "cited_by_count", limit: 5 }, (r) => { if (!r.results?.length) throw new Error("no results"); if (!r.results.some((w: any) => w.abstract)) throw new Error("no abstracts at all"); if (!/crispr|cas9|off-target/i.test(r.results[0].title)) throw new Error("top result off-topic: " + r.results[0].title); }],
  ["search_works", { query: "CRISPR off-target effects", search_in: "fulltext", from_year: 2020, sort: "cited_by_count", limit: 3 }, (r) => { if (!r.results?.length) throw new Error("no results"); }],
  ["search_works", { query: '(CRISPR OR Cas9) AND "off-target", base editors', from_year: 2020, limit: 3 }, (r) => { if (!r.results?.length) throw new Error("no results"); }],
  ["search_works", { query: "methods to reduce unintended edits by CRISPR-Cas9 nucleases", mode: "semantic", from_year: 2020, limit: 5 }, (r) => { if (!r.results?.length) throw new Error("no results"); }],
  ["search_works", { author_ids: ["A5067184382"], from_year: 2023, limit: 3 }, (r) => { if (!r.results?.length) throw new Error("no results"); }],
  ["search_works", { query: "x", mode: "semantic", min_citations: 5 }, (r) => { if (!r.error) throw new Error("expected error"); }],
  ["get_work", { id: "10.7717/peerj.4375" }, (r) => { if (r.id !== "W2741809807") throw new Error("wrong work " + r.id); if (!r.abstract) throw new Error("no abstract"); }],
  ["get_work", { id: "10.9999/does-not-exist" }, (r) => { if (!r.error) throw new Error("expected error"); }],
  ["list_citations", { work_id: "W2741809807", limit: 3 }, (r) => { if (!r.results?.length) throw new Error("no results"); }],
  ["list_citations", { work_id: "10.7717/peerj.4375", direction: "references", limit: 3 }, (r) => { if (!r.results?.length) throw new Error("no results"); }],
  ["search_entities", { entity_type: "authors", query: "Jennifer Doudna", limit: 3 }, (r) => { if (r.results?.[0]?.id !== "A5067184382") throw new Error("unexpected top author " + JSON.stringify(r.results?.[0])); }],
  ["search_entities", { entity_type: "institutions", query: "MIT", limit: 3 }, (r) => { if (!r.results?.length) throw new Error("no results"); }],
  ["search_entities", { entity_type: "sources", query: "Nature Communications", limit: 3 }, (r) => { if (!r.results?.length) throw new Error("no results"); }],
  ["search_entities", { entity_type: "topics", query: "CRISPR", limit: 3 }, (r) => { if (!r.results?.length) throw new Error("no results"); }],
  ["get_entity", { entity_type: "authors", id: "A5067184382" }, (r) => { if (!r.h_index) throw new Error("no h_index"); }],
  ["get_entity", { entity_type: "institutions", id: "https://ror.org/042nb2s44" }, (r) => { if (!r.name) throw new Error("no name"); }],
  ["get_entity", { entity_type: "sources", id: "0028-0836" }, (r) => { if (r.name !== "Nature") throw new Error("expected Nature, got " + r.name); }],
  ["group_works", { group_by: "author", query: "CRISPR off-target", from_year: 2020, limit: 10 }, (r) => { if (!r.groups?.length || !r.groups[0].name) throw new Error("no groups"); }],
  ["group_works", { group_by: "year", query: "CRISPR off-target", from_year: 2015 }, (r) => { if (!r.groups?.length) throw new Error("no groups"); }],
  ["group_works", { group_by: "institution", topic_ids: ["T10102"], limit: 5 }, (r) => { if (!r.groups?.length) throw new Error("no groups"); }],
];

for (const [name, args, check] of calls) {
  const t0 = Date.now();
  try {
    const res: any = await client.callTool({ name, arguments: args });
    const text = res.content?.[0]?.text ?? "";
    const parsed = JSON.parse(text);
    check(parsed);
    const approxTokens = Math.round(text.length / 4);
    console.log(`ok   ${name} ${JSON.stringify(args).slice(0, 70)}  ${Date.now() - t0}ms ~${approxTokens} tok${parsed.error ? " (expected error: " + parsed.error.slice(0, 60) + ")" : ""}`);
  } catch (e: any) {
    failures++;
    console.log(`FAIL ${name} ${JSON.stringify(args).slice(0, 70)}: ${e?.message ?? e}`);
  }
}
await client.close();
console.log(failures ? `\n${failures} failure(s)` : "\nall good");
process.exit(failures ? 1 : 0);
