/**
 * The results-page chat agent (oxjob #1494): a person asks for literature in plain words; the agent answers with ONE
 * OQL query, which sets the openalex.org results page (results, facets, download) and shows at its top.
 *
 * Configuration chosen on oxjob #1494's harness (EXPLORE.md §§ 8-14): Claude Opus 5.5 at xhigh effort, the
 * "prompt v2" search rules below, and #1555's one-page OQL guide (chat_guide.md, a copy of guide_v6.md). Measured
 * there: 81% of the dev questions and 88-91% of a traffic-shaped sample of real search-box requests answered right,
 * about $0.032 a question, median 9 s. Every OpenAlex call runs on the person's own API key (their credits), as in
 * the MCP tools.
 *
 * The browser keeps the conversation: it sends back `messages` exactly as returned, assistant turns included
 * (Opus 5.5 rejects edited history, so thinking blocks must round-trip untouched).
 */
import type Anthropic from "@anthropic-ai/sdk";
import { OpenAlexError } from "./openalex";
import CHAT_GUIDE from "./chat_guide.md";

export const CHAT_MODEL = "claude-opus-5-5";
export const CHAT_EFFORT = "xhigh";
/** Model turns per question; the harness median was two tool calls before submit. */
export const MAX_TURNS = 8;
/** $/MTok for CHAT_MODEL (claude-api skill, cached 2026-10-06): input, output, cache read, cache write. */
export const PRICE = { input: 4.0, output: 20.0, cacheRead: 0.2, cacheWrite: 5.0 };

const BASE_PROMPT = `You are the assistant in the chat panel beside OpenAlex's search results. People ask questions about the scholarly literature in plain words; you answer by writing ONE OQL query. The results page then shows that query's results (with its facets, table and download), and the query itself at the top so anyone can rerun it.

How to work:
1. Work out what the person wants back: a list of works, a count, a breakdown, numbers per group, a ranking.
2. Resolve every name (institution, author, journal, funder, topic) to its OpenAlex id with find_entity.
3. Write the query and try it with run_oql. Check the preview: does it look like the answer? Fix and retry if not.
4. Call submit with the query exactly as it ran, the sort (an API sort such as cited_by_count:desc or a calculated column key from the preview such as mean_fwci:desc; empty for none), and a note of at most 30 words telling the person what you assumed or what the query can't cover.

If one query can't fully answer the question, submit the closest useful query and say in the note what's missing. Be quick: most questions need one or two tool calls before submit.
When the page already shows a query and the person asks for a change ("only open access", "since 2020"), edit that query rather than starting over.

How to write good queries:
- Answer what was asked. Add no condition the person didn't ask for: no year range, work type, language, minimum count or other cutoff. When a ranking by an average needs a minimum group size to mean anything, use a small one (5) and say so in the note.
- Searches: use \`title-abstract-keywords has (...)\` by default (what the website's search box uses). Use \`full text has (...)\` when the person says "mention" or the subject is a detail that usually lives in a paper's body (a dataset, a tool, a method, a species, a place). Write bare words, which are stemmed (\`teacher\` also finds teachers); quote only fixed multi-word terms and phrases the person quoted. Join the person's concepts with AND and the synonyms of one concept with OR; keep every concept they asked for.
- \`topic\` is a work's primary topic; \`topics\` matches any of its topics, so use \`topics\` for "works about X". Subfield, field and domain follow the primary topic; when a field label might miss relevant works, a search or \`topics\` is safer.
- Finding a known paper ("find the paper titled ..."): \`get works where title has ("<the exact title>")\`; if that finds nothing, retry with the title's distinctive words unquoted. The answer is the matching paper. If OpenAlex doesn't have it, say so plainly in the note.
- When the person asks for a thing itself (an author, institution or journal record, e.g. "the author with OpenAlex ID A..."), start from that thing: \`get authors where OpenAlex ID is A5022654839\`.
- People: choose the author profile whose name order, affiliation and output fit the person meant; don't join several profiles unless asked.
- Never put a placeholder or guessed id in a query. If you can't resolve something, leave it out and say so.
- A random sample: \`...; then, sample 25 of those works with seed 1\`.
- Sort keys are the API's column names, not OQL words: \`cited_by_count:desc\`, \`publication_date:desc\`, \`fwci:desc\`, \`relevance_score:desc\` (with a search), \`works_count:desc\`, \`summary_stats.h_index:desc\`, \`summary_stats.2yr_mean_citedness:desc\`; for a calculated column use the key the preview lists in \`measures\` (e.g. \`mean_fwci:desc\`, \`percent_open_access_is_oa:desc\`).
- One row per person or institution: start with the thing, e.g. \`get authors at [University of Kansas](I146416000) who published works where ...; then, summarize each author using count\`.
`;

export interface Institution { id: string; name: string }

