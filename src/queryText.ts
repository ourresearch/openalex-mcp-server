/**
 * openalex-query-writer (oxjob #1494): plain words to OQL, served as api.openalex.org/query/text. The Worker's entry
 * is src/queryWriter.ts (an entry module may export only handlers, so the logic and its constants live here).
 *
 * This Worker has no public route. The API proxy (openalex-api-proxy) lets a question in when the caller has any
 * budget left (one credit), calls this over a service binding, and charges the X-Credits-Cost this returns on an
 * answer: what the model and the confidence check cost us, in credits (10,000 = $1). Errors are free, as everywhere
 * in the API, and a question that costs more than the caller had left is absorbed (Jason, 2026-10-11). The searches
 * the agent runs go out on the caller's own key and are charged by the proxy like any other call.
 *
 *   GET  /query/text/<question>
 *   POST /query/text   {"text": "...", "current_query": "<OQL the page shows>", "institution": {"id": "I...", "name": "..."}}
 *
 * 200: {text, route, oql, sort, note, confidence, count, preview, meta: {path, model, effort, turns, elapsed_ms, cost}}
 *   route "title" / "search_string": a pasted title or a Boolean search string, answered with no model (frontDoor.ts)
 *   route "help_desk": a how-to with no subject, answered from help.openalex.org: {answer, link}, oql null (router.ts)
 *   route "query": the agent's query, plus left_out (a second question left out), out_of_reach and howto when they apply
 * 422: no query found; 400: a bad request; 502: the model failed. The proxy charges none of these (errors are free).
 *
 * The front door (Jason, 2026-10-11): deterministic pass, then the router, then the help desk or the agent. The agent
 * is chat.ts's: Claude Opus 5.5 at xhigh effort with #1555's one-page guide, whose searches may use only the person's
 * own words (searchWords.ts). The confidence is Jev's probability that the result answers the question (its verifier
 * agreed with #1494's judge at AUROC 0.76-0.84).
 */
import Anthropic from "@anthropic-ai/sdk";
import { CHAT_EFFORT, CHAT_MODEL, runChat, runOql, type ChatEvent, type Institution, type Preview } from "./chat";
import { frontDoor } from "./frontDoor";
import { HELP_EFFORT, HELP_MODEL, helpDesk, routeQuestion, type RouteResult } from "./router";
import { OpenAlexClient } from "./openalex";

export interface QueryWriterEnv {
  ENVIRONMENT?: string;
  OPENALEX_API_BASE: string;
  ANTHROPIC_API_KEY?: string;
  TYPESAFE_API_KEY?: string;
}

export const MAX_TEXT_CHARS = 2000;
export const JEV_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-1.13.0";
export const JEV_USD_PER_INPUT_TOKEN = 0.042 / 1e6;

const VERIFY_INSTRUCTIONS =
  "The assistant's query result answers the question as the person meant it: right set of works or things, right measure, nothing central missing or wrongly restricted.";

export interface QueryTextRequest { text: string; currentQuery: string | null; institution: Institution | null }

/** Read a /query/text request, or say why it won't do (status 400/404/405). */
export async function parseRequest(req: Request): Promise<QueryTextRequest | { status: number; error: string }> {
  const url = new URL(req.url);
  const m = url.pathname.match(/^\/query\/text(?:\/(.*))?$/i);
  if (!m) return { status: 404, error: "Not found. Use /query/text." };
  let text = "";
  let currentQuery: string | null = null;
  let institution: Institution | null = null;
  if (req.method === "GET") {
    try {
      text = m[1] ? decodeURIComponent(m[1]) : (url.searchParams.get("text") ?? "");
    } catch {
      return { status: 400, error: "The question in the URL isn't valid percent-encoding." };
    }
    currentQuery = url.searchParams.get("current_query");
  } else if (req.method === "POST") {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return { status: 400, error: "The body must be JSON: {\"text\": \"your question\"}." };
    }
    text = typeof body?.text === "string" ? body.text : "";
    currentQuery = typeof body?.current_query === "string" && body.current_query.trim() ? body.current_query : null;
    if (body?.institution && typeof body.institution.id === "string") {
      institution = { id: body.institution.id, name: String(body.institution.name ?? body.institution.id) };
    }
  } else {
    return { status: 405, error: "Use GET /query/text/<question> or POST /query/text." };
  }
  text = text.trim();
  if (!text) return { status: 400, error: "Say what you're looking for: GET /query/text/<question> or POST {\"text\": \"...\"}." };
  if (text.length > MAX_TEXT_CHARS) return { status: 400, error: `The question is too long (${text.length} characters; ${MAX_TEXT_CHARS} at most).` };
  return { text, currentQuery, institution };
}

/** The caller's OpenAlex key, as the proxy passed it on (Authorization header, or the api_key parameter). */
export function callerKey(req: Request): string | null {
  const auth = req.headers.get("Authorization") ?? "";
  const bearer = auth.replace(/^Bearer\s+/i, "").trim();
  if (bearer && bearer !== auth) return bearer;
  return new URL(req.url).searchParams.get("api_key");
}

/** Jev's probability that the result answers the question; null when Jev is unavailable. Never throws. */
export async function confidence(
  apiKey: string | undefined, question: string, answer: { oql: string; sort: string | null; note: string; preview: Preview },
  fetchImpl: typeof fetch = fetch,
): Promise<{ p: number | null; costUsd: number }> {
  if (!apiKey) return { p: null, costUsd: 0 };
  const { top_groups, top_rows, summary_all, count } = answer.preview;
  const state = {
    question, assistant_query: answer.oql, sort: answer.sort, assistant_note: answer.note,
    result_preview: { count, top_groups, top_rows, summary_all },
  };
  try {
    const res = await fetchImpl(JEV_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: JEV_MODEL, state, questions: { answers: { type: "noul", instructions: VERIFY_INSTRUCTIONS } } }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { p: null, costUsd: 0 };
    const d: any = await res.json();
    const p = d?.answers?.answers?.noul;
    const tokens = Number(d?.usage?.input_tokens ?? 0);
    return { p: typeof p === "number" ? Math.round(p * 1000) / 1000 : null, costUsd: tokens * JEV_USD_PER_INPUT_TOKEN };
  } catch {
    return { p: null, costUsd: 0 };
  }
}

