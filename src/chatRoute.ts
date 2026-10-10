/**
 * POST /chat: the openalex.org results-page chat panel (oxjob #1494). Served ahead of the OAuth provider (the panel
 * authenticates with the person's own OpenAlex API key, which openalex.org already holds), streamed as server-sent
 * events so the page can show progress while the agent works (median 9 s, slow tail about 25 s).
 *
 * Off unless CHAT_ENABLED=true. Needs the ANTHROPIC_API_KEY secret.
 * Not built yet (waits on Jason's look at the design, #1494 EXPLORE.md § 13): charging the model's cost to the
 * person's credits. Today the OpenAlex calls the agent makes are charged as usual; the model cost is logged only.
 *
 * Request: { messages: MessageParam[] (the conversation, as the last `done` event returned it, plus the new user
 *            turn), current_query?: string, institution?: {id, name} }
 * Events:  step {tool, detail} ... answer {oql, sort, note, preview} ... done {messages, cost_usd, usage, turns};
 *          or error {message}.
 */
import Anthropic from "@anthropic-ai/sdk";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { runChat, type ChatEvent } from "./chat";
import { OpenAlexClient, OpenAlexError } from "./openalex";

export interface ChatEnv {
  ENVIRONMENT: string;
  OPENALEX_API_BASE: string;
  CHAT_ENABLED?: string;
  /** Comma-separated origins allowed to call /chat. */
  CHAT_ORIGINS?: string;
  ANTHROPIC_API_KEY?: string;
  ANALYTICS?: AnalyticsEngineDataset;
}

const DEFAULT_ORIGINS = "https://openalex.org,https://www.openalex.org,http://localhost:8080";
/** Refuse a new question when the key can't cover a typical one (about $0.03 of model time plus its searches). */
export const MIN_BUDGET_USD = 0.05;
/** A conversation longer than this is a new conversation. */
export const MAX_MESSAGES = 60;

export const chatApp = new Hono<{ Bindings: ChatEnv }>();

chatApp.use("/chat", (c, next) =>
  cors({
    origin: (origin) => ((c.env.CHAT_ORIGINS ?? DEFAULT_ORIGINS).split(",").map((s) => s.trim()).includes(origin) ? origin : null),
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["POST", "OPTIONS"],
    maxAge: 600,
  })(c, next)
);

chatApp.post("/chat", async (c) => {
  const env = c.env;
  if (env.CHAT_ENABLED !== "true") return c.json({ error: "Not found." }, 404);
  if (!env.ANTHROPIC_API_KEY) return c.json({ error: "The chat assistant isn't configured on this server." }, 503);
  const auth = c.req.header("Authorization") ?? "";
  const apiKey = auth.replace(/^Bearer\s+/i, "").trim();
  if (!apiKey || apiKey === auth) return c.json({ error: "Send your OpenAlex API key as `Authorization: Bearer <key>`." }, 401);

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "The body must be JSON." }, 400);
  }
  const problem = validateBody(body);
  if (problem) return c.json({ error: problem }, 400);

  const openalex = new OpenAlexClient({ apiKey, baseUrl: env.OPENALEX_API_BASE, keyLabel: "your OpenAlex key" });
  // Check the key and its budget before any model spend. /rate-limit is free.
  try {
    const rl: any = await openalex.get("/rate-limit");
    const r = rl?.rate_limit ?? {};
    const left = Number(r.daily_remaining_usd ?? 0) + Number(r.prepaid_remaining_usd ?? 0);
    if (left < MIN_BUDGET_USD) {
      return c.json({ error: `Your OpenAlex budget for today is used up ($${left.toFixed(2)} left). It resets at midnight UTC; more at https://openalex.org/pricing.` }, 402);
    }
  } catch (e) {
    const status = e instanceof OpenAlexError && (e.status === 401 || e.status === 403) ? 401 : 502;
    return c.json({ error: status === 401 ? "OpenAlex didn't accept this API key." : `Couldn't check your OpenAlex budget: ${(e as Error).message}` }, status);
  }

  const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const started = Date.now();
  return streamSSE(c, async (stream) => {
    const send = async (e: ChatEvent) => {
      await stream.writeSSE({ event: e.type, data: JSON.stringify(e) });
    };
    const out = await runChat({ anthropic, openalex }, {
      messages: body.messages,
      currentQuery: typeof body.current_query === "string" ? body.current_query : null,
      institution: body.institution && typeof body.institution.id === "string" ? { id: body.institution.id, name: String(body.institution.name ?? body.institution.id) } : null,
    }, send);
    try {
      env.ANALYTICS?.writeDataPoint({
        indexes: ["chat"],
        blobs: ["chat", out.answered ? "ok" : "no_answer", env.ENVIRONMENT],
        doubles: [Date.now() - started, out.cost_usd, openalex.creditsUsed],
      });
    } catch {
      /* metrics are best-effort */
    }
  });
});

/** A short reason the body won't do, or null. */
export function validateBody(body: any): string | null {
  if (!body || typeof body !== "object") return "The body must be a JSON object.";
  const m = body.messages;
  if (!Array.isArray(m) || !m.length) return "`messages` must be a non-empty array.";
  if (m.length > MAX_MESSAGES) return `This conversation is too long (${m.length} messages); start a new one.`;
  for (const x of m) {
    if (!x || (x.role !== "user" && x.role !== "assistant")) return "Each message needs a role of user or assistant.";
    if (typeof x.content !== "string" && !Array.isArray(x.content)) return "Each message needs content.";
  }
  if (m[m.length - 1].role !== "user") return "The last message must be the person's question.";
  return null;
}
