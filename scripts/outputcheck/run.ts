/**
 * Tool-output check (oxjob #1885): runs the real tools on fixed sets and compares each answer with the raw API record.
 *
 * In process (this checkout's code, production API):
 *   SMOKE_USER_API_KEY=<key> npx tsx --import ./scripts/md-loader.mjs scripts/outputcheck/run.ts [set ...]
 * Live server (real OAuth, like smoke.ts):
 *   MCP_URL=https://mcp.openalex.org/mcp SMOKE_USER_API_KEY=<key> npx tsx scripts/outputcheck/run.ts [set ...]
 * Sets (default: all):
 *   bigauthors  get_work on the 50 most-cited works with > 400 authors + LIGO and Gaia DR2: the result parses as JSON and
 *               carries the abstract (when the API has one) and oa_status
 *   cby         get_work on 50 works (2 examples + 48 random, seed 1885): citations_by_year equals the API's counts_by_year
 *               year for year, and citation_percentile equals the API's value
 *   topics      30 random topics (seed 1857), works from 2023: search_works, group_works and analyze_works with topic_ids
 *               and calculate_works "in the topic" give one count
 * Fixtures were built by oxjob #1885's work/build_fixtures.py (2026-10-26).
 */
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { oauthLogin } from "../oauth-login";
import { OpenAlexClient } from "../../src/openalex";
import { workPath } from "../../src/ids";

const dir = new URL(".", import.meta.url).pathname;
const load = (f: string) => JSON.parse(readFileSync(dir + f, "utf8"));

