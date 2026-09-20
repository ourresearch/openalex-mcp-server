/**
 * Author-name matching for profile curation. Ported from openalex-gui
 * `src/components/AuthorCuration/addWorksSearch.helpers.js` (oxjobs #187, #240, #882) so the
 * connector finds and attaches works the same way the website does. Pure, unit-tested.
 *
 * Two jobs:
 *   1. The name ladder: turn a person's name into progressively wider `raw_author_name.search`
 *      filter values (exact, reversed, initials, slop), which is how candidate works are found.
 *   2. The authorship gate: decide which byline on a work is this person, refusing to guess when
 *      the answer is ambiguous (the co-author-hijack fix, #882).
 */

/** Lower-case, fold accents, drop punctuation, flip "Family, Given" to "Given Family", split. */
export function nameTokens(name: string | null | undefined): string[] {
  let n = (name ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z, ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (n.includes(",")) {
    const p = n.split(",").map((x) => x.trim()).filter(Boolean);
    n = `${p[1] ? p[1] + " " : ""}${p[0] ?? ""}`;
  }
  return n.split(/\s+/).filter(Boolean);
}

/** Both readings of a comma name: flipped ("Family, Given") and literal ("Given, Family,"). */
export function nameTokenVariants(name: string | null | undefined): string[][] {
  const flipped = nameTokens(name);
  const literal = nameTokens((name ?? "").replace(/,/g, " "));
  const out: string[][] = [];
  if (flipped.length) out.push(flipped);
  if (literal.length && literal.join(" ") !== flipped.join(" ")) out.push(literal);
  return out;
}

export const LADDER_STEPS = 5;

/**
 * The OR'd quoted-phrase filter value for one rung of the ladder, or null when the name has no
 * tokens. Rungs: 1 as typed; 2 + comma-reversed and drop-middles forms; 3 + first-initial forms;
 * 4 the rung-3 set with slop ~1; 5 with slop ~2.
 */
export function buildLadderFilterValue(tokens: string[], step: number): string | null {
  if (!tokens.length) return null;
  const phrases: string[] = [];
  const seen = new Set<string>();
  const push = (p: string) => {
    const k = p.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    phrases.push(p);
  };
  push(tokens.join(" "));
  if (step >= 2 && tokens.length >= 2) {
    const last = tokens[tokens.length - 1];
    const first = tokens[0];
    const rest = tokens.slice(0, -1);
    push([last, ...rest].join(" "));
    if (tokens.length >= 3) {
      push(`${first} ${last}`);
      push(`${last} ${first}`);
    }
  }
  if (step >= 3 && tokens.length >= 2 && tokens[0].length > 1) {
    const first0 = tokens[0][0];
    const last = tokens[tokens.length - 1];
    push(`${first0} ${last}`);
    push(`${last} ${first0}`);
  }
  const slop = step === 4 ? 1 : step === 5 ? 2 : 0;
  const suffix = slop > 0 ? `~${slop}` : "";
  return phrases.map((p) => `"${p}"${suffix}`).join(" OR ");
}

/** Given-name token match: equal, or one is the initial of the other. */
export function givenMatch(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length === 1 && b.startsWith(a)) return true;
  if (b.length === 1 && a.startsWith(b)) return true;
  return false;
}

export interface AuthorshipLike {
  raw_author_name?: string | null;
  author?: { id?: string | null; display_name?: string | null; orcid?: string | null } | null;
  [k: string]: any;
}

const bylineOf = (a: AuthorshipLike) => a?.raw_author_name || a?.author?.display_name || "";

/** The strict gate: surname exact, first given token equal or an initial of the other. */
export function authorshipMatches(authorship: AuthorshipLike, qTokens: string[]): boolean {
  const cand = nameTokens(bylineOf(authorship));
  if (!cand.length || !qTokens.length) return false;
  if (qTokens[qTokens.length - 1] !== cand[cand.length - 1]) return false;
  if (qTokens.length === 1) return true;
  return givenMatch(qTokens[0], cand[0]);
}

/** Index of the first authorship passing the strict gate, or -1. */
export function findMatchedAuthorship(authorships: AuthorshipLike[], queryName: string): number {
  const q = nameTokens(queryName);
  if (!q.length || !authorships?.length) return -1;
  for (let i = 0; i < authorships.length; i++) if (authorshipMatches(authorships[i], q)) return i;
  return -1;
}

