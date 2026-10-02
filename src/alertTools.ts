/**
 * Alert tools (oxjob #1509): an agent sets, lists, changes and deletes the user's email alerts for
 * new works, on users-api's /me/saved-searches (help.openalex.org/api/alerts). An alert is part of a
 * saved search; these tools speak "alerts" because that is what users ask for.
 * Gated by the ALERT_TOOLS var: off in production until users-api ships the route and the ChatGPT
 * plugin review is through (#1294).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { OpenAlexClient } from "./openalex";
import { UsersApiClient, UsersApiError } from "./users";
import { compact } from "./shape";
import { reproduceUrl } from "./oql";
import type { AccountContext } from "./curationTools";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export interface AlertDeps {
  client: OpenAlexClient;
  users: UsersApiClient | null;
  account: AccountContext | null;
  run: (tool: string, body: () => Promise<ToolResult>) => () => Promise<ToolResult>;
  ok: (payload: Record<string, any>) => ToolResult;
  fail: (message: string) => ToolResult;
}

/** Bounded to the user's own account (OpenAI plugin rules, #1294). */
const READ_OWN = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const WRITE_OWN = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;
const DELETE_OWN = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false } as const;

const RECONNECT = "This connection cannot reach OpenAlex accounts: it runs on an organization key. Ask the user to reconnect the OpenAlex connector (disconnect and connect again), then retry.";
const FREQUENCIES = ["daily", "weekly", "monthly"] as const;
const SAMPLE = 5;

export const ALERT_TOOL_LINES = `- list_my_alerts / create_alert / update_alert / delete_alert: the user's email alerts for new works matching a search ("email me every week when new papers on X come out"). Build and check the search with search_works first, then create_alert(oql=<its OQL>). Only works searches can alert, and not a search limited to a collection of works (a fixed list).`;

/** The saved search as the tools return it: what an agent needs, nothing it doesn't. */
export function shapeAlert(s: any) {
  return compact({
    id: s.id,
    name: s.name,
    frequency: s.alert?.frequency ?? "off",
    last_sent_at: s.alert?.last_sent_at ?? undefined,
    next_check_at: s.alert?.next_check_at ?? undefined,
    url: s.url,
    api_url: s.api_url,
    cannot_alert: s.cannot_alert ?? undefined,
  });
}

/** users-api errors carry a stable `code`; hand it to the agent with the message. */
function explain(e: unknown): Error {
  if (e instanceof UsersApiError) {
    const code = e.body?.code;
    const extra = e.body?.existing_id ? ` (existing id: ${e.body.existing_id})` : "";
    return new UsersApiError(code ? `${code}: ${e.message}${extra}` : e.message, e.status, e.body);
  }
  return e as Error;
}

