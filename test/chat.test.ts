import { describe, it, expect } from "vitest";
import { runChat, runOql, findEntity, systemPrompt, costUsd, MAX_TURNS, type ChatEvent, type OpenAlexLike } from "../src/chat";

// A fake OpenAlex: /query check refuses anything containing "bogus"; runs return a fixed grouped or summary answer.
function fakeOpenAlex(): OpenAlexLike & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async get(path: string, params: any = {}) {
      calls.push(`GET ${path} ${params.search ?? ""}`);
      return { results: [{ id: "https://openalex.org/I146416000", display_name: "University of Kansas", works_count: 120000, country_code: "US" }] };
    },
    async checkOql(oql: string) {
      calls.push(`CHECK ${oql}`);
      if (oql.includes("bogus")) return { oql, validation: { valid: false, errors: [{ message: 'unknown field "bogus"' }] } };
      return { oql: oql.replace("year >= 2020", "published since 2020"), validation: { valid: true, errors: [] } };
    },
    async post(body: any) {
      calls.push(`POST ${body.oql} ${body.sort ?? ""}`);
      if (body.oql.includes("summarize using count") && !body.oql.includes("group")) {
        return { meta: { count: 48213 }, summary: { all: { key: "all", count: 48213 } }, group_by: [], results: [] };
      }
      return {
        meta: { count: 1309, groups_count: 2, measures: [{ key: "count" }] },
        summary: { all: { key: "all", count: 1309 } },
        group_by: [{ key: "https://openalex.org/countries/US", key_display_name: "United States", count: 900 }, { key: "x", key_display_name: "Kenya", count: 409 }],
        results: [],
      };
    },
  };
}

// A fake Anthropic that plays back scripted assistant turns and records each request.
function fakeAnthropic(turns: any[][]) {
  const requests: any[] = [];
  let i = 0;
  return {
    requests,
    messages: {
      async create(body: any) {
        requests.push(JSON.parse(JSON.stringify(body)));
        const content = turns[Math.min(i, turns.length - 1)];
        i++;
        return { id: `msg_${i}`, type: "message", role: "assistant", model: body.model, content, stop_reason: "tool_use", stop_sequence: null,
                 usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0 } } as any;
      },
    },
  };
}

const tool = (id: string, name: string, input: any) => ({ type: "tool_use", id, name, input });
const thinking = { type: "thinking", thinking: "", signature: "sig-abc" };

describe("runOql", () => {
  it("returns a refusal as data", async () => {
    const p = await runOql(fakeOpenAlex(), "get works where bogus is 1");
    expect(p.ok).toBe(false);
    expect(JSON.stringify(p.errors)).toContain("bogus");
  });
  it("previews a grouped answer from the canonical form", async () => {
    const oa = fakeOpenAlex();
    const p = await runOql(oa, "get works where year >= 2020; then, group those works by country", "count:desc");
    expect(p.ok).toBe(true);
    expect(p.canonical).toContain("published since 2020");
    expect(p.top_groups?.map((g) => g.key_display_name)).toEqual(["United States", "Kenya"]);
    expect(p.top_groups?.[0]).not.toHaveProperty("key");
    expect(oa.calls.at(-1)).toContain("count:desc");
  });
  it("reads a no-split calculation from summary.all", async () => {
    const p = await runOql(fakeOpenAlex(), "get works where institution is (I146416000); then, summarize using count");
    expect(p.summary_all?.count).toBe(48213);
    expect(p.top_rows).toBeUndefined();
  });
  it("runs and returns the new sentence (it keeps the order), with the older form kept for the word check", async () => {
    const oa = fakeOpenAlex();
    const sentence = "get [University of Kansas](I146416000)'s works about kelp, most cited first";
    oa.checkOql = async (oql: string) => ({ oql: "get works where institution is (I146416000) and title-abstract-keywords has (kelp)", x_new_oql: sentence, validation: { valid: true } });
    const p = await runOql(oa, "get [University of Kansas](I146416000)'s works about kelp, most cited first");
    expect(p.canonical).toBe(sentence);
    expect(p.pipeline).toContain("title-abstract-keywords has (kelp)");
    expect(oa.calls.at(-1)).toContain("most cited first");
  });
  it("reports a canonical form that fails to run, without retrying another form", async () => {
    const oa = fakeOpenAlex();
    oa.checkOql = async () => ({ oql: "get works where x", x_new_oql: "broken render", validation: { valid: true } });
    const post = oa.post;
    oa.post = async (body: any) => { if (body.oql === "broken render") throw new Error("400"); return post(body); };
    const p = await runOql(oa, "get works about x");
    expect(p.ok).toBe(false);
    expect(p.canonical).toBe("broken render");
  });
});

