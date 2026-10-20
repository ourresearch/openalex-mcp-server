/**
 * The results-page chat agent (oxjob #1494): a person asks for literature in plain words; the agent answers with ONE
 * OQL query, which sets the openalex.org results page (results, facets, download) and shows at its top.
 *
 * Configuration chosen on oxjob #1494's harness (EXPLORE.md §§ 8-14): Claude Opus 5.5 at xhigh effort, the
 * "prompt v2" search rules below, and #1555's one-page OQL guide. Since 2026-10-20 (NL-search push) it writes the
 * get-only OQL natively (lists `get <works>, <order>`, tables `get the <numbers> of <works> by <splits>, <order>`)
 * from chat_guide.md = #1555's guide_v8.md adapted for this chat, and returns the API's canonical echo of what it
 * wrote. Every OpenAlex call runs on the person's own API key (their credits), as in the MCP tools.
 *
 * The browser keeps the conversation: it sends back `messages` exactly as returned, assistant turns included
 * (Opus 5.5 rejects edited history, so thinking blocks must round-trip untouched).
 */
import type Anthropic from "@anthropic-ai/sdk";
import { OpenAlexError } from "./openalex";
import { newWords, typedVocabulary } from "./searchWords";
import CHAT_GUIDE from "./chat_guide.md";

export const CHAT_MODEL = "claude-opus-5-5";
export const CHAT_EFFORT = "xhigh";
/** Model turns per question; the harness median was two tool calls before submit. */
export const MAX_TURNS = 8;
/** $/MTok (claude-api skill, cached 2026-10-06): input, output, cache read, cache write. */
const PRICES: Record<string, [number, number, number, number]> = {
  "claude-haiku-5-5": [0.1, 0.5, 0.01, 0.125],
  "claude-sonnet-5-5": [2.0, 10.0, 0.2, 2.5],
  "claude-opus-5-5": [4.0, 20.0, 0.2, 5.0],
};

/** What a call cost in dollars, from its usage (unknown models priced as Opus). */
export function priceOf(model: string, u: Partial<Usage>): number {
  const p = PRICES[model] ?? PRICES[CHAT_MODEL];
  return ((u.input_tokens ?? 0) * p[0] + (u.output_tokens ?? 0) * p[1] + (u.cache_read_input_tokens ?? 0) * p[2]
    + (u.cache_creation_input_tokens ?? 0) * p[3]) / 1e6;
}