export function registerAlertTools(server: McpServer, deps: AlertDeps) {
  const { client, run, ok } = deps;

  const users = (): UsersApiClient => {
    if (!deps.users || !deps.account?.usersApiReady) throw new UsersApiError(RECONNECT, 0);
    return deps.users;
  };
  const call = async <T>(f: () => Promise<T>): Promise<T> => {
    try {
      return await f();
    } catch (e) {
      throw explain(e);
    }
  };

  /** The newest works the search matches today, so the agent can show what will arrive. */
  const sample = async (apiUrl: string) => {
    const u = new URL(apiUrl);
    const params: Record<string, string> = Object.fromEntries(u.searchParams.entries());
    const view = { per_page: String(SAMPLE), sort: "publication_date:desc", select: "id,display_name,publication_date" };
    const d: any = params.oql !== undefined
      ? await client.post({ oql: params.oql, ...view, per_page: SAMPLE })
      : await client.get(u.pathname, { ...params, ...view });
    return {
      matching_works_today: d?.meta?.count ?? null,
      newest: (d?.results ?? []).map((w: any) => `${w.display_name ?? "(untitled)"}${w.publication_date ? ` (${w.publication_date})` : ""}`),
    };
  };

  // -------------------------------------------------------------------------
  // list_my_alerts
  // -------------------------------------------------------------------------
  server.registerTool(
    "list_my_alerts",
    {
      title: "List my alerts",
      description:
        "The user's email alerts: each saved search that emails new matching works, with its frequency, when it last sent and when it next checks. " +
        "Set include_saved_searches to also list saved searches with no alert. Use it to answer \"what alerts do I have?\" or to find an id to change or delete.",
      inputSchema: {
        include_saved_searches: z.boolean().optional().describe("Also list saved searches that have no alert. Default false."),
        page: z.number().int().min(1).max(100).optional(),
      },
      annotations: { title: "List my alerts", ...READ_OWN },
    },
    async (args) =>
      run("list_my_alerts", () => call(async () => {
        const data = await users().listSavedSearches({
          has_alert: args.include_saved_searches ? undefined : "true",
          per_page: 100,
          page: args.page ?? 1,
        });
        return ok({ total: data.meta.count, page: data.meta.page, results: data.results.map(shapeAlert) });
      }))()
  );

  // -------------------------------------------------------------------------
  // create_alert
  // -------------------------------------------------------------------------
  server.registerTool(
    "create_alert",
    {
      title: "Create an alert",
      description:
        "Email the user new works that match a search, daily, weekly or monthly (saved as a saved search with an alert, visible on openalex.org under My alerts). " +
        "Build the search with search_works first and pass its OQL (or an api.openalex.org works URL). The first email covers works added from now on, and an email goes out only when there are new works. " +
        "Returns the alert and the newest works the search matches today: show the user a few so they know what will arrive. " +
        "Refusals come back with a code: works_collection_cannot_alert, collection_type_mismatch (the message names the right field), semantic_search_cannot_alert, search_is_empty, alert_requires_works_search, collection_not_found, saved_search_exists (the user already saved this search, maybe without an alert: turn it on with update_alert on the existing id).",
      inputSchema: {
        name: z.string().min(1).max(400).describe("What the user asked for, in their words; it is the email's subject line."),
        oql: z.string().min(1).max(8000).optional().describe("The search as OQL, e.g. the oql search_works returned. Give oql or url."),
        url: z.string().min(1).max(8000).optional().describe("Or the search as an api.openalex.org/works?filter=… URL."),
        frequency: z.enum(FREQUENCIES).optional().describe("How often to email. Default weekly."),
      },
      annotations: { title: "Create an alert", ...WRITE_OWN },
    },
    async (args) =>
      run("create_alert", () => call(async () => {
        if (!args.oql === !args.url) throw new Error("Give exactly one of oql or url.");
        const url = args.oql ? reproduceUrl(args.oql)! : args.url!;
        const created = await users().createSavedSearch({ name: args.name, url, alert: { frequency: args.frequency ?? "weekly" } });
        let preview: Record<string, any> = {};
        try {
          preview = await sample(created.api_url);
        } catch {
          /* the alert exists; a failed preview shouldn't hide that */
        }
        return ok({ alert: shapeAlert(created), ...preview });
      }))()
  );

  // -------------------------------------------------------------------------
  // update_alert
  // -------------------------------------------------------------------------
  server.registerTool(
    "update_alert",
    {
      title: "Change an alert",
      description:
        "Change one of the user's alerts: how often it emails (daily, weekly, monthly), or \"off\" to stop the emails but keep the saved search; or rename it. " +
        "Turning an alert back on for a saved search also uses this. Ids come from list_my_alerts.",
      inputSchema: {
        id: z.string().min(1).max(64).describe("The alert's id, from list_my_alerts or create_alert."),
        frequency: z.enum([...FREQUENCIES, "off"]).optional(),
        name: z.string().min(1).max(400).optional(),
      },
      annotations: { title: "Change an alert", ...WRITE_OWN },
    },
    async (args) =>
      run("update_alert", () => call(async () => {
        const body: Record<string, any> = {};
        if (args.name !== undefined) body.name = args.name;
        if (args.frequency !== undefined) body.alert = args.frequency === "off" ? null : { frequency: args.frequency };
        if (!Object.keys(body).length) throw new Error("Nothing to change: give frequency or name.");
        const updated = await users().updateSavedSearch(args.id, body);
        return ok({ alert: shapeAlert(updated) });
      }))()
  );

  // -------------------------------------------------------------------------
  // delete_alert
  // -------------------------------------------------------------------------
  server.registerTool(
    "delete_alert",
    {
      title: "Delete an alert",
      description:
        "Delete one of the user's alerts together with its saved search. To stop the emails but keep the saved search, use update_alert with frequency \"off\" instead. Confirm with the user first.",
      inputSchema: {
        id: z.string().min(1).max(64).describe("The alert's id, from list_my_alerts."),
      },
      annotations: { title: "Delete an alert", ...DELETE_OWN },
    },
    async (args) =>
      run("delete_alert", () => call(async () => {
        await users().deleteSavedSearch(args.id);
        return ok({ deleted: args.id });
      }))()
  );
}
