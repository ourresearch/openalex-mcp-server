/**
 * Live smoke test: logs in through the real OAuth flow, then exercises every tool.
 * Usage: MCP_URL=http://localhost:8788/mcp USERS_API_BASE=http://localhost:8000 \
 *        SMOKE_USER_API_KEY=<a real user's OpenAlex key> npx tsx scripts/smoke.ts
 * The user key stands in for the browser step on the consent page (see oauth-login.ts).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { oauthLogin, expectInvalidGrant } from "./oauth-login";

const url = process.env.MCP_URL ?? "http://localhost:8788/mcp";
const usersApiBase = process.env.USERS_API_BASE ?? "https://user.openalex.org";
const userKey = process.env.SMOKE_USER_API_KEY;
if (!userKey) {
  console.error("SMOKE_USER_API_KEY is required (an OpenAlex user's API key; stands in for the consent click)");
  process.exit(2);
}

// ---- OAuth flow ------------------------------------------------------------
const login = await oauthLogin({ mcpUrl: url, usersApiBase, userApiKey: userKey });
console.log(`oauth ok: client ${login.clientId.slice(0, 8)}…, key_kind=${login.keyKind}${login.organizationName ? ` (${login.organizationName})` : ""}`);
const firstRefresh = login.refreshToken!;
const rotated = await login.refresh();
if (!rotated.accessToken || !rotated.refreshToken || rotated.refreshToken === firstRefresh) throw new Error("refresh did not rotate");
// The provider keeps the previous refresh token alive until its replacement is first used
// (so a client can retry after a lost response). Use the replacement, then the original must be dead.
await login.refresh();
await expectInvalidGrant(login.tokenEndpoint, login.clientId, firstRefresh, url);
console.log("refresh ok: rotated; superseded refresh token → invalid_grant");
const badTok = await fetch(url, { method: "POST", headers: { authorization: "Bearer not-a-real-token", "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
if (badTok.status !== 401) throw new Error(`garbage bearer: expected 401, got ${badTok.status}`);
console.log("garbage bearer → 401");

const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${login.accessToken}` } } });
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
  ["search_works", { oql: 'works where title/abstract has "microplastics"', limit: 3, include_abstracts: false }, (r) => { if (r.error || !r.results?.length || !r.sort_note) throw new Error("quoted-phrase OQL should fall back to citation sort: " + (r.error ?? JSON.stringify(r).slice(0, 120))); }],
  ["search_works", { oql: "works where year is (2020)", from_year: 2019 }, (r) => { if (!r.error) throw new Error("expected exclusivity error"); }],
  ["search_works", { query: "CRISPR off-target effects", from_year: 2020, preview: true, preview_limit: 3 }, (r) => { if (!r.preview || r.results.length !== 3 || !r.oql) throw new Error("bad structured preview"); }],
  ["group_works", { group_by: "institution", oql: 'title/abstract has ((vaping or "vape*" or "electronic cigarette*") and ("adolescen*" or youth)) and year >= (2018)', limit: 5 }, (r) => { if (!r.groups?.length || !r.oql || !/group by institution/.test(r.oql)) throw new Error("bad oql group " + r.oql); }],
  ["read_docs", { topic: "oql", section: "Negation" }, (r) => { if (!/inside the parentheses/i.test(JSON.stringify(r))) throw new Error("negation section missing"); }],
  ["read_docs", { topic: "oql_spec", section: "Diagnostics" }, (r) => { if (!/OQL_SHORT_WILDCARD_PREFIX/.test(JSON.stringify(r))) throw new Error("spec section missing"); }],
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
  // ---- find_experts (oxjob #1274) ----
  ["find_experts", { query: "CRISPR off-target", institution_ids: ["I97018004"], from_year: 2021, limit: 5 }, (r) => { if (!r.experts?.length || !r.experts[0].evidence?.length || !r.experts[0].current_institutions?.length || r.experts[0].h_index == null || !r.oql) throw new Error("experts incomplete " + JSON.stringify(r.experts?.[0]).slice(0, 200)); if (r.experts.some((e: any) => e.matching_works < 2)) throw new Error("min_matching_works ignored"); }],
  ["find_experts", { query: "CRISPR off-target", institution_ids: ["I97018004"], from_year: 2021, institution_scope: "any_affiliation", sort: "recent", limit: 5 }, (r) => { if (!r.experts?.length) throw new Error("no experts"); const rec = r.experts.map((e: any) => e.recent_matching_works); if (rec.some((x: any, i: number) => i && x > rec[i - 1])) throw new Error("not sorted by recent " + rec); }],
  ["find_experts", { query: "Off-target effects of CRISPR-Cas9 genome editing and how to detect them.", mode: "semantic", limit: 3 }, (r) => { if (!r.experts?.length || !/semantic/.test(r.basis)) throw new Error("semantic basis missing"); }],
  ["find_experts", { query: "CRISPR off-target", from_year: 2021, exclude_coauthors_of: ["A5067184382"], limit: 5, sort: "h_index" }, (r) => { if (!r.experts?.length) throw new Error("no experts"); if (r.experts.some((e: any) => e.id === "A5067184382")) throw new Error("anchor not excluded"); const h = r.experts.map((e: any) => e.h_index); if (h.some((x: any, i: number) => i && x > h[i - 1])) throw new Error("not sorted by h " + h); }],
  ["find_experts", { topic_ids: ["T10102"], country: "CA", limit: 3 }, (r) => { if (!r.experts?.length || r.experts.some((e: any) => e.country !== "CA") || r.experts[0].topic_share == null) throw new Error("country/topic_share wrong " + JSON.stringify(r.experts?.map((e: any) => [e.name, e.country, e.topic_share]))); }],
  ["find_experts", { oql: 'works where title/abstract has ((vaping or "e-cigarette*") and "adolescen*") and year >= (2018)', limit: 3 }, (r) => { if (!r.experts?.length || !r.basis) throw new Error("oql experts missing"); }],
  ["find_experts", { oql: "works where year is (2020)", query: "x" }, (r) => { if (!r.error) throw new Error("expected exclusivity error"); }],
  ["find_experts", {}, (r) => { if (!r.error) throw new Error("expected 'give the topic' error"); }],
  // ---- profile curation (oxjob #1269): read-only paths + a no-op write the server skips ----
  ["search_works", { author_ids: ["A5023888391"], for_author: "A5023888391", limit: 5, include_abstracts: false }, (r) => { if (!r.profile?.name || !r.results?.length || !r.results[0].this_authorship?.raw_author_name || r.results[0].this_authorship.match !== "attributed") throw new Error("audit view incomplete " + JSON.stringify(r.results?.[0]?.this_authorship)); }],
  ["search_works", { author_ids: ["A5023888391"], for_author: "not-an-id" }, (r) => { if (!r.error) throw new Error("expected for_author validation error"); }],
  ["resolve_references", { author_id: "A5023888391", references: ["10.7717/peerj.4375", "10.1038/s41586-021-03819-2"] }, (r) => { if (r.results[0].on_profile !== true || r.results[1].on_profile !== false) throw new Error("on_profile wrong " + JSON.stringify(r.results.map((x: any) => x.on_profile))); }],
  ["find_candidate_works", { author_id: "A5023888391", orcid: "0000-0001-6187-6610", limit: 3 }, (r) => { if (!r.name_matches?.works?.length || !r.orcid_matches?.orcid_record?.works_on_record || !r.sibling_profiles) throw new Error("candidates incomplete " + Object.keys(r)); if (r.name_matches.works[0].this_authorship?.match === undefined) throw new Error("no byline pick"); }],
  ["find_candidate_works", { author_id: "A5023888391", name: "Jason Priem", sources: ["name"], from_year: 2015, limit: 3 }, (r) => { if (!r.name_matches) throw new Error("no name section"); if (r.orcid_matches || r.sibling_profiles) throw new Error("sources filter ignored"); }],
  ["get_my_account", {}, (r) => {
    if (r.error && /reconnect/i.test(r.error)) { console.log("     (grant has no personal key yet; users-api tools skipped until users-api ships #1269)"); return; }
    if (!r.user?.emails?.length || !("claim_eligibility" in r)) throw new Error("account incomplete " + Object.keys(r));
  }],
  ["list_my_curations", { limit: 3 }, (r) => { if (r.error && /reconnect/i.test(r.error)) return; if (typeof r.total !== "number") throw new Error("no total"); }],
  ["submit_curations", { items: [{ action: "set_display_name", value: "\u0000" }] }, (r) => { if (r.error && /reconnect/i.test(r.error)) return; if (!r.results?.[0] || r.results[0].status === "submitted") throw new Error("a control character must not be submitted: " + JSON.stringify(r.results?.[0])); }],
  ["submit_curations", { items: [{ action: "cancel", curation_id: "cur-doesnotexist" }, { action: "add_work", work_id: "10.9999/definitely-not-real", raw_author_name: "x" }] }, (r) => { if (r.error && /reconnect/i.test(r.error)) return; if (r.summary?.errors !== 2) throw new Error("expected 2 item errors " + JSON.stringify(r)); }],
  ["claim_author_profile", { author_id: "A5023888391" }, (r) => { if (r.error && /reconnect/i.test(r.error)) return; if (!r.already_claimed && !/already/.test(r.error ?? "")) throw new Error("expected already-claimed " + JSON.stringify(r)); }],
];

const listed = new Set(tools.map((t) => t.name));
for (const [name, args, check] of calls) {
  if (!listed.has(name)) { console.log(`skip ${name} (not registered on this deployment)`); continue; }
  const t0 = Date.now();
  try {
    const res: any = await client.callTool({ name, arguments: args });
    const text = res.content?.[0]?.text ?? "";
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { parsed = { text }; }
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