const basePrompt = (year: number) => `You are the assistant in the chat panel beside OpenAlex's search results. People ask questions about the scholarly literature in plain words; you answer by writing ONE OQL query. The results page then shows that query's results (as a list, a table or a chart), and the query itself at the top in an editor, so anyone can read it, change it and rerun it. Write OQL as the plain-English sentences the guide below shows: a list, \`get <works>, <order>\`, or a table of groups, \`get the <numbers> of <works> by <splits>\`. Never write \`rank\` or \`break down\`: OpenAlex refuses them.

How to work:
1. Work out what the person wants back: a list of works or things, or a table of numbers (one number, or one row per group: per year, per country, per author ...).
2. Resolve every name (institution, author, journal, funder, publisher, topic) to its OpenAlex id with find_entity.
3. Write the query and try it with run_oql. Check the preview: does it look like the answer? Fix and retry if not.
4. Call submit with the query exactly as it ran and a note of at most 30 words telling the person what you assumed or what the query can't cover. Any order goes inside the query, after the last comma (\`, most cited first\`, \`, highest mean FWCI first\`); leave sort empty. Only a general-form query (the guide's last section) takes its order in sort: \`count:desc\`, \`mean FWCI:desc\`, \`cited_by_count:desc\`.

Be quick: the person is waiting, so most questions need one or two tool calls before submit. A follow-up that only edits the page's query (adds or drops a filter, changes the order, a number or a split, or swaps in a name you have the id for) can go straight to submit: submit runs it and tells you if it fails. Once a query runs and its preview fits the question, submit it. Write a search once, from the person's words; don't try wording variants (a stem, a wildcard, a phrase) to see which finds more. Look up several names in one turn when you need several.
- Two or more questions in one message ("which journals do we publish in, and what do they cite?"): answer the first with your query and name the rest in left_out, in a few words; the reply tells the person. One question with several conditions, fields or numbers is one question, and so is anything the same query also shows.
- Out of reach (OpenAlex doesn't hold it, or one query can't say it): submit the nearest useful query, and say plainly what's out of reach in out_of_reach, in a few words.
- When the person asks how to do it ("how do I find papers citing ..."), also give howto: one line on how they could do it themselves on OpenAlex.

Follow-ups: when the page already shows a query, a new message usually refines it ("only open access", "since 2020", "now by country", "what about Stanford?", "show mean FWCI too", "chart it by year"): change that query and keep everything else in it, including how it picks the groups (\`by author at [X]\` stays so), its numbers and its order, whatever form it is written in: edit its text, don't rewrite it from scratch. Start fresh only when they ask about something new. Earlier turns of the conversation, when shown, are context; the page's current query is the one to change.

How to write good queries:
- Answer what was asked. Add no condition the person didn't ask for: no year range, work type, language, minimum count or other cutoff. Write a year only when the person gives one, or asks for recent or current work in words ("actively", "currently", "recent", "latest", "emerging", "trending"): that is a window they asked for, so use the last three years (\`since ${year - 2}\`) and say so in the note. A table ordered by a mean, a percent or a share needs a count floor, or tiny groups at 100% come first: add a small one (\`Only institutions with at least 5 works about ...\`; for a big body of work, 50 or 500) and say so in the note. A mean or percent shown beside the count, in the default order (most works first), needs no floor.
- What works are about: \`about ...\` searches their title, abstract and keywords. Use it unless the person says where else to look (\`with ... in the title\`, \`in the full text\`) or asks for a topic, subfield or field by name.
- Search only with the person's own words. Never add a search word they didn't type: no synonyms, related terms, abbreviations, spellings or translations of your own, even when they would find more. Bare words are stemmed (\`teacher\` also finds teachers) and a wildcard keeps a stem open (\`adolescen*\`), so word forms need no OR. Quote only phrases the person quoted and fixed multi-word terms they typed. Join their concepts with AND; use OR and NOT only where they did; keep every concept they asked for.
- Finding a known paper ("find the paper titled ..."): \`get works with "<the exact title>" in the title\`; if that finds nothing, retry with the title's distinctive words unquoted. The answer is the matching paper. If OpenAlex doesn't have it, say so plainly in the note.
- A thing itself by id ("the author with OpenAlex ID A..."): \`get authors where OpenAlex ID is A5022654839\`, \`get works where OpenAlex ID is W2626778328\`.
- People: choose the author profile whose name order, affiliation and output fit the person meant; don't join several profiles unless asked.
- Never put a placeholder or guessed id in a query. If you can't resolve something, leave it out and say so.
- Order a list only when the person asks for one ("most cited", "newest", "most relevant"); otherwise leave the default. Citation order on a loose search brings unrelated classics to the top.
- A trend by year that reaches this year: keep the years the person asked for, and say in the note that ${year} is still incomplete and holds a large batch of newly added datasets.
- Researchers at an institution (people there now): \`get the count of works about ... by author where last known institution is [X](I1)\`; \`by author at [X](I1)\` also counts anyone whose record lists X in any year, for "who has ever worked at X". When run_oql says it is too big to run (a large university and a broad subject), count the authors of its matching works instead, \`get the count of [University of Michigan](I27837315)'s works about immunotherapy by author\`, and say in the note that co-authors from elsewhere appear too. Don't add a year range to make it fit.
- Conditions about the people or places in a table (not at X, never co-authored with Y, only universities, at least 5 papers) go on the groups, after \`by author where ...\` / \`by institution where ...\` and in an \`Only ...\` floor, not on the works: \`works where institution is not [X] by author\` drops papers, not people.
- Compared with the world or the rest (a specialisation index, "compared with everyone else"): show both sides, one thing versus the rest (the guide's general form).
`;

export interface Institution { id: string; name: string }

/** How a model is told the query the page shows now (the agent and the router; the router's prompt names it). */
export const pageQueryNote = (q: string) => `(The results page currently shows this query: ${q})`;

/** A preview as the model and the page see it: without the older form, which only the word check reads. */
export const publicPreview = ({ pipeline: _pipeline, ...rest }: Preview): Preview => rest;

