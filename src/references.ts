/**
 * Free-text reference matching for resolve_references (oxjob #1328).
 *
 * Retrieval: the citation yields up to three title guesses (text.titleHypotheses). The best guess is searched with
 * all its words (title.search), and so is its main title when it reads "Main title: subtitle" (book records often
 * hold only the main title). Only when that finds no convincing match do the fallbacks run, in parallel: any of the
 * guess's six most distinctive words (an OR, which survives a typo, a glued surname or a symbol the record stores
 * differently, like Livak's 2^-ΔΔCT), the guess within the cited year +-1 (a short title shared by many papers), and
 * the next guess that isn't a venue.
 * Scoring: each candidate is scored on how much of the best-fitting guess its title holds, how much of its title the
 * citation holds, year, authors, venue, volume/first page (which pick the right copy of a co-published article), and
 * its type (a review, a peer review or a journal's front matter is not the cited work).
 */
import type { OpenAlexClient, ListResponse } from "./openalex";
import { titleCoverage, queryCoverage, extractYear, guessSurnames, titleHypotheses, contentTokens, venueness, venueCoverage, tokenKey, mainTitle } from "./text";

export type MatchLabel = "exact" | "likely" | "uncertain" | "none";

/** Fields in the order resolve_references prints them; matched_on is set only when there was a candidate. */
export interface FreeTextMatch {
  match: MatchLabel;
  matched_on?: "title";
  title_overlap?: number;
  year_consistent?: boolean | null;
  author_consistent?: boolean | null;
  work: any | null;
  note?: string;
}

/** primary = the citation's most title-like chunk or its main title; a later guess needs an author to agree. */
interface Guess { text: string; weight: number; primary: boolean; venue: boolean }
type Query = { filter: string; per_page: number };

/** Title words too common to pick a paper out of 250M; the OR fallback skips them when it can. */
const GENERIC = new Set(("analysis study studies using use based new effect effects role data method methods approach case review " +
  "results model models system systems research high low among between evaluation development application applications impact " +
  "influence towards toward assessment patients treatment two three different during").split(" "));

/** The proxy throttles title searches with more than 5 OR/AND/NOT, so the fallback ORs at most six words. */
const OR_WORDS = 6;
const PER_PAGE = 10;

export function orFallbackWords(guess: string): string[] {
  const words = [...new Set(contentTokens(guess))];
  const specific = words.filter((w) => !GENERIC.has(w));
  const pool = specific.length >= Math.min(3, words.length) ? specific : words;
  return [...pool].sort((a, b) => b.length - a.length).slice(0, OR_WORDS);
}

/** Records that carry a work's title without being it: a review of it, a peer review, a journal's front matter. */
const TYPE_PENALTY: Record<string, number> = { paratext: 0.6, "book-review": 0.3, "peer-review": 0.3, erratum: 0.3 };

/** A citation that names a book publisher or edition. */
const BOOKISH = /\b(press|publishers?|publishing|verlag|routledge|springer|wiley|elsevier|kluwer|sage|macmillan|blackwell|plenum|academic press|claypool|books|edn|edition|ed\.|eds\.)(?![\p{L}])/iu;
const PREPRINT = /\b(arxiv|preprint|biorxiv|medrxiv|ssrn|research square)\b/i;

interface Scored {
  w: any;
  precision: number;
  recall: number;
  yearOk: boolean | null;
  authorOk: boolean | null;
  score: number;
  /** Never an answer: a one-word title met through a venue fragment, front matter, or a later guess no author backs. */
  vetoed: boolean;
  /** The citation states volume or pages and this record's first page and volume both differ. */
  pagesDisagree: boolean;
}