const url = process.env.MCP_URL;
// In process any API key will do; live, the key stands in for a user's consent click (OAuth).
const key = process.env.SMOKE_USER_API_KEY ?? (url ? undefined : process.env.OPENALEX_API_KEY);
if (!key) { console.error("SMOKE_USER_API_KEY is required"); process.exit(2); }
const apiKey = process.env.OPENALEX_API_KEY ?? key;
const client = new Client({ name: "outputcheck", version: "0.0.0" });
if (!url) {
  const { createServer } = await import("../../src/server");
  const { UsersApiClient } = await import("../../src/users");
  const server = createServer({
    client: new OpenAlexClient({ apiKey: key }),
    users: new UsersApiClient({ apiKey: key, baseUrl: "https://user.openalex.org" }),
    features: { findExperts: false, keywordSearch: true, alertTools: false },
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  console.log("in process");
} else {
  const login = await oauthLogin({ mcpUrl: url, usersApiBase: process.env.USERS_API_BASE ?? "https://user.openalex.org", userApiKey: key });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${login.accessToken}` } } }));
  console.log("live", url);
}

const truth = new OpenAlexClient({ apiKey });   // raw API reads, the truth side
const api = (path: string, params: Record<string, string> = {}) => truth.get<any>(path, params);

/** Call a tool; returns the raw text and, when it parses, the JSON. Retries a tool error twice. */
async function call(name: string, args: Record<string, any>): Promise<{ text: string; json?: any; isError?: boolean }> {
  for (let attempt = 0; ; attempt++) {
    const res: any = await client.callTool({ name, arguments: args });
    const text: string = res.content?.[0]?.text ?? "";
    let json: any;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    if (!res.isError || attempt >= 2) return { text, json, isError: res.isError };
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function bigauthors() {
  const fx = load("bigauthors.json");
  const ids: string[] = [...fx.examples, ...fx.top50.map((r: any) => r.id)];
  let pass = 0, parsed = 0, maxChars = 0;
  const fails: string[] = [];
  for (const id of ids) {
    const [raw, r] = await Promise.all([api(workPath(id), { select: "id,abstract_inverted_index,open_access,authorships" }), call("get_work", { id })]);
    maxChars = Math.max(maxChars, r.text.length);
    const j = r.json;
    if (j) parsed++;
    const needAbstract = !!raw.abstract_inverted_index;
    const nAuthors = raw.authorships?.length ?? 0;
    const problems: string[] = [];
    if (!j) problems.push(`not JSON (${r.text.length} chars)`);
    else {
      if (needAbstract && !j.abstract) problems.push("abstract missing");
      if (!j.oa_status) problems.push("oa_status missing");
      const total = j.authors_total ?? j.authors?.length;
      if (total !== nAuthors) problems.push(`authors_total ${total} vs API ${nAuthors}`);
    }
    if (problems.length) fails.push(`${id}: ${problems.join("; ")}`);
    else pass++;
  }
  console.log(`bigauthors: ${pass}/${ids.length} pass (valid JSON ${parsed}/${ids.length}); largest result ${maxChars} chars`);
  for (const f of fails.slice(0, 10)) console.log("   ", f);
  return { set: "bigauthors", pass, n: ids.length, parsed, maxChars };
}

async function cby() {
  const ids: string[] = load("cby.json");
  let yearsOk = 0, pctOk = 0, sumOk = 0, sumApplies = 0;
  const fails: string[] = [];
  for (const id of ids) {
    const [raw, r] = await Promise.all([
      api(workPath(id), { select: "id,cited_by_count,counts_by_year,citation_normalized_percentile,publication_year" }),
      call("get_work", { id }),
    ]);
    const j = r.json ?? {};
    const apiYears = new Map<number, number>((raw.counts_by_year ?? []).map((c: any) => [c.year, c.cited_by_count]));
    const conn = new Map<number, number>((j.citations_by_year ?? []).map((c: any) => [c.year, c.citations]));
    const same = apiYears.size === conn.size && [...apiYears].every(([y, n]) => conn.get(y) === n);
    if (same) yearsOk++;
    else fails.push(`${id}: years ${[...conn.keys()].sort().join(",")} vs API ${[...apiYears.keys()].sort().join(",")}`);
    // The years sum to cited_by_count when the API's own years do (every citing year inside the API's window).
    const apiSum = [...apiYears.values()].reduce((s, n) => s + n, 0);
    if (apiSum === raw.cited_by_count) {
      sumApplies++;
      if ([...conn.values()].reduce((s, n) => s + n, 0) === raw.cited_by_count) sumOk++;
    }
    const want = raw.citation_normalized_percentile?.value;
    const got = j.citation_percentile;
    if ((want == null && got == null) || (typeof want === "number" && typeof got === "number" && Math.abs(want - got) < 1e-9)) pctOk++;
    else fails.push(`${id}: citation_percentile ${got} vs API ${want}`);
  }
  console.log(`cby: years equal to the API ${yearsOk}/${ids.length}; sum = cited_by_count ${sumOk}/${sumApplies} (works whose API years sum to it); percentile equal ${pctOk}/${ids.length}`);
  for (const f of fails.slice(0, 10)) console.log("   ", f);
  return { set: "cby", yearsOk, n: ids.length, sumOk, sumApplies, pctOk };
}

const numberFrom = (j: any): number | undefined =>
  j?.total_results ?? j?.total_works ?? j?.summary?.all?.count ?? j?.groups?.[0]?.count;

async function topics() {
  const list: Array<{ id: string; name: string }> = load("topics30.json");
  let agree = 0, anyOk = 0;
  const rows: string[] = [];
  const year = { from_year: 2023, to_year: 2023 };
  for (const t of list) {
    const [s, g, a, c, anyRes, primary, any] = await Promise.all([
      call("search_works", { topic_ids: [t.id], ...year, limit: 1, include_abstracts: false }),
      call("group_works", { group_by: "year", topic_ids: [t.id], ...year }),
      call("analyze_works", { topic_ids: [t.id], ...year, sections: ["by_type"] }),
      call("calculate_works", { oql: `get works from 2023 in the topic (${t.id})` }),
      call("search_works", { any_topic_ids: [t.id], ...year, limit: 1, include_abstracts: false }),
      api("works", { filter: `primary_topic.id:${t.id},publication_year:2023,is_retracted:false`, per_page: "1", select: "id" }),
      api("works", { filter: `topics.id:${t.id},publication_year:2023,is_retracted:false`, per_page: "1", select: "id" }),
    ]);
    const n = { search: numberFrom(s.json), group: g.json?.total_works, analyze: a.json?.total_works, calculate: c.json?.summary?.all?.count ?? numberFrom(c.json) };
    const vals = Object.values(n);
    const one = vals.every((v) => typeof v === "number" && v === vals[0]);
    if (one) agree++;
    const anyMatches = !anyRes.isError && numberFrom(anyRes.json) === any.meta.count;
    if (anyMatches) anyOk++;
    const anyNote = anyMatches ? " any_topic_ids=API" : "";
    rows.push(`${t.id} search ${n.search} group ${n.group} analyze ${n.analyze} calculate ${n.calculate} | API primary ${primary.meta.count} any ${any.meta.count}${one ? " AGREE" : ""}${anyNote}`);
  }
  console.log(`topics: one count across the four tools ${agree}/${list.length}; any_topic_ids matches the API's any-topic count ${anyOk}/${list.length}`);
  for (const r of rows) console.log("   ", r);
  return { set: "topics", agree, n: list.length, anyOk };
}

const SETS: Record<string, () => Promise<any>> = { bigauthors, cby, topics };
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SETS);
const summary: any[] = [];
for (const s of wanted) summary.push(await SETS[s]!());
console.log(JSON.stringify(summary));
await client.close();