/** The system prompt: rules, the person's institution when the page knows it, then the OQL guide. */
export function systemPrompt(institution?: Institution | null, guide: string = CHAT_GUIDE, year: number = new Date().getUTCFullYear()): string {
  const who = institution
    ? `\nThe person's profile says they are at ${institution.name} (${institution.id}). Use it only when they say "our institution", "our researchers" or "we" and name no institution at all; if they name or abbreviate one, resolve that one.\n`
    : `\nWhen the person says "our institution" or "we" without naming one, use the most likely reading and say in the note which institution the query assumes, so they can correct it.\n`;
  return basePrompt(year) + who + "\nThe OQL guide follows.\n\n" + guide;
}

export const TOOLS: Anthropic.Tool[] = [
  {
    name: "find_entity",
    description: "Search OpenAlex entities by name. Returns up to 6 matches with id, name, and size.",
    input_schema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["institutions", "authors", "sources", "publishers", "funders", "topics", "subfields", "fields", "keywords", "countries"] },
        name: { type: "string" },
      },
      required: ["type", "name"],
    },
  },
  {
    name: "run_oql",
    description: "Check and run an OQL query on the live API. Returns its canonical form (the sentence the page will show), validation errors with fixes, the count, and the top rows (groups with their numbers, or works).",
    input_schema: {
      type: "object",
      properties: {
        oql: { type: "string" },
      },
      required: ["oql"],
    },
  },
  {
    name: "submit",
    description: "Submit the query that answers the question; it sets the results page. Call once, last.",
    input_schema: {
      type: "object",
      properties: {
        oql: { type: "string" }, note: { type: "string" },
        sort: { type: "string", description: "an API sort (cited_by_count:desc, mean_fwci:desc); empty when the query states its order or needs none" },
        left_out: { type: "string", description: "the second (and later) questions you left out, in a few words; omit when there's one question" },
        out_of_reach: { type: "string", description: "what OpenAlex or one query can't answer, in a few words; omit when the query answers it all" },
        howto: { type: "string", description: "one line on how to do it themselves on OpenAlex, only when they asked how" },
      },
      required: ["oql", "note"],
    },
  },
];

/** The OpenAlex calls the agent needs (OpenAlexClient satisfies it; tests pass a fake). */
export interface OpenAlexLike {
  get(path: string, params?: Record<string, string | number | boolean | undefined | null>): Promise<any>;
  post(body: Record<string, any>): Promise<any>;
  checkOql(oql: string): Promise<any>;
}

/** The Anthropic call the agent needs (an Anthropic client satisfies it; tests pass a fake). */
export interface AnthropicLike {
  messages: { create(body: any, options?: { signal?: AbortSignal }): Promise<Anthropic.Message> };
}

export interface Preview {
  ok: boolean;
  /** The sentence the page shows and runs: the API's new form (x_new_oql, names kept), or the older form when it has none. */
  canonical?: string;
  /** The older pipeline form of the same query (`title-abstract-keywords has (...)`): what the word check reads. */
  pipeline?: string;
  count?: number | null;
  groups_count?: number | null;
  measures?: string[];
  summary_all?: Record<string, any>;
  top_groups?: Array<Record<string, any>>;
  top_rows?: Array<Record<string, any>>;
  errors?: any;
}

/** The feedback a query with new search words gets back (on a trial run, and on a refused submit). */
export const WORD_RULE = "These search words aren't in the person's request. Search only with their own words (their stems, plurals and wildcards are fine): no synonyms, related terms, translations or spellings of your own. If their words alone find too little, keep them anyway and say in the note what a broader search might add.";

export type ChatEvent =
  | { type: "step"; tool: "find_entity" | "run_oql"; detail: string }
  | { type: "answer"; oql: string; sort: string | null; note: string; preview: Preview; new_words: string[];
      left_out: string | null; out_of_reach: string | null; howto: string | null }
  | { type: "done"; messages: Anthropic.MessageParam[]; cost_usd: number; usage: Usage; turns: number; word_retries: number }
  | { type: "error"; message: string };

