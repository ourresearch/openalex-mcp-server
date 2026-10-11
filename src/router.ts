/**
 * The query writer's router and help desk (oxjob #1494, Jason 2026-10-11). Before the OQL agent, one small model call
 * sorts the message: a how-to with no subject ("how do I find seminal literature?") goes to the help desk, which
 * answers from help.openalex.org with a link and no query; everything else is a data question for the agent. The agent
 * itself handles what only it can judge: two questions in one (answer the first, name the one left out), what's out of
 * reach (say so, offer the nearest query), and a how-to with a real subject (the query plus one line of how-to).
 */
import { priceOf, type AnthropicLike } from "./chat";

// Haiku: on #1494's router check (2026-10-11, tune half) it kept the most data questions on the query path (97-100%)
// and sent 82% of #1618's how-tos to the help desk, at $0.00004 and 1.2 s (Sonnet: 93% / 94-95%; Opus low: 87% / 97%).
export const ROUTER_MODEL = "claude-haiku-5-5";
export const ROUTER_EFFORT: string | null = "high";
export const HELP_MODEL = "claude-opus-5-5";
export const HELP_EFFORT = "high";
const HELP_SITE = "https://help.openalex.org";
const HELP_MAX_TURNS = 4;

export const ROUTER_PROMPT = `You sort what people type into the chat panel beside OpenAlex's search results. OpenAlex is an open catalog of the world's scholarly works and the authors, institutions, journals, funders and topics behind them. The panel answers a data question by writing a query that sets the results page; it answers a help-desk question from OpenAlex's help site.

route:
- "help_desk": the person asks how to do something with OpenAlex, or about OpenAlex itself, and names no specific subject to look up. Examples: "how do I find seminal literature?", "how do I fix my author profile?", "does the API support full-text search?", "what does FWCI mean?", "how much does the API cost?", "can I group by month in the API?". Also messages that aren't a request for scholarly data at all.
- "data": the person wants works, counts, lists, rankings or breakdowns about something real: a topic, a person, an institution, a journal, a country, a paper. This includes how-to questions that name a real subject ("how do I find papers citing Attention Is All You Need?", "how can I see which journals my university publishes in?"), search strings, pasted titles, names and bare topic words.
When unsure, choose "data".`;

const ROUTE_SCHEMA = {
  type: "object",
  properties: { route: { type: "string", enum: ["help_desk", "data"] } },
  required: ["route"],
  additionalProperties: false,
};

export interface RouteResult { route: "help_desk" | "data"; costUsd: number; error?: string }

