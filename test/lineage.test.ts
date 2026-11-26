import { describe, it, expect, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server";
import { buildWorkFilter, GROUP_BY_FIELDS } from "../src/filters";

// oxjob #2644: one meaning of "publisher" and "institution" across the tools. The filters, OQL and now group_works and
// analyze_works all count an organization with its sub-units (lineage), so a row equals the count of its own filter.

describe("publisher and institution mean the organization with its sub-units", () => {
  it("group_by uses the same lineage fields as the filters", () => {
    expect(GROUP_BY_FIELDS.publisher).toBe("primary_location.source.host_organization_lineage");
    expect(GROUP_BY_FIELDS.institution).toBe("authorships.institutions.lineage");
    expect(buildWorkFilter({ publisher_ids: ["P4310319965"] })).toBe(`${GROUP_BY_FIELDS.publisher}:P4310319965`);
    expect(buildWorkFilter({ institution_ids: ["I1294671590"] })).toBe(`${GROUP_BY_FIELDS.institution}:I1294671590`);
  });
});

const semanticResults = [
  { id: "https://openalex.org/W1", primary_location: { source: {
    host_organization: "https://openalex.org/P2", host_organization_name: "Cambridge University Press",
    host_organization_lineage: ["https://openalex.org/P2", "https://openalex.org/P1"],
    host_organization_lineage_names: ["Cambridge University Press", "University of Cambridge"] } },
    authorships: [
      { institutions: [{ id: "https://openalex.org/I10", display_name: "Lab A", lineage: ["https://openalex.org/I99", "https://openalex.org/I10"] }] },
      { institutions: [{ id: "https://openalex.org/I11", display_name: "Lab B", lineage: ["https://openalex.org/I11", "https://openalex.org/I99"] }] },
    ] },
  { id: "https://openalex.org/W2", primary_location: { source: {
    host_organization: "https://openalex.org/P1", host_organization_name: "University of Cambridge",
    host_organization_lineage: ["https://openalex.org/P1"], host_organization_lineage_names: ["University of Cambridge"] } },
    authorships: [{ institutions: [{ id: "https://openalex.org/I10", display_name: "Lab A", lineage: ["https://openalex.org/I10", "https://openalex.org/I99"] }] }] },
];

async function connect() {
  const get = vi.fn(async (path: string, params: any = {}) => {
    if (path === "/institutions") return { meta: { count: 1 }, results: [{ id: "https://openalex.org/I99", display_name: "Parent Institute" }] };
    if (params["search.semantic"]) return { meta: { count: 2 }, results: semanticResults };
    if (params.group_by) return { meta: { count: 10 }, group_by: [{ key: "https://openalex.org/I99", key_display_name: "Parent Institute", count: 10 }] };
    return { meta: { count: 10, page: 1, per_page: 1 }, results: [{ id: "https://openalex.org/W1" }] };
  });
  const client: any = { creditsUsed: 0, budgetNote: () => null, get, post: vi.fn() };
  const server = createServer({ client, users: null, account: null });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), mcp.connect(b)]);
  return { mcp, get };
}

const call = (mcp: Client, name: string, args: Record<string, any>) => mcp.callTool({ name, arguments: args }) as Promise<any>;

describe("group_works and analyze_works group by lineage", () => {
  it("group_works asks the API for the lineage field", async () => {
    const { mcp, get } = await connect();
    await call(mcp, "group_works", { query: "kelp", group_by: "publisher" });
    expect(get.mock.calls[0]![1].group_by).toBe("primary_location.source.host_organization_lineage");
    await call(mcp, "group_works", { query: "kelp", group_by: "institution" });
    expect(get.mock.calls[1]![1].group_by).toBe("authorships.institutions.lineage");
  });
  it("analyze_works top_institutions uses lineage", async () => {
    const { mcp, get } = await connect();
    await call(mcp, "analyze_works", { query: "kelp", sections: ["top_institutions"] });
    expect(get.mock.calls.map((c: any) => c[1].group_by).filter(Boolean)).toEqual(["authorships.institutions.lineage"]);
  });
  it("semantic group_works counts a publisher with its parents, once per work", async () => {
    const { mcp } = await connect();
    const r = await call(mcp, "group_works", { query: "kelp forests", mode: "semantic", group_by: "publisher" });
    expect(JSON.parse(r.content[0].text).groups).toEqual([
      { id: "P1", name: "University of Cambridge", count: 2 },
      { id: "P2", name: "Cambridge University Press", count: 1 },
    ]);
  });
  it("semantic group_works counts an institution's parents once per work and names them", async () => {
    const { mcp, get } = await connect();
    const r = await call(mcp, "group_works", { query: "kelp forests", mode: "semantic", group_by: "institution" });
    expect(JSON.parse(r.content[0].text).groups).toEqual([
      { id: "I10", name: "Lab A", count: 2 },
      { id: "I99", name: "Parent Institute", count: 2 },   // a tie keeps first-seen order
      { id: "I11", name: "Lab B", count: 1 },
    ]);
    const lookup = get.mock.calls.find((c: any) => c[0] === "/institutions");
    expect(lookup![1].filter).toBe("id:I99");
  });
});
