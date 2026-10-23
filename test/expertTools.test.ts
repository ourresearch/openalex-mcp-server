import { describe, it, expect, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server";

// oxjob #1762: exclude_coauthors_of makes one 200-work read per anchor, so its 10-id cap must hold after the items are
// split on commas and spaces and deduplicated. The OpenAlex API is faked: one candidate (A100), who coauthored with A1.

const author = (id: string) => ({ author: { id: `https://openalex.org/${id}` } });

async function connect() {
  const get = vi.fn(async (path: string, params: any = {}) => {
    if (path === "/authors") return { meta: { count: 1 }, results: [{ id: "https://openalex.org/A100", display_name: "Candidate", works_count: 10 }] };
    if (String(params.filter ?? "").startsWith("authorships.author.id:")) {
      const anchor = params.filter.split(",")[0].split(":")[1];
      return { meta: { count: 1 }, results: [{ id: "https://openalex.org/W9", authorships: anchor === "A1" ? [author("A1"), author("A100")] : [author(anchor)] }] };
    }
    if (params.group_by) return { meta: { count: 5 }, group_by: [{ key: "https://openalex.org/A100", key_display_name: "Candidate", count: 5 }] };
    return { meta: { count: 5 }, results: [] };
  });
  const client: any = { creditsUsed: 0, budgetNote: () => null, get, post: vi.fn() };
  const server = createServer({ client, users: null, account: null, features: { findExperts: true } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), mcp.connect(b)]);
  const anchorReads = () => get.mock.calls.filter((c: any) => String(c[1]?.filter ?? "").startsWith("authorships.author.id:")).length;
  return { mcp, get, anchorReads };
}

const findExperts = (mcp: Client, exclude_coauthors_of: string[]) =>
  mcp.callTool({ name: "find_experts", arguments: { query: "kelp", exclude_coauthors_of } }) as Promise<any>;

describe("find_experts exclude_coauthors_of", () => {
  it("refuses more than 10 distinct ids however they are packed, before any API call", async () => {
    const many = Array.from({ length: 50 }, (_, i) => `A${i + 1}`);
    for (const items of [[many.join(" ")], [many.slice(0, 11).join(",")], Array.from({ length: 10 }, (_, i) => many.slice(i * 5, i * 5 + 5).join(", "))]) {
      const { mcp, get } = await connect();
      const r = await findExperts(mcp, items);
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toMatch(/at most 10 author IDs/);
      expect(get).not.toHaveBeenCalled();
    }
  });

  it("reads each distinct anchor once and still drops its coauthors", async () => {
    const { mcp, anchorReads } = await connect();
    const r = await findExperts(mcp, [Array(50).fill("A1").join(" "), "https://openalex.org/A1", "A2"]);
    expect(r.isError).toBeFalsy();
    expect(anchorReads()).toBe(2);
    const body = JSON.parse(r.content[0].text);
    expect(body.returned).toBe(0);
    expect(body.notes.join(" ")).toMatch(/coauthored with an exclude_coauthors_of author/);
  });

  it("refuses an anchor that is not an author id", async () => {
    const { mcp, get } = await connect();
    const r = await findExperts(mcp, ["A1|A2|A3"]);
    expect(r.isError).toBe(true);
    expect(get).not.toHaveBeenCalled();
  });
});