/** Help desk or data. Never throws: a failed call routes to data (the agent can still answer). */
export async function routeQuestion(
  anthropic: AnthropicLike, text: string, currentQuery?: string | null, model = ROUTER_MODEL, effort: string | null = ROUTER_EFFORT,
): Promise<RouteResult> {
  const content = currentQuery ? `${text}\n\n(The results page currently shows this query: ${currentQuery})` : text;
  try {
    const res: any = await anthropic.messages.create({
      model, max_tokens: 4000,
      system: [{ type: "text", text: ROUTER_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content }],
      output_config: { ...(effort ? { effort } : {}), format: { type: "json_schema", schema: ROUTE_SCHEMA } },
    } as any);
    const costUsd = priceOf(model, res.usage ?? {});
    const txt = (res.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    const route = JSON.parse(txt).route === "help_desk" ? "help_desk" : "data";
    return { route, costUsd };
  } catch (e: any) {
    return { route: "data", costUsd: 0, error: e?.message ?? String(e) };
  }
}

const HELP_PROMPT = `You answer how-to questions about OpenAlex in the chat panel beside its search results, from OpenAlex's help site only. Read the page that covers the question (read_help_page), then call answer with:
- text: at most 80 words, plain and direct: what to do, in the order to do it. Say only what the help page supports; if it doesn't cover the question, say so and point to the closest page or to support.
- link: the help page's URL (https://help.openalex.org/...), the one that covers it best.
The person can't see the help page unless you link it. Don't write OpenAlex queries.

The help site's index (every page, with its markdown copy) follows.

`;

const HELP_TOOLS = [
  {
    name: "read_help_page",
    description: "Read one help.openalex.org page as markdown (pass its URL; the .md copy is fetched).",
    input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  {
    name: "answer",
    description: "Answer the person: a short how-to and the help page it comes from. Call once, last.",
    input_schema: { type: "object", properties: { text: { type: "string" }, link: { type: "string" } }, required: ["text", "link"] },
  },
];

let indexCache: { text: Promise<string>; at: number } | null = null;

/**
 * help.openalex.org/llms.txt (every page with a one-line summary), cached for an hour per isolate. The cache holds the
 * fetch itself, so concurrent cold requests share one; a failed fetch is dropped from the cache.
 */
function helpIndex(fetchImpl: typeof fetch = fetch): Promise<string> {
  if (indexCache && Date.now() - indexCache.at < 3600_000) return indexCache.text;
  const text = (async () => {
    const res = await fetchImpl(`${HELP_SITE}/llms.txt`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`help index: HTTP ${res.status}`);
    return res.text();
  })();
  indexCache = { text, at: Date.now() };
  text.catch(() => { if (indexCache?.text === text) indexCache = null; });
  return text;
}

/** One help page as markdown; only help.openalex.org pages. */
async function readHelpPage(url: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  let u: URL;
  try {
    u = new URL(url, HELP_SITE);
  } catch {
    return "Not a URL.";
  }
  if (u.hostname !== "help.openalex.org") return "Only help.openalex.org pages can be read.";
  const path = u.pathname.replace(/\/$/, "");
  const md = `${HELP_SITE}${path.endsWith(".md") ? path : (path || "/index") + ".md"}`;
  try {
    const res = await fetchImpl(md, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return `HTTP ${res.status} for ${md}`;
    return (await res.text()).slice(0, 24000);
  } catch (e: any) {
    return `Couldn't read ${md}: ${e?.message ?? e}`;
  }
}

export interface HelpAnswer { text: string; link: string; costUsd: number; turns: number; error?: string }

/**
 * Answer a how-to from the help site. Never throws: failures come back in `error` with no text.
 * Shortcut: a second hand-written tool loop beside chat.ts runChat (they force the last turn differently); extract a
 * shared loop if a third appears.
 */
export async function helpDesk(anthropic: AnthropicLike, question: string, fetchImpl: typeof fetch = fetch): Promise<HelpAnswer> {
  let costUsd = 0;
  const fail = (error: string, turns: number): HelpAnswer => ({ text: "", link: "", costUsd, turns, error });
  let index: string;
  try {
    index = await helpIndex(fetchImpl);
  } catch (e: any) {
    return fail(e?.message ?? String(e), 0);
  }
  const messages: any[] = [{ role: "user", content: question }];
  for (let turn = 0; turn < HELP_MAX_TURNS; turn++) {
    let res: any;
    try {
      res = await anthropic.messages.create({
        model: HELP_MODEL, max_tokens: 8000,
        system: [{ type: "text", text: HELP_PROMPT + index, cache_control: { type: "ephemeral" } }],
        tools: HELP_TOOLS as any,
        tool_choice: turn === HELP_MAX_TURNS - 1 ? { type: "tool", name: "answer" } : { type: "auto" },
        messages,
        output_config: { effort: HELP_EFFORT },
      } as any);
    } catch (e: any) {
      return fail(`The model call failed: ${e?.message ?? e}`, turn);
    }
    costUsd += priceOf(HELP_MODEL, res.usage ?? {});
    messages.push({ role: "assistant", content: res.content });
    const uses = (res.content ?? []).filter((b: any) => b.type === "tool_use");
    const done = uses.find((b: any) => b.name === "answer");
    if (done) return { text: String(done.input?.text ?? ""), link: String(done.input?.link ?? ""), costUsd, turns: turn + 1 };
    if (!uses.length) return fail("The help desk stopped without an answer.", turn + 1);
    // pages asked for in one turn are read together
    const results = await Promise.all(uses.map(async (b: any) =>
      ({ type: "tool_result", tool_use_id: b.id, content: await readHelpPage(String(b.input?.url ?? ""), fetchImpl) })));
    messages.push({ role: "user", content: results });
  }
  return fail("The help desk ran out of steps.", HELP_MAX_TURNS);
}