/** Credits for a cost in dollars, rounded up (10,000 credits = $1). */
export const creditsFor = (usd: number) => Math.max(0, Math.ceil(usd * 10000));

/** A response's meta.cost: credits charged and dollars spent. */
const costOf = (usd: number) => ({ credits: creditsFor(usd), usd: Math.round(usd * 1e6) / 1e6 });

function reply(status: number, body: Record<string, any>, credits: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "X-Credits-Cost": String(credits) },
  });
}

/** One question to one answer. Exported for tests; the deps default to the real clients. */
export async function handle(
  req: Request, env: QueryWriterEnv,
  deps: { anthropic?: any; openalex?: any; fetchImpl?: typeof fetch; guide?: string; route?: (text: string, currentQuery: string | null) => Promise<RouteResult> } = {},
): Promise<Response> {
  const started = Date.now();
  const parsed = await parseRequest(req);
  if ("error" in parsed) return reply(parsed.status, { error: parsed.error }, 0);
  const key = callerKey(req);
  if (!key) return reply(401, { error: "Send your OpenAlex API key as \"Authorization: Bearer YOUR_KEY\"." }, 0);
  if (!env.ANTHROPIC_API_KEY && !deps.anthropic) return reply(503, { error: "The query writer isn't configured." }, 0);

  const anthropic = deps.anthropic ?? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const openalex = deps.openalex ?? new OpenAlexClient({ apiKey: key, baseUrl: env.OPENALEX_API_BASE, keyLabel: "your OpenAlex key" });

  // Before any model: a pasted title a lookup confirms, or a Boolean search string, runs as typed (frontDoor.ts).
  // No model, so no model cost; the searches themselves are charged by the proxy like any call.
  const door = await frontDoor(parsed.text, (q) => runOql(openalex, q));
  if (door.path !== "model") {
    return reply(200, {
      text: parsed.text, route: door.path, oql: door.oql, sort: null, note: door.note, confidence: null, count: door.preview.count ?? null,
      preview: door.preview,
      meta: { path: door.path, model: null, effort: null, turns: 0, elapsed_ms: Date.now() - started, cost: { credits: 0, usd: 0 } },
    }, 0);
  }

  // The router: a how-to with no subject goes to the help desk (an answer from help.openalex.org with a link, no
  // query); anything else, or a help desk that fails, goes on to the OQL agent.
  const routed = deps.route ? await deps.route(parsed.text, parsed.currentQuery) : await routeQuestion(anthropic, parsed.text, parsed.currentQuery);
  let preUsd = routed.costUsd;
  if (routed.route === "help_desk") {
    const help = await helpDesk(anthropic, parsed.text, deps.fetchImpl ?? fetch);
    preUsd += help.costUsd;
    if (help.text) {
      const cost = costOf(preUsd);
      return reply(200, {
        text: parsed.text, route: "help_desk", answer: help.text, link: help.link || null, oql: null, sort: null, note: null,
        confidence: null, count: null, preview: null,
        meta: { path: "help_desk", model: HELP_MODEL, effort: HELP_EFFORT, turns: help.turns, elapsed_ms: Date.now() - started, cost },
      }, cost.credits);
    }
  }

  let answer: Extract<ChatEvent, { type: "answer" }> | null = null;
  let error: string | null = null;
  let turns = 0;
  let wordRetries = 0;
  const out = await runChat({ anthropic, openalex, guide: deps.guide }, {
    messages: [{ role: "user", content: parsed.text }],
    currentQuery: parsed.currentQuery,
    institution: parsed.institution,
  }, (e) => {
    if (e.type === "answer") answer = e;
    else if (e.type === "error" && !error) error = e.message;
    else if (e.type === "done") ({ turns, word_retries: wordRetries } = e);
  });

  const conf = answer
    ? await confidence(env.TYPESAFE_API_KEY, parsed.text, answer, deps.fetchImpl ?? fetch)
    : { p: null, costUsd: 0 };
  const a = answer as Extract<ChatEvent, { type: "answer" }> | null;
  const cost = costOf(preUsd + out.cost_usd + conf.costUsd);
  const meta = {
    path: "model", tried: routed.route === "help_desk" ? [...door.tried, "help_desk"] : door.tried,
    model: CHAT_MODEL, effort: CHAT_EFFORT, turns, elapsed_ms: Date.now() - started, cost,
    // the no-new-words check: submits refused for new search words, and any left when the turns ran out
    word_retries: wordRetries, new_words: a?.new_words ?? [],
  };
  if (!a) {
    const modelFailed = (error ?? "").startsWith("The model call failed");
    return reply(modelFailed ? 502 : 422, { text: parsed.text, error: error ?? "No query found.", meta }, cost.credits);
  }
  return reply(200, {
    text: parsed.text,
    route: "query",
    oql: a.oql,
    sort: a.sort,
    note: a.note,
    // two questions in one: the one left out; what one query can't answer; a line of how-to when they asked how
    left_out: a.left_out,
    out_of_reach: a.out_of_reach,
    howto: a.howto,
    confidence: conf.p,
    count: a.preview.count ?? null,
    preview: a.preview,
    meta,
  }, cost.credits);
}

