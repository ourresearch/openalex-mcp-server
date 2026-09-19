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
  ["search_works", { query: "CRISPR off-target effects", from_year: 2020, sort: "cited_by_count", limit: 5 }, (r) => { if (!r.results?.length) throw new Error("no results"); if (!r.oql) throw new Error("no oql echo"); if (!r.results.some((w: any) => w.abstract)) throw new Error("no abstracts at all"); if (!/crispr|cas9|off-target/i.test(r.results[0].title)) throw new Error("top result off-topic: " + r.results[0].title); }],
  ["search_works", { query: "CRISPR off-target effects", search_in: "fulltext", from_year: 2020, sort: "cited_by_count", limit: 3 }, (r) => { if (!r.results?.length) throw new Error("no results"); }],
  ["search_works", { query: '(CRISPR OR Cas9) AND "off-target", base editors', from_year: 2020, limit: 3 }, (r) => { if (!r.results?.length) throw new Error("no results"); }],
  ["search_works", { query: "methods to reduce unintended edits by CRISPR-Cas9 nucleases", mode: "semantic", from_year: 2020, limit: 5 }, (r) => { if (!r.results?.length) throw new Error("no results"); }],
  ["search_works", { author_ids: ["A5067184382"], from_year: 2023, limit: 3 }, (r) => { if (!r.results?.length) throw new Error("no results"); }],
  ["search_works", { query: "x", mode: "semantic", min_citations: 5 }, (r) => { if (!r.error) throw new Error("expected error"); }],
  ["search_works", { oql: 'works where title/abstract has (("open access" or "freely available") and (citation or cited) and (advantage or increases)) and year >= (2004) and retracted is (false)', preview: true }, (r) => { if (!r.preview || !r.total_results || !r.oql || !r.reproduce_url || r.results.length !== 10 || r.results[0].abstract) throw new Error("bad preview " + JSON.stringify(r).slice(0, 200)); }],
  ["search_works", { oql: 'title/abstract has ("open access" and citation) and year >= (2010)', preview: true, preview_sample: "random", preview_limit: 5 }, (r) => { if (!r.preview || r.results.length !== 5 || !/random/.test(r.sample_basis)) throw new Error("bad random preview " + r.sample_basis); }],
  ["search_works", { oql: 'works where title/abstract has ("open access" and "citation advantage") and abstract has (not pediatric)', limit: 5 }, (r) => { if (!r.results?.length || !r.results[0].abstract || !r.oql) throw new Error("bad oql run"); }],
  ["search_works", { oql: "works where title contains (cancer)" }, (r) => { if (!r.error || !/renamed|has/.test(r.error)) throw new Error("expected OQL validation error, got " + r.error); }],
  ["search_works", { oql: "works where year is (2020)", from_year: 2019 }, (r) => { if (!r.error) throw new Error("expected exclusivity error"); }],
  ["search_works", { oqo: { get_rows: "works", filter_rows: [{ column_id: "title_and_abstract.search", value: "crispr off-target", operator: "has" }, { column_id: "publication_year", value: 2019, operator: ">" }] }, limit: 3 }, (r) => { if (!r.results?.length || !r.oql) throw new Error("bad oqo run"); }],
  ["search_works", { query: "CRISPR off-target effects", from_year: 2020, preview: true, preview_limit: 3 }, (r) => { if (!r.preview || r.results.length !== 3 || !r.oql) throw new Error("bad structured preview"); }],
  ["group_works", { group_by: "institution", oql: 'title/abstract has ((vaping or "vape*" or "electronic cigarette*") and ("adolescen*" or youth)) and year >= (2018)', limit: 5 }, (r) => { if (!r.groups?.length || !r.oql || !/group by institution/.test(r.oql)) throw new Error("bad oql group " + r.oql); }],
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
  ["group_works", { group_by: "institution", query: "symbiotic associations in marine and freshwater habitats and their ecological and evolutionary roles", mode: "semantic", limit: 5 }, (r) => { if (!r.groups?.length || !r.basis) throw new Error("no semantic groups"); }],
  ["group_works", { group_by: "top_10_percent", institution_ids: ["I27837315"], from_year: 2024, to_year: 2024 }, (r) => { if (!r.groups?.length) throw new Error("no groups"); }],
  ["list_citations", { work_id: "W2741809807", direction: "related", limit: 3 }, (r) => { if (!r.results?.length) throw new Error("no related"); }],
  ["search_entities", { entity_type: "authors", institution_ids: ["I27837315"], topic_ids: ["T10102"], sort: "works_count", limit: 5 }, (r) => { if (!r.results?.length) throw new Error("no results"); }],
  ["search_entities", { entity_type: "sources", topic_ids: ["T10102"], is_oa: true, max_apc_usd: 0, limit: 5 }, (r) => { if (!r.results?.length) throw new Error("no results"); }],
  ["search_entities", { entity_type: "institutions", country: "AU", type: "company", min_works_count: 100, limit: 5 }, (r) => { if (!r.results?.length) throw new Error("no results"); }],
  ["search_entities", { entity_type: "topics", country: "US", query: "x" }, (r) => { if (!r.error) throw new Error("expected error"); }],
  ["analyze_works", { institution_ids: ["I185261750"], from_year: 2024, to_year: 2024, top_n: 5 }, (r) => { if (!r.total_works || !r.open_access || !r.citation_impact || !r.top_fields?.length || !r.collaboration) throw new Error("incomplete profile " + Object.keys(r)); }],
  ["analyze_works", { query: "perovskite solar cells", from_year: 2015, sections: ["by_year", "top_institutions"], top_n: 5 }, (r) => { if (!r.by_year?.length || !r.top_institutions?.length || r.top_fields) throw new Error("sections wrong"); }],
  ["resolve_references", { references: [
    "10.7717/peerj.4375",
    "Piwowar et al. (2018) The state of OA. PeerJ",
    "Piwowar, H., Priem, J., Larivière, V., et al. (2018). The state of OA: a large-scale analysis of the prevalence and impact of Open Access articles. PeerJ, 6, e4375.",
    "Lazzarotto CR et al. CHANGE-seq reveals genetic and epigenetic effects on CRISPR-Cas9 genome-wide activity. Nat Biotechnol. 2020",
    "Smith, J. (2021). Quantum entanglement of kelp forests and municipal bond yields: a randomized trial. Journal of Imaginary Results, 12(3), 45-67.",
    "10.9999/definitely-not-real",
  ] }, (r) => {
    const m = r.results.map((x: any) => x.match);
    if (m[0] !== "exact" || !["exact","likely"].includes(m[1]) || m[2] !== "exact" || !["exact","likely"].includes(m[3]) || m[4] !== "none" || m[5] !== "none") throw new Error("unexpected matches " + JSON.stringify(m));
  }],
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
