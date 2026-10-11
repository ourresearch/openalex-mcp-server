import { describe, it, expect } from "vitest";
import { parseRequest, callerKey, creditsFor, handle, confidence } from "../src/queryText";
import { costUsd } from "../src/chat";

const BASE = "https://api.openalex.org";

function fakeOpenAlex() {
  return {
    async get() { return { results: [{ id: "https://openalex.org/I146416000", display_name: "University of Kansas", works_count: 1 }] }; },
    async checkOql(oql: string) { return { oql, validation: { valid: true, errors: [] } }; },
    async post() { return { meta: { count: 5559 }, results: [{ id: "https://openalex.org/W1", display_name: "Coffee and health", publication_year: 2021, cited_by_count: 3 }] }; },
  };
}

const USAGE = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0 };

function fakeAnthropic(turns: any[][], usage = USAGE) {
  const requests: any[] = [];
  let i = 0;
  return {
    requests,
    messages: {
      async create(body: any) {
        requests.push(JSON.parse(JSON.stringify(body)));
        const content = turns[Math.min(i, turns.length - 1)];
        i++;
        return { id: `m${i}`, type: "message", role: "assistant", model: body.model, content, stop_reason: content.length ? "tool_use" : "end_turn", stop_sequence: null, usage } as any;
      },
    },
  };
}

const tool = (id: string, name: string, input: any) => ({ type: "tool_use", id, name, input });
const SUBMIT = tool("s", "submit", { oql: "get works where title-abstract-keywords has (coffee AND health) and it's open access", sort: "", note: "All years." });

const jevFetch = (p: number) => (async () => new Response(JSON.stringify({ answers: { answers: { type: "noul", noul: p } }, usage: { input_tokens: 600 } }))) as unknown as typeof fetch;

const get = (path: string, key = "k123") => new Request(BASE + path, { headers: key ? { Authorization: `Bearer ${key}` } : {} });
const post = (body: any, key = "k123") => new Request(BASE + "/query/text", {
  method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body),
});

describe("parseRequest", () => {
  it("reads the question from the path", async () => {
    expect(await parseRequest(get("/query/text/open%20access%20coffee"))).toEqual({ text: "open access coffee", currentQuery: null, institution: null });
  });
  it("reads ?text= and ?current_query=", async () => {
    const r: any = await parseRequest(get("/query/text?text=kelp&current_query=get%20works"));
    expect(r.text).toBe("kelp");
    expect(r.currentQuery).toBe("get works");
  });
  it("reads a POST body", async () => {
    expect(await parseRequest(post({ text: " since 2020 ", current_query: "get works where title has kelp", institution: { id: "I146416000", name: "KU" } })))
      .toEqual({ text: "since 2020", currentQuery: "get works where title has kelp", institution: { id: "I146416000", name: "KU" } });
  });
  it("refuses empty, long, non-JSON and wrong-method requests", async () => {
    expect(await parseRequest(get("/query/text/"))).toMatchObject({ status: 400 });
    expect(await parseRequest(post({ text: "x".repeat(2001) }))).toMatchObject({ status: 400 });
    expect(await parseRequest(post("not json"))).toMatchObject({ status: 400 });
    expect(await parseRequest(new Request(BASE + "/query/text", { method: "DELETE" }))).toMatchObject({ status: 405 });
    expect(await parseRequest(get("/works"))).toMatchObject({ status: 404 });
  });
});

describe("callerKey and creditsFor", () => {
  it("takes the bearer key, else api_key", () => {
    expect(callerKey(get("/query/text/x", "abc"))).toBe("abc");
    expect(callerKey(new Request(BASE + "/query/text/x?api_key=zzz"))).toBe("zzz");
    expect(callerKey(new Request(BASE + "/query/text/x"))).toBeNull();
  });
  it("rounds credits up", () => {
    expect(creditsFor(0.02)).toBe(200);
    expect(creditsFor(0.020001)).toBe(201);
    expect(creditsFor(0)).toBe(0);
  });
});