/** The system prompt: rules, the person's institution when the page knows it, then the OQL guide. */
export function systemPrompt(institution?: Institution | null, guide: string = CHAT_GUIDE): string {
  const who = institution
    ? `\nThe person's profile says they are at ${institution.name} (${institution.id}). Use it only when they say "our institution", "our researchers" or "we" and name no institution at all; if they name or abbreviate one, resolve that one.\n`
    : `\nWhen the person says "our institution" or "we" without naming one, use the most likely reading and say in the note which institution the query assumes, so they can correct it.\n`;
  return BASE_PROMPT + who + "\nThe OQL guide follows.\n\n" + guide;
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
    description: "Check and run an OQL query on the live API. Returns its canonical form, validation errors with fixes, the count, and the top rows (groups with their numbers, or works).",
    input_schema: {
      type: "object",
      properties: {
        oql: { type: "string" },
        sort: { type: "string", description: "optional API sort, e.g. cited_by_count:desc, or a calculated column key such as mean_fwci:desc" },
      },
      required: ["oql"],
    },
  },
  {
    name: "submit",
    description: "Submit the query that answers the question; it sets the results page. Call once, last.",
    input_schema: {
      type: "object",
      properties: { oql: { type: "string" }, sort: { type: "string" }, note: { type: "string" } },
      required: ["oql", "sort", "note"],
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
  messages: { create(body: any): Promise<Anthropic.Message> };
}

export interface Preview {
  ok: boolean;
  canonical?: string;
  count?: number | null;
  groups_count?: number | null;
  measures?: string[];
  summary_all?: Record<string, any>;
  top_groups?: Array<Record<string, any>>;
  top_rows?: Array<Record<string, any>>;
  errors?: any;
}

export type ChatEvent =
  | { type: "step"; tool: "find_entity" | "run_oql"; detail: string }
  | { type: "answer"; oql: string; sort: string | null; note: string; preview: Preview }
  | { type: "done"; messages: Anthropic.MessageParam[]; cost_usd: number; usage: Usage; turns: number }
  | { type: "error"; message: string };

export interface Usage { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

export function costUsd(u: Usage): number {
  return (u.input_tokens * PRICE.input + u.output_tokens * PRICE.output + u.cache_read_input_tokens * PRICE.cacheRead
    + u.cache_creation_input_tokens * PRICE.cacheWrite) / 1e6;
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

/** run_oql: the free check first, then a 5-row run of the canonical form; a refusal comes back as data, not a throw. */
export async function runOql(oa: OpenAlexLike, oql: string, sort?: string | null): Promise<Preview> {
  let check: any;
  try {
    check = await oa.checkOql(oql);
  } catch (e: any) {
    return { ok: false, errors: e?.message ?? String(e) };
  }
  const v = check?.validation ?? {};
  if (!check?.oql || v.valid === false) {
    return { ok: false, canonical: check?.oql, errors: check?.check?.limits?.length ? check.check.limits : (v.errors ?? check) };
  }
  const canonical: string = check.oql;
  let r: any;
  try {
    r = await oa.post({ oql: canonical, per_page: 5, ...(sort ? { sort } : {}) });
  } catch (e: any) {
    const body = e instanceof OpenAlexError ? e.body : undefined;
    return { ok: false, canonical, errors: body?.validation?.errors ?? e?.message ?? String(e) };
  }
  const m = r?.meta ?? {};
  const p: Preview = { ok: true, canonical, count: m.count ?? null, groups_count: m.groups_count ?? null };
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
  institution?: Institution | null;
}

/**
 * Run one question to an answer. Emits a `step` per tool call, an `answer` when a query is submitted (only a query
 * that runs is accepted: a failing submit goes back to the model with the error), and `done` with the updated
 * conversation and the model cost. Throws nothing a caller must catch: failures become an `error` event.
 */
export async function runChat(
  deps: { anthropic: AnthropicLike; openalex: OpenAlexLike; guide?: string },
  input: ChatInput,
  emit: (e: ChatEvent) => void | Promise<void>,
): Promise<{ cost_usd: number; answered: boolean }> {
  const usage: Usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const messages: Anthropic.MessageParam[] = input.messages.map((m) => ({ ...m }));
  if (!messages.length || messages[messages.length - 1].role !== "user") {
    await emit({ type: "error", message: "The conversation must end with the person's question." });
    return { cost_usd: 0, answered: false };
  }
  if (input.currentQuery) {
    // Context for a follow-up, appended to the newest user turn (never to earlier turns: history stays as returned).
    const last = messages[messages.length - 1];
    const ctx = `\n\n(The results page currently shows this query: ${input.currentQuery})`;
    last.content = typeof last.content === "string" ? last.content + ctx : [...last.content, { type: "text", text: ctx }];
  }
  const system = systemPrompt(input.institution, deps.guide);
  let turns = 0;
  let answered = false;
  for (; turns < MAX_TURNS && !answered; turns++) {
    const lastTurn = turns === MAX_TURNS - 1;
    let res: Anthropic.Message;
    try {
      res = await deps.anthropic.messages.create({
        model: CHAT_MODEL,
        max_tokens: 16000,
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        tools: TOOLS,
        messages: lastTurn ? addNudge(messages) : messages,
        output_config: { effort: CHAT_EFFORT },
      });
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
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const b of uses) {
      const a: any = b.input ?? {};
      if (b.name === "find_entity") {
        await emit({ type: "step", tool: "find_entity", detail: `${a.type}: ${a.name}` });
        results.push({ type: "tool_result", tool_use_id: b.id, content: await findEntity(deps.openalex, a.type ?? "institutions", a.name ?? "") });
      } else if (b.name === "run_oql") {
        await emit({ type: "step", tool: "run_oql", detail: String(a.oql ?? "").slice(0, 300) });
        const p = await runOql(deps.openalex, a.oql ?? "", a.sort || null);
        results.push({ type: "tool_result", tool_use_id: b.id, content: JSON.stringify(p).slice(0, 4000) });
      } else if (b.name === "submit") {
        const p = await runOql(deps.openalex, a.oql ?? "", a.sort || null);
        if (!p.ok && !lastTurn) {
          results.push({ type: "tool_result", tool_use_id: b.id, is_error: true, content: "Not submitted: this query fails. " + JSON.stringify(p).slice(0, 1500) });
          continue;
        }
        if (!p.ok) {
          await emit({ type: "error", message: "The assistant's last query doesn't run." });
        } else {
          await emit({ type: "answer", oql: p.canonical ?? a.oql, sort: a.sort || null, note: a.note ?? "", preview: p });
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
  const cost = costUsd(usage);
  await emit({ type: "done", messages, cost_usd: cost, usage, turns });
  return { cost_usd: cost, answered };
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
