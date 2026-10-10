import { describe, it, expect } from "vitest";
import { runChat, runOql, findEntity, systemPrompt, costUsd, MAX_TURNS, type ChatEvent, type OpenAlexLike } from "../src/chat";
import { validateBody } from "../src/chatRoute";

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

describe("validateBody", () => {
  it("accepts a conversation ending with the person's turn", () => {
    expect(validateBody({ messages: [{ role: "user", content: "q" }] })).toBeNull();
  });
  it("rejects bad shapes", () => {
    expect(validateBody(null)).toMatch(/object/);
    expect(validateBody({ messages: [] })).toMatch(/non-empty/);
    expect(validateBody({ messages: [{ role: "system", content: "x" }] })).toMatch(/role/);
    expect(validateBody({ messages: [{ role: "user", content: "q" }, { role: "assistant", content: "a" }] })).toMatch(/last message/);
    expect(validateBody({ messages: Array.from({ length: 61 }, () => ({ role: "user", content: "q" })) })).toMatch(/too long/);
  });
});