export interface Usage { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

export function costUsd(u: Usage): number {
  return priceOf(CHAT_MODEL, u);
}

/** find_entity: the same fields the harness gave the model. */
export async function findEntity(oa: OpenAlexLike, type: string, name: string): Promise<string> {
  const select = "id,display_name,works_count" + (type === "institutions" ? ",country_code" : "") + (type === "authors" ? ",last_known_institutions" : "");
  try {
    const d: any = await oa.get(`/${type}`, { search: name, "per-page": 6, select });
    const out = (d?.results ?? []).map((x: any) => {
      const e: Record<string, any> = { id: String(x.id ?? "").split("/").pop(), name: x.display_name, works: x.works_count };
      if (x.country_code) e.country = x.country_code;
      if (x.last_known_institutions?.length) e.at = x.last_known_institutions.slice(0, 2).map((i: any) => i.display_name);
      return e;
    });
    return JSON.stringify(out);
  } catch (e: any) {
    return JSON.stringify({ error: e?.message ?? String(e) });
  }
}

/**
 * run_oql: the free check first, then a 5-row run of the API's canonical echo of the query as written (the check's
 * x_new_oql: for a get-only sentence, that sentence normalized, names kept), which is what the page shows and runs.
 * A sort is passed to the API only beside a general-form query; sentences carry their order. A refusal comes back as
 * data, not a throw.
 */
export async function runOql(oa: OpenAlexLike, oql: string, sort?: string | null): Promise<Preview> {
  let check: any;
  try {
    check = await oa.checkOql(oql);
  } catch (e: any) {
    return { ok: false, errors: e?.message ?? String(e) };
  }
  const v = check?.validation ?? {};
  if (!check?.oql || v.valid === false) {
    return { ok: false, canonical: check?.x_new_oql ?? check?.oql, errors: check?.check?.limits?.length ? check.check.limits : (v.errors ?? check) };
  }
  const pipeline: string = check.oql;
  const canonical: string = check.x_new_oql || pipeline;
  let r: any;
  try {
    r = await oa.post({ oql: canonical, per_page: 5, ...(sort ? { sort } : {}) });
  } catch (err: any) {
    const body = err instanceof OpenAlexError ? err.body : undefined;
    const said = body?.message ? { error: body.error, message: body.message, fix: body.fix } : null;   // e.g. too_many_groups
    return { ok: false, canonical, errors: body?.validation?.errors ?? said ?? err?.message ?? String(err) };
  }
  const m = r?.meta ?? {};
  const p: Preview = { ok: true, canonical, pipeline, count: m.count ?? null, groups_count: m.groups_count ?? null };
  if (Array.isArray(m.measures) && m.measures.length) p.measures = m.measures.map((x: any) => x.key);
  // A calculation with no split answers in summary.all alone (group_by and results are empty).
  if (r?.summary?.all) p.summary_all = r.summary.all;
  if (Array.isArray(r?.group_by) && r.group_by.length) {
    p.top_groups = r.group_by.slice(0, 5).map(({ key, ...rest }: any) => rest);
  } else if (!r?.summary) {
    p.top_rows = (r?.results ?? []).slice(0, 5).map((x: any) => ({
      id: String(x.id ?? "").split("/").pop(), name: x.display_name ?? x.title, year: x.publication_year, cited_by: x.cited_by_count,
    }));
  }
  return p;
}

export interface ChatInput {
  /** The conversation so far, exactly as a previous `done` event returned it, plus the new user turn. */
  messages: Anthropic.MessageParam[];
  /** The query the page shows now, if any; follow-ups edit it. */
  currentQuery?: string | null;
  /** Earlier turns of the page's chat, oldest first: what was asked and the query that turn set (null: none). */
  history?: Turn[] | null;
  institution?: Institution | null;
}

export interface Turn { text: string; oql: string | null }

/** Earlier turns as context for the newest question (the page's chat history, #1744). */
export function historyContext(history: Turn[] | null | undefined): string {
  if (!history?.length) return "";
  const lines = history.map((h, i) => `${i + 1}. They asked: ${h.text}\n   The page then showed: ${h.oql ?? "(no query)"}`);
  return `(Earlier in this conversation, oldest first:\n${lines.join("\n")})\n\nNow they ask: `;
}

/** The text of the person's own turns (tool results and nudges excluded). */
function userTexts(messages: Anthropic.MessageParam[]): string[] {
  return messages.filter((m) => m.role === "user").flatMap((m) =>
    typeof m.content === "string" ? [m.content] : m.content.flatMap((b: any) => (b.type === "text" ? [b.text] : [])));
}

/**
 * Run one question to an answer. Emits a `step` per tool call, an `answer` when a query is submitted (only a query
 * that runs is accepted: a failing submit goes back to the model with the error), and `done` with the updated
 * conversation and the model cost. Throws nothing a caller must catch: failures become an `error` event.
 */
export async function runChat(
  deps: { anthropic: AnthropicLike; openalex: OpenAlexLike; guide?: string; effort?: string; model?: string;
    /** Stops the agent between steps (and its model call in flight): the caller found the question isn't for it. */
    signal?: AbortSignal },
  input: ChatInput,
  emit: (e: ChatEvent) => void | Promise<void>,
): Promise<{ cost_usd: number; answered: boolean }> {
  const usage: Usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const messages: Anthropic.MessageParam[] = input.messages.map((m) => ({ ...m }));
  if (!messages.length || messages[messages.length - 1].role !== "user") {
    await emit({ type: "error", message: "The conversation must end with the person's question." });
    return { cost_usd: 0, answered: false };
  }
  const before = historyContext(input.history);
  const after = input.currentQuery ? `\n\n${pageQueryNote(input.currentQuery)}` : "";
  if (before || after) {
    // Context for a follow-up, around the newest user turn only (earlier turns stay exactly as returned).
    const last = messages[messages.length - 1];
    last.content = typeof last.content === "string"
      ? before + last.content + after
      : [...(before ? [{ type: "text" as const, text: before }] : []), ...last.content, ...(after ? [{ type: "text" as const, text: after }] : [])];
  }
  const system = systemPrompt(input.institution, deps.guide);
  const effort = deps.effort || CHAT_EFFORT;
  const model = deps.model || CHAT_MODEL;
  // The words the person typed (this turn, earlier turns, and the page's query): searches may use only these (searchWords.ts)
  const typed = typedVocabulary([...userTexts(input.messages), ...(input.history ?? []).map((h) => h.text), input.currentQuery ?? ""]);
  /**
   * Run a query the model wrote, and the search words in it the person never typed (read from the older form). A
   * query already tried in this chat isn't run again (a submit of what run_oql just ran: about a second saved).
   */
  const tried = new Map<string, Promise<Preview>>();
  const trial = async (a: any) => {
    const key = `${a.oql ?? ""}\u0000${a.sort || ""}`;
    if (!tried.has(key)) tried.set(key, runOql(deps.openalex, a.oql ?? "", a.sort || null));
    const p = await tried.get(key)!;
    if (!p.ok) tried.delete(key);   // a failure may be passing (a timeout): a retry runs it again
    // the echo is what the model sees and is told to submit: that text reuses this run too
    else if (p.canonical) tried.set(`${p.canonical}\u0000${a.sort || ""}`, tried.get(key)!);
    return { p: publicPreview(p), added: p.ok ? newWords(p.pipeline ?? "", typed) : [] };
  };
  let wordRetries = 0;
  let turns = 0;
  let answered = false;
  for (; turns < MAX_TURNS && !answered; turns++) {
    if (deps.signal?.aborted) {
      await emit({ type: "error", message: "Stopped." });
      break;
    }
    const lastTurn = turns === MAX_TURNS - 1;
    let res: Anthropic.Message;
    try {
      res = await deps.anthropic.messages.create({
        model,
        max_tokens: 16000,
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        tools: TOOLS,
        messages: cacheMarked(lastTurn ? addNudge(messages) : messages),
        output_config: { effort },
      }, deps.signal ? { signal: deps.signal } : undefined);
    } catch (e: any) {
      await emit({ type: "error", message: `The model call failed: ${e?.message ?? e}` });
      break;
    }
    const u: any = res.usage ?? {};
    usage.input_tokens += u.input_tokens ?? 0;
    usage.output_tokens += u.output_tokens ?? 0;
    usage.cache_read_input_tokens += u.cache_read_input_tokens ?? 0;
    usage.cache_creation_input_tokens += u.cache_creation_input_tokens ?? 0;
    if (res.stop_reason === "refusal") {
      await emit({ type: "error", message: "The model declined this request." });
      break;
    }
    messages.push({ role: "assistant", content: res.content as any });
    const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (!uses.length) {
      await emit({ type: "error", message: "The assistant stopped without a query." });
      break;
    }
    // stopped while the model was thinking: run none of its tool calls (they would spend the person's credits)
    if (deps.signal?.aborted) {
      await emit({ type: "error", message: "Stopped." });
      break;
    }
    // a turn's lookups and trial runs go out together (results still in order); a submit waits for them
    const pending = uses.map((b) => {
      const a: any = b.input ?? {};
      return b.name === "find_entity" ? findEntity(deps.openalex, a.type ?? "institutions", a.name ?? "")
        : b.name === "run_oql" ? trial(a) : null;
    });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const [i, b] of uses.entries()) {
      const a: any = b.input ?? {};
      if (b.name === "find_entity") {
        await emit({ type: "step", tool: "find_entity", detail: `${a.type}: ${a.name}` });
        results.push({ type: "tool_result", tool_use_id: b.id, content: await (pending[i] as Promise<string>) });
      } else if (b.name === "run_oql") {
        await emit({ type: "step", tool: "run_oql", detail: String(a.oql ?? "").slice(0, 300) });
        const { p, added } = await (pending[i] as ReturnType<typeof trial>);
        // the word check's feedback goes to the model only, never into the preview the page gets
        const shown = added.length ? { ...p, new_search_words: added, word_rule: WORD_RULE } : p;
        results.push({ type: "tool_result", tool_use_id: b.id, content: JSON.stringify(shown).slice(0, 4000) });
      } else if (b.name === "submit") {
        const { p, added } = await trial(a);
        if (!p.ok && !lastTurn) {
          results.push({ type: "tool_result", tool_use_id: b.id, is_error: true, content: "Not submitted: this query fails. " + JSON.stringify(p).slice(0, 1500) });
          continue;
        }
        if (added.length && !lastTurn) {
          wordRetries++;
          results.push({ type: "tool_result", tool_use_id: b.id, is_error: true, content: `Not submitted: new search words ${JSON.stringify(added)}. ${WORD_RULE}` });
          continue;
        }
        if (!p.ok) {
          await emit({ type: "error", message: "The assistant's last query doesn't run." });
        } else {
          const opt = (v: any) => (typeof v === "string" && v.trim() ? v.trim() : null);
          await emit({ type: "answer", oql: p.canonical ?? a.oql, sort: a.sort || null, note: a.note ?? "", preview: p, new_words: added,
            left_out: opt(a.left_out), out_of_reach: opt(a.out_of_reach), howto: opt(a.howto) });
          answered = true;
        }
        results.push({ type: "tool_result", tool_use_id: b.id, content: p.ok ? "received" : "Not submitted: this query fails." });
      } else {
        results.push({ type: "tool_result", tool_use_id: b.id, is_error: true, content: `Unknown tool ${b.name}` });
      }
    }
    // Every tool_use gets its result, so the returned conversation is valid to send back next time.
    messages.push({ role: "user", content: results });
  }
  if (!answered && turns >= MAX_TURNS) await emit({ type: "error", message: "The assistant ran out of steps without a query." });
  const cost = priceOf(model, usage);
  await emit({ type: "done", messages, cost_usd: cost, usage, turns, word_retries: wordRetries });
  return { cost_usd: cost, answered };
}

/**
 * The request's copy of the conversation with a cache mark on its newest block, so the next turn reads everything
 * before it from cache (the system prompt has its own mark). The stored conversation is never changed.
 */
function cacheMarked(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const last = messages[messages.length - 1];
  const blocks: any[] = typeof last.content === "string" ? [{ type: "text", text: last.content }] : [...last.content];
  blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: { type: "ephemeral" } };
  return [...messages.slice(0, -1), { ...last, content: blocks }];
}

/**
 * On the last turn, ask for submit. The nudge goes into the stored conversation itself (the newest user turn, which
 * the model hasn't seen yet), so the history sent back later is exactly what the model saw: append-only.
 */
function addNudge(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const last = messages[messages.length - 1];
  const nudge = { type: "text" as const, text: "Last turn: call submit now." };
  last.content = typeof last.content === "string" ? [{ type: "text", text: last.content }, nudge] : [...last.content, nudge];
  return messages;
}
