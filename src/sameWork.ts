/**
 * Which candidate, if any, is the cited work? One Jev Choice (TypeSafe's decision model) over up to five candidates
 * plus "none" and "unknown" (oxjob #1330). The request is the one oxjob #1318 measured (97.6% precise, 93.9% recall at
 * p >= 0.7 on 473 Opus-judged references) and the one the CV parser sends (openalex-api-proxy
 * workers/cv-parser/src/sameWork.ts); change neither without re-measuring.
 */
// The query writer's confidence check (queryText.ts) uses the same endpoint and pinned model; this light module owns
// them so the MCP Worker doesn't bundle the query writer to get two strings.
export const JEV_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-1.13.0";

export const MAX_CANDIDATES = 5;
const MAX_AUTHORS = 6;
const TIMEOUT_MS = 1000;
/** After a failed call, skip Jev for this long, across the isolate's requests: an outage costs one timeout, not one per reference. */
const PAUSE_MS = 60_000;
let pausedUntil = 0;
export function resetJevPause() { pausedUntil = 0; }

const INSTRUCTIONS =
  "`citation` is a reference-list entry or CV line written by a person. `candidates` are bibliographic records from a " +
  "scholarly index. Which candidate is the work the citation refers to? A preprint, accepted manuscript or reprint of the " +
  "same work counts as the same work. A different work with a similar title, or the same title by different authors or in a " +
  "different venue/year, does not. Author names may be formatted differently (order, initials, diacritics), venues abbreviated, years off by one.";

/** The fields Jev sees for one OpenAlex work. */
export function card(w: any, key: string) {
  const authorships: any[] = Array.isArray(w?.authorships) ? w.authorships : [];
  return {
    key,
    title: w?.display_name ?? w?.title ?? "",
    authors: authorships.slice(0, MAX_AUTHORS).map((a) => a?.author?.display_name ?? a?.raw_author_name ?? "").filter(Boolean),
    n_authors: authorships.length,
    year: w?.publication_year ?? null,
    venue: w?.primary_location?.source?.display_name ?? null,
    type: w?.type ?? null,
  };
}

export function buildRequest(citation: string, citationYear: number | null, works: any[]) {
  const candidates = works.map((w, i) => card(w, `c${i + 1}`));
  const criteria: Record<string, string> = {};
  for (const c of candidates) criteria[c.key] = `candidate ${c.key}`;
  criteria.none = "none of the candidates is the cited work";
  criteria.unknown = "cannot tell from the information given";
  return {
    model: JEV_MODEL,
    state: { citation, citation_year: citationYear, candidates },
    questions: { cited_work: { type: "choice", instructions: INSTRUCTIONS, criteria } },
  };
}

export interface SameWorkAnswer {
  /** True when a candidate (not "none" or "unknown") is Jev's top answer. */
  picked: boolean;
  /** Index into the works shown of the most probable candidate, and its probability (even when "none" won). */
  best: number;
  p: number;
}

/** Asks which of `works` (in the order given, at most MAX_CANDIDATES) the citation names; null when Jev can't answer. */
export type SameWorkJudge = (citation: string, citationYear: number | null, works: any[]) => Promise<SameWorkAnswer | null>;

export function jevJudge(apiKey: string, fetchImpl: typeof fetch = fetch, timeoutMs = TIMEOUT_MS): SameWorkJudge {
  return async (citation, citationYear, works) => {
    if (!works.length || Date.now() < pausedUntil) return null;
    const shown = works.slice(0, MAX_CANDIDATES);
    try {
      const res = await fetchImpl(JEV_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(buildRequest(citation, citationYear, shown)),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const probs: Record<string, unknown> | undefined = res.ok ? ((await res.json()) as any)?.answers?.cited_work?.probabilities : undefined;
      if (!probs || typeof probs !== "object") throw new Error(`Jev answered ${res.status}`);
      let top = -1, best = 0, p = -1, picked = false;
      for (const [k, v] of Object.entries(probs)) {
        if (typeof v !== "number") continue;
        const i = /^c(\d+)$/.exec(k) ? Number(k.slice(1)) - 1 : -1;
        const isCandidate = i >= 0 && i < shown.length;
        if (v > top) { top = v; picked = isCandidate; }
        if (isCandidate && v > p) { best = i; p = v; }
      }
      return { picked, best, p: Math.max(p, 0) };
    } catch {
      pausedUntil = Date.now() + PAUSE_MS;
      return null;
    }
  };
}
