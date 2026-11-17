import { describe, it, expect, vi, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server";
import { OpenAlexClient, pulledParams } from "../src/openalex";
import { shapeWork, PULLED_WARNING, RETRACTION_WARNING } from "../src/shape";
import { filterNamesPulled, pulledChoice } from "../src/filters";

// oxjob #2264: the API's default view hides pulled works (retracted, withdrawn or removed) from every works list,
// search, count, group_by and OQL run, and include_pulled=true (a URL parameter) brings them back. The tools add no
// is_retracted:false / `retracted is (false)` of their own (the API would now read that as a request for pulled
// works), send include_pulled=true only when asked, and pass a user's own retracted or pulled clause through.

const jsonResponse = (status: number, body: any) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

describe("the API client", () => {
  it("sends include_pulled only as true, never false", () => {
    expect(pulledParams(true)).toEqual({ include_pulled: "true" });
    expect(pulledParams(false)).toEqual({});
    expect(pulledParams(undefined)).toEqual({});
  });
  it("puts include_pulled in the URL of a list call, an OQL run and the check, and follows redirects", async () => {
    const calls: Array<[string, any]> = [];
    vi.stubGlobal("fetch", vi.fn(async (u: any, init: any) => { calls.push([String(u), init]); return jsonResponse(200, { meta: {} }); }));
    const c = new OpenAlexClient({ apiKey: "k" });
    await c.get("/works", { filter: "x", ...pulledParams(true) });
    await c.post({ oql: "get works" }, pulledParams(true));
    await c.checkOql("get works", undefined, pulledParams(true));
    await c.post({ oql: "get works" });
    expect(calls[0]![0]).toBe("https://api.openalex.org/works?filter=x&include_pulled=true");
    expect(calls[1]![0]).toBe("https://api.openalex.org/?include_pulled=true");
    expect(calls[2]![0]).toContain("?include_pulled=true");
    expect(calls[3]![0]).toBe("https://api.openalex.org/");
    // the API answers a filter naming is_retracted with a 302 to the same URL plus include_pulled=true: it must land
    for (const [, init] of calls) expect(init.redirect).toBeUndefined();
  });
});

describe("helpers", () => {
  it("include_retracted is an alias of include_pulled", () => {
    expect(pulledChoice({})).toBeUndefined();
    expect(pulledChoice({ include_pulled: true })).toBe(true);
    expect(pulledChoice({ include_retracted: true })).toBe(true);
    expect(pulledChoice({ include_pulled: false })).toBe(false);
  });
  it("spots a filter naming is_retracted or is_pulled", () => {
    expect(filterNamesPulled("publication_year:2020,is_retracted:true")).toBe(true);
    expect(filterNamesPulled("is_pulled:false")).toBe(true);
    expect(filterNamesPulled("title.search:is_retracted:x")).toBe(false);
    expect(filterNamesPulled(null)).toBe(false);
  });
  it("records lead with is_pulled, and a withdrawn work's full record with its warning", () => {
    const withdrawn = shapeWork({ id: "https://openalex.org/W1", is_pulled: true, is_retracted: false }, { full: true }) as any;
    expect(Object.keys(withdrawn).slice(0, 2)).toEqual(["is_pulled", "warning"]);
    expect(withdrawn.warning).toBe(PULLED_WARNING);
    const retracted = shapeWork({ id: "https://openalex.org/W2", is_pulled: true, is_retracted: true }, { full: true }) as any;
    expect(Object.keys(retracted).slice(0, 3)).toEqual(["is_retracted", "warning", "is_pulled"]);
    expect(retracted.warning).toBe(RETRACTION_WARNING);
    expect("is_pulled" in (shapeWork({ id: "https://openalex.org/W3", is_pulled: false }) as any)).toBe(false);
  });
});

const WITHDRAWN = { id: "https://openalex.org/W1", display_name: "A withdrawn paper", publication_year: 2020, type: "article", is_pulled: true, is_retracted: false, authorships: [] };

async function connect() {
  const get = vi.fn(async (path: string, params: any = {}) => {
    if (path.startsWith("/works/")) return WITHDRAWN;
    if (path === "/authors/A9") return { id: "https://openalex.org/A9", display_name: "Ada Lovelace" };
    if (path === "/authors" || path === "/keywords") return { meta: { count: 0 }, results: [] };
    if (params.group_by) return { meta: { count: 3, x_query: { oql: "get works about kelp" } }, group_by: [] };
    return { meta: { count: 1, page: 1, per_page: 15, x_query: { oql: "get works about kelp" } }, results: [WITHDRAWN] };
  });
  const post = vi.fn(async (_body: any, _query?: any) => ({ meta: { count: 1, x_query: { oql: "get works about kelp" } }, results: [] }));
  const checkOql = vi.fn(async (oql: string, _style?: string, _query?: any) => ({ oql, validation: { valid: true } }));
  const client: any = { creditsUsed: 0, budgetNote: () => null, get, post, checkOql };
  const server = createServer({ client, users: null, account: null, features: { keywordSearch: true, findExperts: true } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), mcp.connect(b)]);
  const call = async (name: string, args: Record<string, any>) => {
    const r = (await mcp.callTool({ name, arguments: args })) as any;
    expect(r.isError, r.content?.[0]?.text).toBeFalsy();
    return JSON.parse(r.content[0].text);
  };
  return { call, get, post, checkOql };
}