describe("handle", () => {
  it("answers with the query, note, confidence, count and a cost header the proxy settles from", async () => {
    const anthropic = fakeAnthropic([[tool("r", "run_oql", { oql: SUBMIT.input.oql })], [SUBMIT]]);
    const res = await handle(get("/query/text/open%20access%20articles%20about%20coffee%20and%20health"), { OPENALEX_API_BASE: BASE, TYPESAFE_API_KEY: "t" },
      { anthropic, openalex: fakeOpenAlex(), fetchImpl: jevFetch(0.874), guide: "G" });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.oql).toContain("coffee AND health");
    expect(body.note).toBe("All years.");
    expect(body.confidence).toBe(0.874);
    expect(body.count).toBe(5559);
    const usd = 2 * costUsd(USAGE) + 600 * 0.042 / 1e6;
    expect(body.meta.cost.credits).toBe(Math.ceil(usd * 10000));
    expect(res.headers.get("X-Credits-Cost")).toBe(String(body.meta.cost.credits));
    expect(body.meta.model).toBe("claude-opus-5-5");
  });

  it("needs the caller's key and charges nothing without one", async () => {
    const res = await handle(get("/query/text/kelp", ""), { OPENALEX_API_BASE: BASE }, { anthropic: fakeAnthropic([[SUBMIT]]), openalex: fakeOpenAlex() });
    expect(res.status).toBe(401);
    expect(res.headers.get("X-Credits-Cost")).toBe("0");
  });

  it("reports what the model cost when it finds no query (422; the proxy charges errors nothing)", async () => {
    const res = await handle(get("/query/text/kelp"), { OPENALEX_API_BASE: BASE }, { anthropic: fakeAnthropic([[{ type: "text", text: "hmm" }]]), openalex: fakeOpenAlex(), guide: "G" });
    expect(res.status).toBe(422);
    expect(Number(res.headers.get("X-Credits-Cost"))).toBe(Math.ceil(costUsd(USAGE) * 10000));
  });

  it("runs a Boolean search string as typed, with no model call and no model charge", async () => {
    const anthropic = fakeAnthropic([[SUBMIT]]);
    const res = await handle(post({ text: '("kelp forest" OR seaweed) AND decline' }), { OPENALEX_API_BASE: BASE }, { anthropic, openalex: fakeOpenAlex(), guide: "G" });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Credits-Cost")).toBe("0");
    expect(anthropic.requests).toHaveLength(0);
    const body: any = await res.json();
    expect(body).toMatchObject({ route: "search_string", oql: 'get works where title-abstract-keywords has (("kelp forest" OR seaweed) AND decline)', count: 5559 });
    expect(body.note).toContain("run as written over titles, abstracts and keywords");
  });

  it("answers a pasted title from a confirmed lookup", async () => {
    const anthropic = fakeAnthropic([[SUBMIT]]);
    const oa = { ...fakeOpenAlex(), async post() { return { meta: { count: 1 }, results: [{ id: "https://openalex.org/W2", display_name: "Coffee and Health: A Review of Recent Human Research", publication_year: 2006 }] }; } };
    const res = await handle(post({ text: "Coffee and Health: A Review of Recent Human Research" }), { OPENALEX_API_BASE: BASE }, { anthropic, openalex: oa, guide: "G" });
    const body: any = await res.json();
    expect(body).toMatchObject({ route: "title", oql: 'get works where title has ("Coffee and Health: A Review of Recent Human Research")', note: "The paper with this title." });
    expect(anthropic.requests).toHaveLength(0);
  });

  it("passes a follow-up's current query on and has no spending cap beyond the turn limit", async () => {
    const pricey = { input_tokens: 0, output_tokens: 8000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }; // $0.16 a turn
    const anthropic = fakeAnthropic([[tool("f", "find_entity", { type: "institutions", name: "Kansas" })], [tool("r", "run_oql", { oql: "x" })], [SUBMIT]], pricey);
    const res = await handle(post({ text: "only open access", current_query: "get works where title has (coffee AND health)" }), { OPENALEX_API_BASE: BASE },
      { anthropic, openalex: fakeOpenAlex(), guide: "G" });
    expect(res.status).toBe(200);
    expect(anthropic.requests).toHaveLength(3);
    expect(JSON.stringify(anthropic.requests[1].messages)).not.toContain("Last turn");
    expect(anthropic.requests[0].messages[0].content).toContain("The results page currently shows this query: get works where title has (coffee AND health)");
    const body: any = await res.json();
    expect(body.meta.cost.credits).toBe(Math.ceil(3 * costUsd(pricey) * 10000));
    expect(body.confidence).toBeNull(); // no Jev key configured
  });
});

describe("confidence", () => {
  const ans = { oql: "q", sort: null, note: "", preview: { ok: true, count: 1 } };
  it("is null without a key or when Jev fails", async () => {
    expect((await confidence(undefined, "q", ans)).p).toBeNull();
    const failing = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    expect((await confidence("t", "q", ans, failing)).p).toBeNull();
    const throwing = (async () => { throw new Error("down"); }) as unknown as typeof fetch;
    expect((await confidence("t", "q", ans, throwing)).p).toBeNull();
  });
});