describe("runChat reuse", () => {
  it("doesn't run a query again when the model submits what it just tried", async () => {
    const q = "get works where year >= 2020; then, group those works by country";
    const anthropic = fakeAnthropic([[tool("r", "run_oql", { oql: q })], [tool("s", "submit", { oql: q, note: "n" })]]);
    const oa = fakeOpenAlex();
    let answered = false;
    await runChat({ anthropic, openalex: oa }, { messages: [{ role: "user", content: "works since 2020 by country" }] }, (e) => { if (e.type === "answer") answered = true; });
    expect(answered).toBe(true);
    expect(oa.calls.filter((c: string) => c.startsWith("POST")).length).toBe(1);
  });
});

describe("history", () => {
  it("puts earlier turns before the question and the page's query after it", async () => {
    const anthropic = fakeAnthropic([[tool("t1", "submit", { oql: "get works where year >= 2020; then, group those works by country", note: "n" })]]);
    await runChat({ anthropic, openalex: fakeOpenAlex() }, {
      messages: [{ role: "user", content: "only open access" }],
      currentQuery: "rank countries by count of works about kelp",
      history: [{ text: "which countries publish most on kelp?", oql: "rank countries by count of works about kelp" }],
    }, () => {});
    const sent = anthropic.requests[0].messages[0].content as string;
    expect(sent.indexOf("which countries publish most on kelp?")).toBeLessThan(sent.indexOf("only open access"));
    expect(sent.indexOf("only open access")).toBeLessThan(sent.indexOf("currently shows this query"));
  });
  it("runs on the model it is given, priced as that model", async () => {
    const anthropic = fakeAnthropic([[tool("t1", "submit", { oql: "get works where year >= 2020; then, group those works by country", note: "n" })]]);
    let cost = -1;
    await runChat({ anthropic, openalex: fakeOpenAlex(), model: "claude-sonnet-5-5" }, { messages: [{ role: "user", content: "kelp by country" }] },
      (e) => { if (e.type === "done") cost = e.cost_usd; });
    expect(anthropic.requests[0].model).toBe("claude-sonnet-5-5");
    expect(cost).toBeGreaterThanOrEqual(0);
  });
  it("runs at the effort it is given", async () => {
    const anthropic = fakeAnthropic([[tool("t1", "submit", { oql: "get works where year >= 2020; then, group those works by country", note: "n" })]]);
    await runChat({ anthropic, openalex: fakeOpenAlex(), effort: "high" }, { messages: [{ role: "user", content: "kelp by country" }] }, () => {});
    expect(anthropic.requests[0].output_config.effort).toBe("high");
  });
});

describe("findEntity", () => {
  it("returns short ids and names", async () => {
    const out = JSON.parse(await findEntity(fakeOpenAlex(), "institutions", "Kansas"));
    expect(out[0]).toEqual({ id: "I146416000", name: "University of Kansas", works: 120000, country: "US" });
  });
});

