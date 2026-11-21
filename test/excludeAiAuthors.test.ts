import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server";
import { buildWorkFilter, workFilterShape, assertSemanticCompatible } from "../src/filters";

// oxjob #2437: the works tools take one switch, exclude_ai_authors, that leaves out works with a declared
// software-agent author. It is a switch, not an author-type enum: most author types are not stated, so the
// negation keeps every work without a declared agent.

const NEG = "authorships.author.type:!software-agent";

describe("exclude_ai_authors filter", () => {
  it("adds the negated author-type filter when true, and nothing when false or unset", () => {
    expect(buildWorkFilter({ exclude_ai_authors: true })).toBe(NEG);
    expect(buildWorkFilter({ exclude_ai_authors: false })).toBeNull();
    expect(buildWorkFilter({})).toBeNull();
    expect(buildWorkFilter({ types: ["preprint"], exclude_ai_authors: true })).toBe(`type:preprint,${NEG}`);
  });
  it("takes a boolean only", () => {
    const shape = z.object(workFilterShape);
    expect(shape.safeParse({ exclude_ai_authors: true }).success).toBe(true);
    expect(shape.safeParse({ exclude_ai_authors: "software-agent" }).success).toBe(false);
  });
  it("is refused with semantic search, before the call", () => {
    expect(() => assertSemanticCompatible({ exclude_ai_authors: true })).toThrow(/exclude_ai_authors/);
    expect(() => assertSemanticCompatible({ exclude_ai_authors: false })).not.toThrow();
  });
});

async function connect() {
  const get = vi.fn(async (_path: string, params: any = {}) => {
    if (params.group_by) return { meta: { count: 10 }, group_by: [{ key: "article", key_display_name: "article", count: 10 }] };
    return { meta: { count: 1, page: 1, per_page: 15 }, results: [{ id: "https://openalex.org/W1", display_name: "A paper", type: "article" }] };
  });
  const post = vi.fn(async () => ({ meta: { count: 10 }, results: [] }));
  const client: any = { creditsUsed: 0, budgetNote: () => null, get, post };
  const server = createServer({ client, users: null, account: null });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), mcp.connect(b)]);
  return { mcp, get, post };
}

const call = (mcp: Client, name: string, args: Record<string, any>) => mcp.callTool({ name, arguments: args }) as Promise<any>;

describe("works tools pass exclude_ai_authors to the API", () => {
  it("search_works sends the filter and echoes it", async () => {
    const { mcp, get } = await connect();
    const r = await call(mcp, "search_works", { query: "kelp", exclude_ai_authors: true });
    expect(r.isError).toBeFalsy();
    expect(get.mock.calls[0]![1].filter).toContain(NEG);
    expect(JSON.parse(r.content[0].text).filter).toContain(NEG);
  });
  it("search_works with oql refuses it (it belongs inside the query)", async () => {
    const { mcp, post } = await connect();
    const r = await call(mcp, "search_works", { oql: "works where year is 2024", exclude_ai_authors: true });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/exclude_ai_authors/);
    expect(post).not.toHaveBeenCalled();
  });
  it("search_works in semantic mode says it can't, without calling the API", async () => {
    const { mcp, get } = await connect();
    const r = await call(mcp, "search_works", { query: "kelp forests", mode: "semantic", exclude_ai_authors: true });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/semantic/);
    expect(get).not.toHaveBeenCalled();
  });
  it("group_works takes it too", async () => {
    const { mcp, get } = await connect();
    const r = await call(mcp, "group_works", { query: "kelp", group_by: "type", exclude_ai_authors: true });
    expect(r.isError).toBeFalsy();
    expect(get.mock.calls[0]![1].filter).toContain(NEG);
  });
});
