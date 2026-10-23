import { describe, it, expect, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server";
import { UsersApiError } from "../src/users";

// oxjob #1762: submit_curations cancel withdraws only the user's own pending curation on their claimed profile, even
// when the account's users-api role (admin, site or org curator) could delete other curations. users-api is faked.

const ROWS: Record<string, any> = {
  "cur-own": { id: "cur-own", user_id: "U1", status: "pending", entity: "works", entity_id: "https://openalex.org/W1", value: "https://openalex.org/A1" },
  "cur-own-name": { id: "cur-own-name", user_id: "U1", status: "pending", entity: "authors", entity_id: "https://openalex.org/authors/a1", value: "New Name" },
  "cur-foreign": { id: "cur-foreign", user_id: "U2", status: "applied", entity: "works", entity_id: "https://openalex.org/W2", value: "https://openalex.org/A9" },
  "cur-foreign-pending": { id: "cur-foreign-pending", user_id: "U2", status: "pending", entity: "works", entity_id: "https://openalex.org/W3", value: "https://openalex.org/A1" },
  "cur-own-other": { id: "cur-own-other", user_id: "U1", status: "pending", entity: "authors", entity_id: "https://openalex.org/A9", value: "x" },
  "cur-own-old": { id: "cur-own-old", user_id: "U1", status: "timed_out", entity: "works", entity_id: "https://openalex.org/W5", value: "https://openalex.org/A1" },
  "cur-own-superseded": { id: "cur-own-superseded", user_id: "U1", status: "superseded", entity: "works", entity_id: "https://openalex.org/W6", value: "https://openalex.org/A1" },
  "cur-own-applied": { id: "cur-own-applied", user_id: "U1", status: "applied", entity: "works", entity_id: "https://openalex.org/W4", value: "https://openalex.org/A1" },
};

async function connect() {
  const users: any = {
    me: vi.fn(async () => ({ id: "U1", email: "u@example.org", display_name: "U", author_id: "https://openalex.org/A1",
      claim: { id: "c1", author_id: "A1", decision: "approved", approved_at: "2026-01-01T00:00:00Z" } })),
    getCuration: vi.fn(async (id: string) => {
      if (!ROWS[id]) throw new UsersApiError(`Curation ${id} not found.`, 404);
      return ROWS[id];
    }),
    deleteCuration: vi.fn(async (id: string) => ({ deleted: true, id })),
    createCurations: vi.fn(),
  };
  const client: any = { creditsUsed: 0, budgetNote: () => null, get: vi.fn(), post: vi.fn() };
  const server = createServer({ client, users, account: { userId: "U1", keyKind: "personal", usersApiReady: true }, features: {} });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), mcp.connect(b)]);
  return { mcp, users };
}

const cancel = async (mcp: Client, curation_id: string) => {
  const r: any = await mcp.callTool({ name: "submit_curations", arguments: { items: [{ action: "cancel", curation_id }] } });
  return JSON.parse(r.content[0].text).results[0];
};

describe("submit_curations cancel", () => {
  it("deletes the user's own pending curations on the claimed profile", async () => {
    const { mcp, users } = await connect();
    expect(await cancel(mcp, "cur-own")).toMatchObject({ status: "cancelled", deleted: true });
    expect(await cancel(mcp, "cur-own-name")).toMatchObject({ status: "cancelled" });
    // pending for over 7 days: users-api shows it as timed_out, but it is still unapplied
    expect(await cancel(mcp, "cur-own-old")).toMatchObject({ status: "cancelled" });
    expect(users.deleteCuration.mock.calls.map((c: any) => c[0])).toEqual(["cur-own", "cur-own-name", "cur-own-old"]);
  });

  it("refuses anyone else's, a finished one, one on another profile, or an unknown id, with no DELETE", async () => {
    const { mcp, users } = await connect();
    expect(await cancel(mcp, "cur-foreign")).toMatchObject({ status: "error", error: expect.stringMatching(/not one of yours/) });
    expect(await cancel(mcp, "cur-foreign-pending")).toMatchObject({ status: "error", error: expect.stringMatching(/not one of yours/) });
    expect(await cancel(mcp, "cur-own-applied")).toMatchObject({ status: "error", error: expect.stringMatching(/applied, not pending/) });
    expect(await cancel(mcp, "cur-own-superseded")).toMatchObject({ status: "error", error: expect.stringMatching(/superseded, not pending/) });
    expect(await cancel(mcp, "cur-own-other")).toMatchObject({ status: "error", error: expect.stringMatching(/not on your claimed profile A1/) });
    expect(await cancel(mcp, "cur-missing")).toMatchObject({ status: "error", error: expect.stringMatching(/not found/) });
    expect(users.deleteCuration).not.toHaveBeenCalled();
  });
});
