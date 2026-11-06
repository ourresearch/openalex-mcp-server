import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server";
import { buildWorkFilter, workFilterShape, GROUP_BY_FIELDS } from "../src/filters";
import { OQL_GROUP_DIMS } from "../src/oql";
import { shapeWork } from "../src/shape";

// oxjob #2064: each work type is traditional or not. The works tools take is_traditional:true|false (the API expands it
// to the traditional types), group_works counts by it, and a work record carries it next to its type.

describe("is_traditional filter", () => {
  it("maps true and false to the API filter, and adds nothing when unset", () => {
    expect(buildWorkFilter({ is_traditional: true, include_retracted: true })).toBe("is_traditional:true");
    expect(buildWorkFilter({ is_traditional: false, include_retracted: true })).toBe("is_traditional:false");
    expect(buildWorkFilter({ include_retracted: true })).toBeNull();
    expect(buildWorkFilter({ types: ["article"], is_traditional: true })).toBe("type:article,is_traditional:true,is_retracted:false");
  });
  it("takes a boolean only", () => {
    const shape = z.object(workFilterShape);
    expect(shape.safeParse({ is_traditional: true }).success).toBe(true);
    expect(shape.safeParse({ is_traditional: "yes" }).success).toBe(false);
  });
  it("is a group_works dimension, with its OQL name", () => {
    expect(GROUP_BY_FIELDS.is_traditional).toBe("is_traditional");
    expect(OQL_GROUP_DIMS.is_traditional).toBe("traditional scholarly work");
  });
});

describe("shapeWork is_traditional", () => {
  const w = { id: "https://openalex.org/W1", display_name: "A dataset", publication_year: 2024, type: "dataset" };
  it("sits right after type when the API sends it, false included", () => {
    const s = shapeWork({ ...w, is_traditional: false }) as any;
    expect(s.is_traditional).toBe(false);
    const keys = Object.keys(s);
    expect(keys.indexOf("is_traditional")).toBe(keys.indexOf("type") + 1);
    expect((shapeWork({ ...w, type: "article", is_traditional: true }, { full: true }) as any).is_traditional).toBe(true);
  });
  it("is left out when the record has none", () => {
    expect("is_traditional" in shapeWork(w)).toBe(false);
  });
});

async function connect() {
  const get = vi.fn(async (_path: string, params: any = {}) => {
    if (params.group_by) return { meta: { count: 10 }, group_by: [{ key: "true", key_display_name: "true", count: 7 }, { key: "false", key_display_name: "false", count: 3 }] };
    if (params["search.semantic"]) return { meta: { count: 3 }, results: [
      { id: "https://openalex.org/W1", type: "article", is_traditional: true },
      { id: "https://openalex.org/W2", type: "preprint", is_traditional: true },
      { id: "https://openalex.org/W3", type: "dataset", is_traditional: false },
    ] };
    return { meta: { count: 1, page: 1, per_page: 15 }, results: [{ id: "https://openalex.org/W1", display_name: "A paper", type: "article", is_traditional: true }] };
  });
  const post = vi.fn(async () => ({ meta: { count: 10 }, group_by: [{ key: "true", key_display_name: "true", count: 7 }] }));
  const client: any = { creditsUsed: 0, budgetNote: () => null, get, post };
  const server = createServer({ client, users: null, account: null });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), mcp.connect(b)]);
  return { mcp, get, post };
}

const call = (mcp: Client, name: string, args: Record<string, any>) => mcp.callTool({ name, arguments: args }) as Promise<any>;

describe("works tools pass is_traditional to the API", () => {
  it("search_works sends the filter", async () => {
    const { mcp, get } = await connect();
    const r = await call(mcp, "search_works", { query: "kelp", is_traditional: false });
    expect(r.isError).toBeFalsy();
    expect(get.mock.calls[0]![1].filter).toContain("is_traditional:false");
  });
  it("search_works with oql refuses it (it belongs inside the query)", async () => {
    const { mcp, post } = await connect();
    const r = await call(mcp, "search_works", { oql: "works where year is 2024", is_traditional: true });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/is_traditional/);
    expect(post).not.toHaveBeenCalled();
  });
  it("group_works counts by it", async () => {
    const { mcp, get } = await connect();
    const r = await call(mcp, "group_works", { query: "kelp", group_by: "is_traditional" });
    expect(r.isError).toBeFalsy();
    expect(get.mock.calls[0]![1].group_by).toBe("is_traditional");
    expect(JSON.parse(r.content[0].text).groups.map((g: any) => g.count)).toEqual([7, 3]);
  });
  it("group_works with oql adds the OQL group by", async () => {
    const { mcp, post } = await connect();
    await call(mcp, "group_works", { oql: "works where year is 2024", group_by: "is_traditional" });
    expect((post.mock.calls[0] as any)[0].oql).toMatch(/group by traditional scholarly work$/);
  });
  it("semantic group_works selects it and counts the sample locally", async () => {
    const { mcp, get } = await connect();
    const r = await call(mcp, "group_works", { query: "kelp forests", mode: "semantic", group_by: "is_traditional" });
    expect(r.isError).toBeFalsy();
    expect(get.mock.calls[0]![1].select).toMatch(/,is_traditional$/);
    expect(JSON.parse(r.content[0].text).groups).toEqual([{ id: "true", name: "true", count: 2 }, { id: "false", name: "false", count: 1 }]);
  });
  it("analyze_works takes it too", async () => {
    const { mcp, get } = await connect();
    await call(mcp, "analyze_works", { query: "kelp", is_traditional: true, sections: ["by_type"] });
    expect(get.mock.calls.every((c: any) => String(c[1].filter).includes("is_traditional:true"))).toBe(true);
  });
});
