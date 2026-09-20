/** In-process exercise of find_experts on a real key. Usage: OPENALEX_API_KEY=… npx tsx --import ./scripts/md-loader.mjs scripts/local-experts.ts */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server";
import { OpenAlexClient } from "../src/openalex";

const key = process.env.OPENALEX_API_KEY!;
const server = createServer({ client: new OpenAlexClient({ apiKey: key }) });
const [ct, st] = InMemoryTransport.createLinkedPair();
await server.connect(st);
const client = new Client({ name: "local", version: "0" });
await client.connect(ct);
const call = async (args: Record<string, any>) => {
  const t0 = Date.now();
  const r: any = await client.callTool({ name: "find_experts", arguments: args });
  const text = r.content?.[0]?.text ?? "";
  let p: any; try { p = JSON.parse(text); } catch { p = text; }
  console.log(`\n=== ${JSON.stringify(args)} (${Date.now() - t0} ms, ~${Math.round(text.length / 4)} tok)${r.isError ? " ERROR" : ""}`);
  if (p.error) { console.log(p.error); return p; }
  console.log({ basis: p.basis, total_matching_works: p.total_matching_works, candidates: p.candidates_considered, returned: p.returned, notes: p.notes });
  for (const e of p.experts ?? []) console.log(` ${e.name} | ${e.current_institutions?.join("; ")} | match ${e.matching_works} recent ${e.recent_matching_works} h ${e.h_index} share ${e.topic_share} cites ${e.citations_in_sample} | ${e.evidence?.[0]?.title?.slice(0, 60)}`);
  return p;
};
await call({ query: "CRISPR off-target", institution_ids: ["I97018004"], from_year: 2021, limit: 5 });
await call({ query: "CRISPR off-target", institution_ids: ["I97018004"], from_year: 2021, limit: 5, institution_scope: "any_affiliation", sort: "recent" });
await call({ query: "Off-target effects of CRISPR-Cas9 genome editing and methods to detect and reduce them.", mode: "semantic", limit: 5 });
await call({ query: "CRISPR off-target", from_year: 2021, exclude_coauthors_of: ["A5067184382"], exclude_institution_ids: ["I95457486"], limit: 5, sort: "h_index" });
await call({ topic_ids: ["T10102"], country: "CA", limit: 5 });
await call({ oql: 'works where title/abstract has ((vaping or "e-cigarette*") and "adolescen*") and year >= (2018)', limit: 5 });
await call({ oql: "works where year is (2020)", query: "x" });
await client.close();