function scoreCandidates(input: string, guesses: Guess[], works: any[]): Scored[] {
  const year = extractYear(input);
  const first = guesses[0]!;
  const surnames = guessSurnames(input, first.text);
  // Volume, issue, page and article numbers the citation states ("6(7):e1000097", "54(3) 1901647"), not its year.
  const citeNumbers = new Set((input.match(/\b[a-z]?\d+[a-z]?\b/gi) ?? []).map((n) => n.toLowerCase()).filter((n) => n !== String(year)));
  return works.map((w) => {
    const title = w.display_name ?? "";
    // How much of each guess the candidate's title holds; the best fit, weighted by the guess's rank, counts.
    // A later guess that reads as a venue ("Ceram. Int.", "PLoS Med") is never the cited work's title.
    let precision = 0;
    let weighted = 0;
    let fit = first;
    for (const [i, g] of guesses.entries()) {
      if (i > 0 && g.venue) continue;
      const p = queryCoverage(g.text, title);
      if (p * g.weight > weighted) { weighted = p * g.weight; precision = p; fit = g; }
    }
    const recall = titleCoverage(input, title); // candidate title found in the citation
    const yearOk = year === null ? null : w.publication_year != null && Math.abs(w.publication_year - year) <= 1;
    // Whole name words: "cell" must not match Marcello.
    const names = (w.authorships ?? []).map((a: any) => String(a?.author?.display_name ?? a?.raw_author_name ?? "").toLowerCase().split(/[^\p{L}'’-]+/u));
    const authorOk = !surnames.length || !names.length ? null : surnames.some((sn) => names.some((n: string[]) => n.includes(sn)));
    const src = w.primary_location?.source?.display_name ?? w.primary_location?.raw_source_name ?? null;
    const venue = venueCoverage(input, src, title);
    const b = w.biblio ?? {};
    const page = String(b.first_page ?? "").toLowerCase();
    const vol = String(b.volume ?? "").toLowerCase();
    const pageOk = page.length >= 2 && citeNumbers.has(page);
    const volumeOk = vol.length >= 1 && citeNumbers.has(vol) && (pageOk || vol.length >= 2);
    // A record named like a venue ("Advances in Neural Information Processing Systems 29", "IEEE Signal Processing
    // Magazine") is the container, not the cited work, unless the citation's own best title guess is a venue too.
    const container = !first.venue && venueness(title) >= 0.8 && queryCoverage(first.text, title) < 0.5;
    // A one-word title ("SuRF", "Oper") matches only when the citation's best guess (or its main title) is that word,
    // never through a venue fragment like "Surf. Coat. Technol." or "Comput. & Oper. Res.".
    const tooShort = contentTokens(title).length < 2 && !guesses.some((g) => g.primary && tokenKey(g.text) === tokenKey(title));
    const vetoed = tooShort || w.type === "paratext" || (!fit.primary && authorOk !== true);
    const score = weighted * (container ? 0.5 : 1) + 0.5 * recall + (yearOk ? 0.3 : 0) + (w.publication_year === year ? 0.05 : 0)
      + (authorOk ? 0.3 : 0) + 0.25 * venue + (pageOk ? 0.3 : 0) + (volumeOk ? 0.1 : 0) - (TYPE_PENALTY[w.type] ?? 0)
      + 0.01 * Math.log10(1 + (w.cited_by_count ?? 0));
    return { w, precision: container ? precision * 0.5 : precision, recall, yearOk, authorOk, score, vetoed, pagesDisagree: citeNumbers.size >= 2 && !!page && !pageOk && !volumeOk };
  }).sort((a, b) => b.score - a.score);
}

function label(best: Scored): MatchLabel {
  if (best.vetoed) return "none";
  const corroborated = best.yearOk === true || best.authorOk === true;
  const contradicted = best.yearOk === false || best.authorOk === false;
  if (best.precision >= 0.9 && best.recall >= 0.9 && !contradicted) return "exact";
  if (best.precision >= 0.85 && corroborated && !contradicted) return "likely";
  // The citation holds the candidate's whole title, and the year and an author agree: the guess carried extra words.
  if (best.recall >= 0.95 && contentTokens(best.w.display_name ?? "").length >= 3 && best.yearOk === true && best.authorOk === true) return "likely";
  if (best.precision >= 0.6 && best.recall >= 0.5 && !(best.yearOk === false && best.authorOk === false)) return "uncertain";
  return "none";
}

/**
 * Two records of one work (years within one, no author disagreeing, one title the other's main title or the same
 * title): when the best match is the weaker record, answer with the stronger one. Weaker: a review or front matter,
 * no DOI, a year the citation contradicts, a preprint the citation doesn't cite as one, or an article when the
 * citation names a book publisher. OpenAlex sometimes holds a book twice, e.g. the publisher's "Evolutionary Ecology
 * of Birds" (DOI) and a repository copy with the subtitle (no DOI). Never on citation counts alone: two DOI'd
 * articles sharing a main title are usually two papers.
 */
function canonical(input: string, best: Scored, scored: Scored[]): any {
  const citesBook = BOOKISH.test(input) && ["article", "book-review", "other", "report"].includes(best.w.type);
  const citesPublished = best.w.type === "preprint" && !PREPRINT.test(input);
  // How well a record's type fits the citation: 0 a review or front matter, 1 other/report/dataset, 2 a work, 3 the
  // kind of work the citation names (a book, or a published version).
  const fitRank = (w: any) => {
    const base = TYPE_PENALTY[w.type] ? 0 : ["other", "report", "dataset"].includes(w.type) ? 1 : 2;
    return base + ((citesBook && ["book", "book-chapter"].includes(w.type)) || (citesPublished && w.type !== "preprint") ? 1 : 0);
  };
  const sameWork = (a: Scored, b: Scored) => {
    const at = tokenKey(a.w.display_name ?? "");
    const bt = tokenKey(b.w.display_name ?? "");
    if (!at || !bt || !(at === bt || at.startsWith(bt + " ") || bt.startsWith(at + " "))) return false;
    if (a.w.publication_year == null || b.w.publication_year == null || Math.abs(a.w.publication_year - b.w.publication_year) > 1) return false;
    return a.authorOk !== false && b.authorOk !== false && (a.authorOk === true || b.authorOk === true);
  };
  const key = (s: Scored) => [fitRank(s.w), s.yearOk === true ? 1 : 0, s.w.doi ? 1 : 0, s.w.cited_by_count ?? 0];
  const upgrade = (c: Scored) => fitRank(c.w) > fitRank(best.w) || (best.yearOk === false && c.yearOk === true) || (!best.w.doi && !!c.w.doi);
  let pick = best;
  for (const c of scored) {
    if (c === best || !upgrade(c) || !sameWork(best, c) || contentTokens(c.w.display_name ?? "").length < 2) continue;
    const [k1, k2] = [key(c), key(pick)];
    const i = k1.findIndex((v, j) => v !== k2[j]);
    if (i >= 0 && k1[i]! > k2[i]!) pick = c;
  }
  return pick.w;
}

/** Run searches in parallel: each query's results (null if it failed); throws only if every one failed. */
async function search(client: OpenAlexClient, queries: Query[], select: string): Promise<Array<any[] | null>> {
  const settled = await Promise.allSettled(queries.map((q) => client.get<ListResponse>("/works", { ...q, select })));
  if (settled.length && settled.every((s) => s.status === "rejected")) throw (settled[0] as PromiseRejectedResult).reason;
  return settled.map((s) => (s.status === "fulfilled" ? s.value.results ?? [] : null));
}

const q = (text: string, extra = "", per_page = PER_PAGE): Query => ({ filter: `title.search:${text.replace(/,/g, " ")}${extra}`, per_page });

export async function matchFreeText(client: OpenAlexClient, input: string, select: string): Promise<FreeTextMatch> {
  const hyps = titleHypotheses(input, 3);
  const first = hyps[0]!;
  const main = mainTitle(first);
  const guesses: Guess[] = hyps.map((text, i) => ({ text, weight: [1, 0.85, 0.7][i]!, primary: i === 0, venue: venueness(text) >= 0.8 }));
  if (main) guesses.splice(1, 0, { text: main, weight: 0.9, primary: true, venue: false });
  const fields = `${select},biblio`;
  const year = extractYear(input);
  const years = year === null ? "" : `,publication_year:${year - 1}-${year + 1}`;
  const seen = new Map<string, any>();
  const add = (lists: Array<any[] | null>) => { for (const ws of lists) for (const w of ws ?? []) if (w?.id && !seen.has(w.id)) seen.set(w.id, w); };

  // A failed search (say a guess the API can't parse) still lets the other searches answer; the tool errors only
  // when no search succeeded at all.
  let failure: unknown = null;
  let anyOk = false;
  let firstResults: any[] | null = null;
  // The main-title record is the same work, so it shares the cited year; the filter keeps a short main title precise.
  try { const r = await search(client, [q(first), ...(main ? [q(main, years)] : [])], fields); anyOk = true; firstResults = r[0]!; add(r); } catch (e) { failure = e; }
  let scored = scoreCandidates(input, guesses, [...seen.values()]);
  // Done after one round trip only on an exact, corroborated title whose pages don't contradict the citation (a
  // co-published article's other copies may sit beyond the first ten results).
  const top = scored[0];
  const settled = top && label(top) === "exact" && (top.yearOk === true || top.authorOk === true) && !top.pagesDisagree;
  if (!settled) {
    const fallbacks: Query[] = [];
    const words = orFallbackWords(first);
    if (words.length >= 2) fallbacks.push({ filter: `title.search:${words.join(" OR ")}`, per_page: PER_PAGE });
    // The year filter only narrows the first search, so it adds nothing when that search returned every match.
    if (year !== null && !(firstResults && firstResults.length < PER_PAGE)) fallbacks.push(q(first, years));
    const next = guesses.find((g) => !g.primary && !g.venue);
    if (next) fallbacks.push(q(next.text, "", 5));
    if (fallbacks.length) try { add(await search(client, fallbacks, fields)); anyOk = true; } catch (e) { failure ??= e; }
    scored = scoreCandidates(input, guesses, [...seen.values()]);
  }
  if (!anyOk && failure) throw failure;
  const best = scored[0];
  if (!best) return { match: "none", work: null, note: "No work in OpenAlex has a similar title." };
  const match = label(best);
  return {
    match,
    matched_on: "title",
    title_overlap: Number(best.precision.toFixed(2)),
    year_consistent: best.yearOk,
    author_consistent: best.authorOk,
    work: match === "none" ? null : canonical(input, best, scored),
    note: match === "none"
      ? "Closest title in OpenAlex is not a convincing match; the reference may be garbled or fabricated."
      : match === "uncertain" ? "Partial title match; check the author list and year before trusting it." : undefined,
  };
}
