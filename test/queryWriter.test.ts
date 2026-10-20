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

/**
 * A fake that answers by role, since the router runs beside the agent: the router (a JSON-schema call), the help desk
 * (its read_help_page tool) and the agent (its submit tool), each from its own canned turns. `agentHangs`: the agent's
 * call waits until it is stopped, like a real model call still thinking when the router says help desk.
 */
function fakeRoles(roles: { router?: any[][]; help?: any[][]; agent?: any[][]; agentHangs?: boolean }) {
  const seen: Record<string, any[]> = { router: [], help: [], agent: [] };
  const at: Record<string, number> = { router: 0, help: 0, agent: 0 };
  return {
    seen,
    messages: {
      async create(body: any, options?: { signal?: AbortSignal }) {
        const role = body.output_config?.format ? "router" : (body.tools ?? []).some((t: any) => t.name === "read_help_page") ? "help" : "agent";
        seen[role].push(JSON.parse(JSON.stringify(body)));
        if (role === "agent" && roles.agentHangs) {
          await new Promise((_, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
        }
        const turns = roles[role as "router" | "help" | "agent"] ?? [[]];
        const content = turns[Math.min(at[role]++, turns.length - 1)];
        return { id: `m`, type: "message", role: "assistant", model: body.model, content, stop_reason: content.some((b: any) => b.type === "tool_use") ? "tool_use" : "end_turn", stop_sequence: null, usage: USAGE } as any;
      },
    },
  };
}
const DATA = async () => ({ route: "data" as const, costUsd: 0 });
const SUBMIT = tool("s", "submit", { oql: "get works where title-abstract-keywords has (coffee AND health) and it's open access", sort: "", note: "All years." });

const jevFetch = (p: number) => (async () => new Response(JSON.stringify({ answers: { answers: { type: "noul", noul: p } }, usage: { input_tokens: 600 } }))) as unknown as typeof fetch;

const get = (path: string, key = "k123") => new Request(BASE + path, { headers: key ? { Authorization: `Bearer ${key}` } : {} });
const post = (body: any, key = "k123") => new Request(BASE + "/query/text", {
  method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body),
});

describe("parseRequest", () => {
  it("reads the question from the path", async () => {
    expect(await parseRequest(get("/query/text/open%20access%20coffee"))).toEqual({ text: "open access coffee", currentQuery: null, institution: null, history: [] });
  });
  it("reads ?text= and ?current_query=", async () => {
    const r: any = await parseRequest(get("/query/text?text=kelp&current_query=get%20works"));
    expect(r.text).toBe("kelp");
    expect(r.currentQuery).toBe("get works");
  });
  it("reads a POST body", async () => {
    expect(await parseRequest(post({ text: " since 2020 ", current_query: "get works where title has kelp", institution: { id: "I146416000", name: "KU" } })))
      .toEqual({ text: "since 2020", currentQuery: "get works where title has kelp", institution: { id: "I146416000", name: "KU" }, history: [] });
  });
  it("reads the chat's history, keeps the newest 6 and drops malformed turns", async () => {
    const history = [{ text: "q0", oql: "get works about a" }, { text: "", oql: "x" }, "junk",
      ...[1, 2, 3, 4, 5, 6].map((i) => ({ text: `q${i}`, oql: i === 3 ? null : `get works about b${i}` }))];
    const r: any = await parseRequest(post({ text: "since 2020", history }));
    expect(r.history.map((h: any) => h.text)).toEqual(["q1", "q2", "q3", "q4", "q5", "q6"]);
    expect(r.history[2].oql).toBeNull();
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
      { anthropic, openalex: fakeOpenAlex(), fetchImpl: jevFetch(0.874), guide: "G", route: DATA });
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
    const res = await handle(get("/query/text/kelp"), { OPENALEX_API_BASE: BASE }, { anthropic: fakeAnthropic([[{ type: "text", text: "hmm" }]]), openalex: fakeOpenAlex(), guide: "G", route: DATA });
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

  it("answers a how-to with no subject from the help site, with a link and no query", async () => {
    const anthropic = fakeRoles({ agentHangs: true, agent: [[SUBMIT]], help: [
      [tool("p", "read_help_page", { url: "https://help.openalex.org/how-to/fixing-authors/" })],
      [tool("a", "answer", { text: "Claim your profile, then add or remove works yourself.", link: "https://help.openalex.org/how-to/fixing-authors/" })],
    ] });
    const pages: string[] = [];
    const fetchImpl = (async (u: any) => { pages.push(String(u)); return new Response(String(u).endsWith("llms.txt") ? "# OpenAlex Help\n- [Fixing authors](https://help.openalex.org/how-to/fixing-authors/)" : "# Fixing authors\nClaim it."); }) as unknown as typeof fetch;
    const res = await handle(post({ text: "how do I fix my author profile?" }), { OPENALEX_API_BASE: BASE },
      { anthropic, openalex: fakeOpenAlex(), guide: "G", fetchImpl, route: async () => ({ route: "help_desk", costUsd: 0.0003 }) });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body).toMatchObject({ route: "help_desk", oql: null, link: "https://help.openalex.org/how-to/fixing-authors/" });
    expect(body.answer).toContain("Claim your profile");
    expect(pages).toContain("https://help.openalex.org/how-to/fixing-authors.md");
    expect(anthropic.seen.help[0].system[0].text).toContain("# OpenAlex Help");
    expect(anthropic.seen.agent.length).toBe(1);   // started beside the router, stopped when it said help desk
    expect(body.meta.cost.credits).toBe(Math.ceil((0.0003 + 2 * (1000 * 4 + 200 * 20 + 9000 * 0.2) / 1e6) * 10000));
  });

  it("routes with the router model and falls back to data when the router fails", async () => {
    const anthropic = fakeRoles({ router: [[{ type: "text", text: '{"route": "data"}' }]], agent: [[SUBMIT]] });
    const res = await handle(post({ text: "open access articles about coffee and health" }), { OPENALEX_API_BASE: BASE }, { anthropic, openalex: fakeOpenAlex(), guide: "G" });
    expect(res.status).toBe(200);
    expect(anthropic.seen.router[0].model).toBe("claude-haiku-5-5");
    expect(anthropic.seen.router[0].output_config.format.schema.properties.route.enum).toEqual(["help_desk", "data"]);
    expect(anthropic.seen.agent[0].model).toBe("claude-opus-5-5");
    const broken = fakeRoles({ router: [[{ type: "text", text: "not json" }]], agent: [[SUBMIT]] });
    expect((await handle(post({ text: "open access articles about coffee and health" }), { OPENALEX_API_BASE: BASE }, { anthropic: broken, openalex: fakeOpenAlex(), guide: "G" })).status).toBe(200);
  });

  it("runs a follow-up on the follow-up model and effort when they are set", async () => {
    const anthropic = fakeRoles({ agent: [[SUBMIT]] });
    const env = { OPENALEX_API_BASE: BASE, FOLLOWUP_MODEL: "claude-sonnet-5-5", FOLLOWUP_EFFORT: "high" };
    const res = await handle(post({ text: "only open access", current_query: "get works about coffee" }), env, { anthropic, openalex: fakeOpenAlex(), guide: "G", route: DATA });
    const body: any = await res.json();
    expect(anthropic.seen.agent[0].model).toBe("claude-sonnet-5-5");
    expect(anthropic.seen.agent[0].output_config.effort).toBe("high");
    expect(body.meta).toMatchObject({ model: "claude-sonnet-5-5", effort: "high" });
    await handle(post({ text: "coffee and health" }), env, { anthropic, openalex: fakeOpenAlex(), guide: "G", route: DATA });
    expect(anthropic.seen.agent.at(-1).model).toBe("claude-opus-5-5");   // a fresh question keeps the agent's model
  });

  it("returns the question left out, what's out of reach and a line of how-to", async () => {
    const sub = tool("s", "submit", { ...SUBMIT.input, left_out: "what they cite", out_of_reach: " ", howto: "Search titles and abstracts for coffee and health, then filter to open access." });
    const res = await handle(post({ text: "how do I find open access articles about coffee and health, and what do they cite?" }), { OPENALEX_API_BASE: BASE },
      { anthropic: fakeAnthropic([[sub]]), openalex: fakeOpenAlex(), guide: "G", route: DATA });
    const body: any = await res.json();
    expect(body).toMatchObject({ route: "query", left_out: "what they cite", out_of_reach: null });
    expect(body.howto).toContain("filter to open access");
  });

  it("passes a follow-up's current query on and has no spending cap beyond the turn limit", async () => {
    const pricey = { input_tokens: 0, output_tokens: 8000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }; // $0.16 a turn
    const anthropic = fakeAnthropic([[tool("f", "find_entity", { type: "institutions", name: "Kansas" })], [tool("r", "run_oql", { oql: "x" })], [SUBMIT]], pricey);
    const res = await handle(post({ text: "only open access", current_query: "get works where title has (coffee AND health)" }), { OPENALEX_API_BASE: BASE },
      { anthropic, openalex: fakeOpenAlex(), guide: "G", route: DATA });
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