/** How many query tokens appear verbatim in the byline ("Jason Priem" > "J Priem"). */
export function fullMatchCount(authorship: AuthorshipLike, queryTokens: string[]): number {
  const cand = new Set(nameTokens(bylineOf(authorship)));
  if (!cand.size || !queryTokens.length) return 0;
  let n = 0;
  for (const q of queryTokens) if (cand.has(q)) n++;
  return n;
}

function tokensStrictMatch(qT: string[], cT: string[]): boolean {
  if (!qT.length || !cT.length) return false;
  if (qT[qT.length - 1] !== cT[cT.length - 1]) return false;
  if (qT.length === 1) return true;
  return givenMatch(qT[0], cT[0]);
}

function tokensInitialsMatch(qT: string[], cT: string[]): boolean {
  if (!qT.length || !cT.length) return false;
  const surname = qT[qT.length - 1];
  const si = cT.indexOf(surname);
  if (si < 0) return false;
  const rest = cT.slice(0, si).concat(cT.slice(si + 1));
  const givens = qT.slice(0, -1);
  if (!givens.length || !rest.length) return true;
  const used = new Array(rest.length).fill(false);
  for (const g of givens) {
    let found = -1;
    for (let i = 0; i < rest.length; i++) {
      if (!used[i] && givenMatch(g, rest[i])) { found = i; break; }
    }
    if (found < 0) return false;
    used[found] = true;
  }
  return true;
}

function tokensOverlapMatch(qT: string[], cT: string[]): boolean {
  const cSet = new Set(cT);
  return qT.some((t) => t.length >= 2 && cSet.has(t));
}

export type MatchTier = 1 | 2 | 3 | 4 | "ambiguous" | "none";

export interface CascadeResult {
  /** Index into authorships, or -1. */
  idx: number;
  tier: MatchTier;
  /** The winner for tiers 1-4, every tied slot for "ambiguous", [] for "none". */
  candidateIdxs: number[];
}

/**
 * Which byline is `queryName`? Strict rule first; then progressively looser rules, each accepted
 * only when it identifies exactly one byline. Two or more hits at a loose tier = "ambiguous":
 * refuse rather than attach the wrong co-author.
 */
export function findMatchedAuthorshipCascade(authorships: AuthorshipLike[], queryName: string): CascadeResult {
  const auths = authorships ?? [];
  if (!auths.length) return { idx: -1, tier: "none", candidateIdxs: [] };
  const qVariants = nameTokenVariants(queryName);
  if (!qVariants.length) return { idx: -1, tier: "none", candidateIdxs: [] };

  const strictIdx = findMatchedAuthorship(auths, queryName);
  if (strictIdx >= 0) return { idx: strictIdx, tier: 1, candidateIdxs: [strictIdx] };

  const candVariants = auths.map((a) => nameTokenVariants(bylineOf(a)));
  const tiers: Array<(i: number) => boolean> = [
    (i) => qVariants.some((q) => candVariants[i].some((c) => tokensStrictMatch(q, c))),
    (i) => candVariants[i].length > 0 && qVariants.some((q) => tokensInitialsMatch(q, candVariants[i][0])),
    (i) => candVariants[i].length > 0 && tokensOverlapMatch(qVariants[0], candVariants[i][0]),
  ];
  for (let t = 0; t < tiers.length; t++) {
    const hits: number[] = [];
    for (let i = 0; i < auths.length; i++) if (tiers[t](i)) hits.push(i);
    if (hits.length >= 2) return { idx: -1, tier: "ambiguous", candidateIdxs: hits };
    if (hits.length === 1) return { idx: hits[0], tier: (t + 2) as MatchTier, candidateIdxs: hits };
  }
  return { idx: -1, tier: "none", candidateIdxs: [] };
}

/** True when some byline on the work is already attributed to this author ID. */
export function authorshipIndexForAuthor(authorships: AuthorshipLike[], authorShortId: string): number {
  const target = authorShortId.toUpperCase();
  return (authorships ?? []).findIndex((a) => String(a?.author?.id ?? "").replace(/^https?:\/\/openalex\.org\//i, "").toUpperCase() === target);
}