const worksCalls = (get: any) => get.mock.calls.filter((c: any) => c[0] === "/works").map((c: any) => c[1]);

describe("works tools leave pulled works to the API", () => {
  it("search_works adds no filter and no parameter by default, and says pulled works are hidden", async () => {
    const { call, get } = await connect();
    const r = await call("search_works", { query: "kelp", from_year: 2020 });
    const params = worksCalls(get)[0];
    expect(params.filter).toBe("title_abstract_keywords.search:kelp,publication_year:>2019");
    expect(params.include_pulled).toBeUndefined();
    expect(r.pulled_works).toMatch(/^excluded by default \(retracted, withdrawn or removed works\)/);
    expect(r.retracted_works).toBeUndefined();
    expect(r.reproduce_url).not.toContain("include_pulled");
  });
  it("search_works with include_pulled (or the deprecated include_retracted) sends include_pulled=true", async () => {
    for (const flag of ["include_pulled", "include_retracted"]) {
      const { call, get } = await connect();
      const r = await call("search_works", { query: "kelp", [flag]: true });
      const params = worksCalls(get)[0];
      expect(params.include_pulled).toBe("true");
      expect(params.filter).not.toMatch(/is_retracted|is_pulled/);
      expect(r.pulled_works).toBe("included; pulled rows carry is_pulled: true");
      expect(r.reproduce_url).toMatch(/&include_pulled=true$/);
      expect(Object.keys(r.results[0])[0]).toBe("is_pulled");
    }
  });
  it("search_works passes a user's own is_retracted filter through, untouched (the API redirects it)", async () => {
    const { call, get } = await connect();
    const r = await call("search_works", { raw_filter: "is_retracted:true" });
    expect(worksCalls(get)[0]).toMatchObject({ filter: "is_retracted:true" });
    expect(worksCalls(get)[0].include_pulled).toBeUndefined();
    expect(r.pulled_works).toMatch(/^as filtered by the query's own/);
  });
  it("a call with no query or filter still covers the whole corpus, as it did with the old default filter", async () => {
    const { call, get } = await connect();
    const r = await call("search_works", { sort: "cited_by_count", limit: 1 });
    expect(worksCalls(get)[0].filter).toBeNull();   // buildUrl drops it
    expect(r.results).toHaveLength(1);
    await call("analyze_works", { sections: ["by_year"] });
  });
  it("the profile audit view keeps pulled works", async () => {
    const { call, get } = await connect();
    await call("search_works", { author_ids: ["A9"], for_author: "A9" });
    expect(worksCalls(get)[0].include_pulled).toBe("true");
  });
  it("search_works with oql sends the query as written, include_pulled in the URL when asked", async () => {
    const { call, post } = await connect();
    const r = await call("search_works", { oql: "works where title has (kelp)" });
    expect(post.mock.calls[0]![0].oql).toBe("works where title has (kelp)");
    expect(post.mock.calls[0]![1]).toEqual({});
    expect(r.pulled_works).toMatch(/^excluded by default/);
    const asked = await connect();
    await asked.call("search_works", { oql: "works where title has (kelp)", include_pulled: true });
    expect(asked.post.mock.calls[0]![1]).toEqual({ include_pulled: "true" });
  });
  it("search_works with oql leaves the user's own retracted clause to the API", async () => {
    const { call, post } = await connect();
    const r = await call("search_works", { oql: "works where title has (kelp) and retracted is (false)" });
    expect(post.mock.calls[0]![0].oql).toBe("works where title has (kelp) and retracted is (false)");
    expect(post.mock.calls[0]![1]).toEqual({});
    expect(r.pulled_works).toMatch(/^as filtered by the query's own/);
  });
  it("group_works, analyze_works and list_citations pass include_pulled through", async () => {
    for (const [tool, args] of [
      ["group_works", { query: "kelp", group_by: "year" }],
      ["analyze_works", { query: "kelp", sections: ["by_year"] }],
      ["list_citations", { work_id: "W2741809807" }],
    ] as const) {
      const plain = await connect();
      const r = await plain.call(tool, args);
      for (const p of worksCalls(plain.get)) { expect(p.include_pulled, tool).toBeUndefined(); expect(p.filter ?? "").not.toMatch(/is_retracted/); }
      expect(r.pulled_works, tool).toMatch(/^excluded by default/);
      const asked = await connect();
      await asked.call(tool, { ...args, include_pulled: true });
      for (const p of worksCalls(asked.get)) expect(p.include_pulled, tool).toBe("true");
    }
  });
  it("group_works with oql sends include_pulled with the run", async () => {
    const { call, post } = await connect();
    await call("group_works", { oql: "works where title has (kelp)", group_by: "year", include_retracted: true });
    expect(post.mock.calls[0]![0].oql).toBe("works where title has (kelp) group by year");
    expect(post.mock.calls[0]![1]).toEqual({ include_pulled: "true" });
  });
  it("calculate_works asks for pulled works when a step calculates on them; check_oql checks as it will run", async () => {
    const { call, post, checkOql } = await connect();
    const q = "get works where topic is (T10878); then summarize using count, percent retracted";
    const r = await call("calculate_works", { oql: q });
    expect(post.mock.calls[0]![0].oql).toBe(q);
    expect(post.mock.calls[0]![1]).toEqual({ include_pulled: "true" });
    expect(r.pulled_works).toMatch(/^included, because the query splits or calculates/);
    await call("check_oql", { oql: "get works where topic is (T10878); then summarize using count", include_pulled: true });
    expect(checkOql.mock.calls.at(-1)).toEqual(["get works where topic is (T10878); then summarize using count", undefined, { include_pulled: "true" }]);
    await call("check_oql", { oql: "get works where topic is (T10878); then summarize using count" });
    expect(checkOql.mock.calls.at(-1)![2]).toEqual({});
  });
  it("resolve_references finds pulled works by text and flags them", async () => {
    const { call, get } = await connect();
    const r = await call("resolve_references", { references: ["Smith J (2020) A withdrawn paper. Journal of Things 3:1-9", "10.1234/withdrawn"] });
    const searches = worksCalls(get);
    expect(searches.length).toBeGreaterThan(0);
    for (const p of searches) expect(p.include_pulled).toBe("true");
    const byDoi = r.results.find((x: any) => x.input === "10.1234/withdrawn");
    expect(byDoi).toMatchObject({ match: "exact", pulled: true, pulled_warning: PULLED_WARNING });
    expect(r.summary.pulled).toBeGreaterThanOrEqual(1);
    expect(r.note).toMatch(/WITHDRAWN/);
  });
  it("keyword_search adds no retracted clause and sends include_pulled when asked", async () => {
    const plain = await connect();
    const r = await plain.call("keyword_search", { facets: [{ text: "kelp" }] });
    expect(r.oql).toBe("works where title-abstract-keywords has (kelp)");
    for (const c of plain.post.mock.calls) expect(c[1]).toEqual({});
    expect(r.pulled_works).toMatch(/^excluded by default/);
    const asked = await plain.call("keyword_search", { facets: [{ text: "kelp" }], include_pulled: true });
    expect(asked.reproduce_url).toMatch(/&include_pulled=true$/);
    expect(plain.post.mock.calls.at(-1)![1]).toEqual({ include_pulled: "true" });
  });
  it("find_experts keeps pulled works in the coauthor-conflict reads, and leaves the census to the API", async () => {
    const { call, get } = await connect();
    await call("find_experts", { query: "kelp", exclude_coauthors_of: ["A1"] });
    const calls = worksCalls(get);
    const anchors = calls.filter((p: any) => String(p.filter).startsWith("authorships.author.id:"));
    expect(anchors).toHaveLength(1);
    expect(anchors[0].include_pulled).toBe("true");
    for (const p of calls.filter((p: any) => !anchors.includes(p))) expect(p.include_pulled).toBeUndefined();
  });
});
