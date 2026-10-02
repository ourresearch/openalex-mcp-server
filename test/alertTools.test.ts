import { describe, it, expect, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, serverInstructions } from "../src/server";
import { UsersApiError } from "../src/users";

// oxjob #1509: the alert tools, end to end through an MCP client, with users-api and the
// OpenAlex API faked.

const SAVED = {
  id: "ss1", name: "Microplastics", description: "", entity_type: "works",
  url: "https://openalex.org/q?oql=works%20where%20title%20has%20(coral)&id=ss1",
  api_url: "https://api.openalex.org/?oql=works%20where%20title%20has%20(coral)",
  alert: { frequency: "weekly", last_sent_at: null, next_check_at: "2026-10-09T12:00:00Z" },
  cannot_alert: null, created_at: "2026-10-02T12:00:00Z", updated_at: "2026-10-02T12:00:00Z",
};

function fakes() {
  const users: any = {
    listSavedSearches: vi.fn(async () => ({ meta: { count: 1, page: 1, per_page: 100 }, results: [SAVED] })),
    createSavedSearch: vi.fn(async () => SAVED),
    updateSavedSearch: vi.fn(async (_id: string, body: any) => ({ ...SAVED, alert: body.alert === null ? null : { ...SAVED.alert, ...(body.alert ?? {}) }, name: body.name ?? SAVED.name })),
    deleteSavedSearch: vi.fn(async () => null),
  };
  const client: any = {
    creditsUsed: 0,
    budgetNote: () => null,
    post: vi.fn(async () => ({ meta: { count: 42 }, results: [{ display_name: "Coral bleaching 2026", publication_date: "2026-09-30" }] })),
    get: vi.fn(async () => ({ meta: { count: 7 }, results: [] })),
  };
  return { users, client };
}

async function connect(features: Record<string, boolean>, f = fakes(), usersApiReady = true) {
  const server = createServer({
    client: f.client, users: f.users,
    account: { userId: "user-1", keyKind: "personal", usersApiReady },
    features,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), mcp.connect(b)]);
  return { mcp, ...f };
}

const body = (r: any) => JSON.parse(r.content[0].text);

describe("alert tools", () => {
  it("are absent unless the flag is on, and so is their instructions line", async () => {
    const off = await connect({});
    const names = (await off.mcp.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("create_alert");
    expect(serverInstructions({})).not.toContain("create_alert");
    expect(serverInstructions({ alertTools: true })).toContain("create_alert");
    expect(serverInstructions({})).not.toContain("{{ALERT_TOOLS}}");
  });

  it("carry the annotations OpenAI checks", async () => {
    const { mcp } = await connect({ alertTools: true });
    const tools = Object.fromEntries((await mcp.listTools()).tools.map((t) => [t.name, t.annotations]));
    expect(tools.list_my_alerts).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(tools.create_alert).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
    expect(tools.update_alert).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
    expect(tools.delete_alert).toMatchObject({ destructiveHint: true, openWorldHint: false });
  });

  it("create_alert takes OQL, defaults to weekly, and shows the newest matches", async () => {
    const { mcp, users, client } = await connect({ alertTools: true });
    const r = await mcp.callTool({ name: "create_alert", arguments: { name: "Coral", oql: "works where title has (coral)" } });
    expect(r.isError).toBeFalsy();
    expect(users.createSavedSearch).toHaveBeenCalledWith({
      name: "Coral", url: "https://api.openalex.org/?oql=" + encodeURIComponent("works where title has (coral)"), alert: { frequency: "weekly" },
    });
    expect(client.post).toHaveBeenCalledWith(expect.objectContaining({ oql: "works where title has (coral)", sort: "publication_date:desc" }));
    const b = body(r);
    expect(b.alert).toMatchObject({ id: "ss1", frequency: "weekly" });
    expect(b.matching_works_today).toBe(42);
    expect(b.newest[0]).toContain("Coral bleaching");
  });

  it("create_alert needs exactly one of oql and url", async () => {
    const { mcp } = await connect({ alertTools: true });
    const r = await mcp.callTool({ name: "create_alert", arguments: { name: "x" } });
    expect(r.isError).toBe(true);
  });

  it("create_alert passes users-api's code (and existing id) to the agent", async () => {
    const f = fakes();
    f.users.createSavedSearch = vi.fn(async () => {
      throw new UsersApiError("You already saved this search as ss9.", 409, { code: "saved_search_exists", existing_id: "ss9" });
    });
    const { mcp } = await connect({ alertTools: true }, f);
    const r = await mcp.callTool({ name: "create_alert", arguments: { name: "x", url: "https://api.openalex.org/works?search=x" } });
    expect(r.isError).toBe(true);
    expect(body(r).error).toContain("saved_search_exists");
    expect(body(r).error).toContain("ss9");
  });

  it("update_alert: off sends alert null; frequency and name pass through", async () => {
    const { mcp, users } = await connect({ alertTools: true });
    let r = await mcp.callTool({ name: "update_alert", arguments: { id: "ss1", frequency: "off" } });
    expect(users.updateSavedSearch).toHaveBeenLastCalledWith("ss1", { alert: null });
    expect(body(r).alert.frequency).toBe("off");
    r = await mcp.callTool({ name: "update_alert", arguments: { id: "ss1", frequency: "monthly", name: "New" } });
    expect(users.updateSavedSearch).toHaveBeenLastCalledWith("ss1", { name: "New", alert: { frequency: "monthly" } });
    r = await mcp.callTool({ name: "update_alert", arguments: { id: "ss1" } });
    expect(r.isError).toBe(true);
  });

  it("list and delete", async () => {
    const { mcp, users } = await connect({ alertTools: true });
    const l = body(await mcp.callTool({ name: "list_my_alerts", arguments: {} }));
    expect(users.listSavedSearches).toHaveBeenCalledWith({ has_alert: "true", per_page: 100, page: 1 });
    expect(l.total).toBe(1);
    await mcp.callTool({ name: "list_my_alerts", arguments: { include_saved_searches: true } });
    expect(users.listSavedSearches).toHaveBeenLastCalledWith({ has_alert: undefined, per_page: 100, page: 1 });
    const d = body(await mcp.callTool({ name: "delete_alert", arguments: { id: "ss1" } }));
    expect(d).toEqual({ deleted: "ss1" });
  });

  it("an org-key connection is told to reconnect", async () => {
    const { mcp } = await connect({ alertTools: true }, fakes(), false);
    const r = await mcp.callTool({ name: "list_my_alerts", arguments: {} });
    expect(r.isError).toBe(true);
    expect(body(r).error).toContain("reconnect");
  });
});