describe("runChat", () => {
  it("looks up, checks, submits, and returns a conversation that can be sent back", async () => {
    const anthropic = fakeAnthropic([
      [thinking, tool("t1", "find_entity", { type: "institutions", name: "Kansas" })],
      [tool("t2", "run_oql", { oql: "get works where institution is [University of Kansas](I146416000); then, group those works by country" })],
      [tool("t3", "submit", { oql: "get works where institution is [University of Kansas](I146416000); then, group those works by country", sort: "count:desc", note: "All years." })],
    ]);
    const events: ChatEvent[] = [];
    const out = await runChat({ anthropic, openalex: fakeOpenAlex(), guide: "GUIDE" },
      { messages: [{ role: "user", content: "Where do KU's coauthors come from?" }] }, (e) => { events.push(e); });
    expect(out.answered).toBe(true);
    expect(events.map((e) => e.type)).toEqual(["step", "step", "answer", "done"]);
    const answer = events.find((e) => e.type === "answer") as any;
    expect(answer.sort).toBe("count:desc");
    expect(answer.preview.count).toBe(1309);
    const done = events.at(-1) as any;
    // user, then (assistant, user tool_result) per turn; the thinking block is kept untouched
    expect(done.messages.map((m: any) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user", "assistant", "user"]);
    expect(done.messages[1].content[0]).toEqual(thinking);
    expect(done.turns).toBe(3);
    expect(done.cost_usd).toBeCloseTo(3 * costUsd({ input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 9000, cache_creation_input_tokens: 0 }), 10);
    // model settings and a cached system prompt carrying the guide
    expect(anthropic.requests[0].model).toBe("claude-opus-5-5");
    expect(anthropic.requests[0].output_config).toEqual({ effort: "xhigh" });
    expect(anthropic.requests[0].system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(anthropic.requests[0].system[0].text).toContain("GUIDE");
  });

  it("hands a failing submit back to the model instead of setting the page", async () => {
    const anthropic = fakeAnthropic([
      [tool("t1", "submit", { oql: "get works where bogus is 1", sort: "", note: "" })],
      [tool("t2", "submit", { oql: "get works where year >= 2020; then, group those works by country", sort: "", note: "ok" })],
    ]);
    const events: ChatEvent[] = [];
    await runChat({ anthropic, openalex: fakeOpenAlex(), guide: "G" }, { messages: [{ role: "user", content: "q" }] }, (e) => { events.push(e); });
    expect(events.filter((e) => e.type === "answer")).toHaveLength(1);
    const secondRequest = anthropic.requests[1];
    const toolResult = secondRequest.messages.at(-1).content[0];
    expect(toolResult.is_error).toBe(true);
    expect(toolResult.content).toContain("Not submitted");
  });

  it("refuses a submit with search words the person never typed, then takes their own words", async () => {
    const anthropic = fakeAnthropic([
      [tool("r", "run_oql", { oql: "get works where title-abstract-keywords has (kelp OR seaweed)" })],
      [tool("s1", "submit", { oql: "get works where title-abstract-keywords has (kelp OR seaweed)", sort: "", note: "" })],
      [tool("s2", "submit", { oql: "get works where title-abstract-keywords has (kelp)", sort: "", note: "ok" })],
    ]);
    const events: ChatEvent[] = [];
    await runChat({ anthropic, openalex: fakeOpenAlex(), guide: "G" }, { messages: [{ role: "user", content: "papers on kelp" }] }, (e) => { events.push(e); });
    const trial = JSON.parse(anthropic.requests[1].messages.at(-1).content[0].content);
    expect(trial.new_search_words).toEqual(["seaweed"]);
    const refused = anthropic.requests[2].messages.at(-1).content[0];
    expect(refused.is_error).toBe(true);
    expect(refused.content).toContain('new search words ["seaweed"]');
    const answer: any = events.find((e) => e.type === "answer");
    expect(answer.oql).toBe("get works where title-abstract-keywords has (kelp)");
    expect(answer.new_words).toEqual([]);
    expect(events.find((e) => e.type === "done")).toMatchObject({ word_retries: 1 });
  });

  it("takes new search words on the last turn rather than no answer, and says which", async () => {
    const anthropic = fakeAnthropic([[tool("s", "submit", { oql: "get works where title-abstract-keywords has (kelp OR seaweed)", sort: "", note: "" })]]);
    const events: ChatEvent[] = [];
    const out = await runChat({ anthropic, openalex: fakeOpenAlex(), guide: "G" }, { messages: [{ role: "user", content: "papers on kelp" }] }, (e) => { events.push(e); });
    expect(out.answered).toBe(true);
    expect(anthropic.requests).toHaveLength(MAX_TURNS);
    expect(events.find((e) => e.type === "answer")).toMatchObject({ new_words: ["seaweed"] });
  });

  it("adds the page's current query to the newest user turn only", async () => {
    const anthropic = fakeAnthropic([[tool("t1", "submit", { oql: "get works where year >= 2020; then, group those works by country", sort: "", note: "" })]]);
    const history: any[] = [
      { role: "user", content: "works on kelp" },
      { role: "assistant", content: [{ type: "text", text: "earlier" }] },
      { role: "user", content: "only open access" },
    ];
    await runChat({ anthropic, openalex: fakeOpenAlex(), guide: "G" }, { messages: history, currentQuery: "get works where title-abstract-keywords has kelp" }, () => {});
    const sent = anthropic.requests[0].messages;
    expect(sent[0].content).toBe("works on kelp");
    expect(sent[2].content).toContain("The results page currently shows this query: get works where title-abstract-keywords has kelp");
    expect(history[2].content).toBe("only open access"); // the caller's array is not mutated
  });

  it("stops after MAX_TURNS with an error and a valid conversation, nudging on the last turn", async () => {
    const anthropic = fakeAnthropic([[tool("t", "find_entity", { type: "authors", name: "x" })]]);
    const events: ChatEvent[] = [];
    const out = await runChat({ anthropic, openalex: fakeOpenAlex(), guide: "G" }, { messages: [{ role: "user", content: "q" }] }, (e) => { events.push(e); });
    expect(out.answered).toBe(false);
    expect(anthropic.requests).toHaveLength(MAX_TURNS);
    const lastSent = anthropic.requests.at(-1).messages.at(-1).content;
    expect(JSON.stringify(lastSent)).toContain("Last turn: call submit now.");
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(events.at(-1)?.type).toBe("done");
  });

  it("refuses a conversation that doesn't end with the person's turn", async () => {
    const events: ChatEvent[] = [];
    await runChat({ anthropic: fakeAnthropic([]), openalex: fakeOpenAlex() }, { messages: [{ role: "assistant", content: "hi" }] }, (e) => { events.push(e); });
    expect(events[0].type).toBe("error");
  });
});

describe("systemPrompt", () => {
  it("names the person's institution when the page knows it", () => {
    expect(systemPrompt({ id: "I146416000", name: "University of Kansas" }, "G")).toContain("University of Kansas (I146416000)");
    expect(systemPrompt(null, "G")).toContain("say in the note which institution the query assumes");
  });
});
