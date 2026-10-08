/**
 * Shaping for OQL calculations (oxjob #1537): the API's grouped rows with their calculated columns, the summary
 * (#1550) and the price (#1530's pipeline engine), and the free check's verdict. Pure, unit-tested.
 */
import { compact, MAX_RESULT_CHARS } from "./shape";
import { shortId } from "./ids";
import { oneLine, queryEcho } from "./oql";

export interface Measure { key: string; measure?: string; column_id?: string | null; oql?: string }
type Col = [key: string, label: string];

/** A group key as a short id: https://openalex.org/I1 → I1, …/types/article → article; condition, bin and year keys pass through. */
export function rowId(key: unknown): string {
  const s = String(key ?? "");
  if (!/^https?:\/\/openalex\.org\//i.test(s)) return s;
  return shortId(s.replace(/^https?:\/\/openalex\.org\/(?:[a-z-]+\/)?/i, "")) ?? s;
}

/** Columns from meta.measures, labeled with their OQL words ("mean FWCI"); a classic group-by has only count. */
export function calculationColumns(measures: Measure[] | undefined): Col[] {
  return measures?.length ? measures.map((m) => [m.key, m.oql || m.key]) : [["count", "count"]];
}

function shapeRow(g: any, cols: Col[]): Record<string, any> {
  const id = rowId(g.key);
  const out: Record<string, any> = { id };
  const name = g.key_display_name;
  if (name && name !== id && name !== String(g.key)) out.name = name;
  for (const [k, label] of cols) if (g[k] !== undefined && g[k] !== null) out[label] = g[k];
  if (Array.isArray(g.groups)) out.groups = g.groups.map((x: any) => shapeRow(x, cols));
  return out;
}

/**
 * The response of a grouped or calculated query, compactly: one row per group keyed by the OQL words of each
 * calculation, nested splits under `groups`, the summary (the whole starting set, and each split's groups on their
 * own), paging and the price.
 * `sortBy` (a column label) orders the returned rows; the API itself returns groups by count.
 */
export function shapeCalculation(data: any, opts: { page?: number; sortBy?: string; ascending?: boolean } = {}): Record<string, any> {
  const meta = data?.meta ?? {};
  const cols = calculationColumns(meta.measures);
  const labels = cols.map((c) => c[1]);
  const groups = (data?.group_by ?? []).map((g: any) => shapeRow(g, cols));
  let sortNote: string | undefined;
  if (opts.sortBy) {
    const label = labels.find((l) => l.toLowerCase() === opts.sortBy!.toLowerCase());
    if (label) {
      const dir = opts.ascending ? 1 : -1;
      const val = (r: any) => (typeof r[label] === "number" ? r[label] : -Infinity * dir);
      groups.sort((a: any, b: any) => dir * (val(a) - val(b)));
      sortNote = `Rows on this page are ordered by ${label}${opts.ascending ? " (ascending)" : ""}; OQL has no sort, and the API picks each page's groups by count.`;
    } else {
      sortNote = `OQL has no sort, and "${opts.sortBy}" is not a calculated column (${labels.join(", ")}); rows are in the API's order (by count).`;
    }
  }
  // The summary (#1550): the whole set, and with 2+ splits each split's groups on their own, computed by the API
  // from the works (read these, never sum or average the group rows).
  let summary: Record<string, any> | undefined;
  if (data?.summary?.all) {
    const { id: _id, ...rest } = shapeRow(data.summary.all, cols);
    const splits = (data.summary.splits ?? []).map((part: any, i: number) => compact({
      split: meta.splits?.[i]?.oql,
      groups: (part?.groups ?? []).map((g: any) => shapeRow(g, cols)),
      more_groups: part?.more_groups || undefined,
    }));
    summary = compact({ all: { name: data.summary.all.key_display_name ?? "all works", ...rest },
                        splits: splits.length ? splits : undefined });
  }
  const page = opts.page ?? meta.page ?? 1;
  // The pipeline engine itemizes the price in meta.cost; a classic grouped response carries only cost_usd (1 credit = $0.0001).
  const cost = meta.cost ?? (typeof meta.cost_usd === "number" ? { credits: Math.round(meta.cost_usd * 10000), usd: meta.cost_usd } : undefined);
  return compact({
    ...queryEcho(data),
    total_works: meta.count,
    columns: labels,
    summary,
    groups,
    groups_count: meta.groups_count,
    groups_returned: groups.length,
    next_page: meta.more_groups ? page + 1 : null,
    sort_note: sortNote,
    price: cost ? compact({ credits: cost.credits, usd: cost.usd, steps: cost.steps }) : undefined,
    elapsed_ms: meta.elapsed_ms,
  });
}

/**
 * Serialize a calculation within the tool-result budget. Nested splits can return thousands of rows, and a
 * cut-off JSON string is useless, so inner group lists are capped first, then dropped and outer rows halved, with a note.
 */
export function serializeCalculation(payload: Record<string, any>, maxChars = MAX_RESULT_CHARS): string {
  let text = JSON.stringify(payload);
  if (text.length <= maxChars) return text;
  const cap = (rows: any[] | undefined, n: number): any[] | undefined =>
    rows?.map((r) => (Array.isArray(r.groups) ? { ...r, groups: cap(r.groups.slice(0, n), n), ...(r.groups.length > n ? { groups_trimmed: r.groups.length } : {}) } : r));
  // the summary's split lists are capped like inner groups: the whole-set row always stays
  const capSummary = (n: number) => payload.summary && {
    ...payload.summary,
    splits: payload.summary.splits?.map((s: any) => (s.groups.length > n ? { ...s, groups: s.groups.slice(0, n), groups_trimmed: s.groups.length } : s)),
  };
  for (const n of [50, 10, 1]) {
    text = JSON.stringify({
      ...payload, summary: capSummary(n), groups: cap(payload.groups, n),
      truncation_note: `Inner groups and summary groups trimmed to the first ${n} of each (groups_trimmed = how many there were) to fit the size limit; narrow the query or split it.`,
    });
    if (text.length <= maxChars) return text;
  }
  let rows = (payload.groups ?? []).map(({ groups: _g, ...r }: any) => r);
  const flat = { ...payload, summary: payload.summary && { all: payload.summary.all } };
  do {
    text = JSON.stringify({ ...flat, groups: rows, truncation_note: `Inner groups dropped and rows trimmed to ${rows.length} to fit the size limit; ask for fewer groups (limit) or page.` });
    rows = rows.slice(0, Math.ceil(rows.length / 2));
  } while (text.length > maxChars && rows.length > 1);
  return text;
}

/** A tool result holding a calculation, serialized within budget. */
export const calculationResult = (payload: Record<string, any>) => ({ content: [{ type: "text" as const, text: serializeCalculation(payload) }] });

/** Split the API's "message  Fix: do this" into its two parts and drop the parser's prefix. */
function messageAndFix(msg: string): { message: string; fix?: string } {
  const text = String(msg ?? "").replace(/^Failed to parse OQL:\s*/i, "").trim();
  const m = text.match(/^([\s\S]*?)\s+Fix:\s+([\s\S]*)$/);
  return m ? { message: m[1]!.trim(), fix: m[2]!.trim() } : { message: text };
}

/**
 * The free check's verdict for an agent: valid or not, every problem with its fix, the time estimate and the price,
 * and the canonical text (with entity names, so the agent can confirm each ID means what it thinks).
 * A query the classic form can say has no `check` block until the API's launch flip; it costs 1 credit flat.
 */
export function shapeCheck(body: any): Record<string, any> {
  const v = body?.validation ?? {};
  const check = body?.check;
  // The limits carry their fixes split out; a validation error repeats a limit under the same type.
  const problems: Record<string, any>[] = (check?.limits ?? []).map((l: any) => compact({ problem: l.error, message: l.message, fix: l.fix }));
  for (const e of v.errors ?? []) {
    if (!problems.some((p) => p.problem === e.type)) problems.push(compact({ problem: e.type, ...messageAndFix(e.message) }));
  }
  const valid = v.valid !== false && (check ? !!check.valid : !problems.length);
  const est = check?.estimate;
  return compact({
    valid,
    problems,
    warnings: (v.warnings ?? []).map((w: any) => (typeof w === "string" ? w : w?.message)).filter(Boolean),
    // Entity names in brackets let the agent confirm each ID; the API reads the text back as is.
    canonical_oql: body?.oql_oneline ?? oneLine(body?.oql),
    estimated_seconds: est?.seconds,
    time_budget_seconds: est?.budget_seconds,
    price: check?.cost
      ? compact({ credits: check.cost.credits, usd: check.cost.usd, steps: check.cost.steps })
      : valid ? { credits: 1, usd: 0.0001, note: "A query in this form costs 1 credit (a relevance-reranked search_works list adds 10)." } : undefined,
  });
}
