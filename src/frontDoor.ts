/**
 * The query writer's deterministic front door (oxjob #1494, Jason 2026-10-11): before any model, input that parses as
 * a Boolean search string runs exactly as written over title, abstract and keywords, and input that looks like a
 * pasted title gets a title lookup. In #1494's sample of real search-box strings, 63 of 200 were Boolean strings and
 * 44 pasted titles. Pure helpers here (unit-tested); queryText.ts runs them and checks the result on the live API.
 */

import { titleWords } from "./text";
import {
  REQUEST, keywordsOk, kindWord, parseId, readName, sameName, sameWords, worksOf,
  type Candidate, type IdKind, type NameReading, type OrgKind, type ParsedId,
} from "./plainInput";
import type { OpenAlexLike } from "./chat";
import { queryEcho } from "./oql";

export { titleWords };

export type SearchField = "title-abstract-keywords" | "title" | "abstract";

export interface BooleanSearch {
  /** The OQL query: `get works where <field> has (<the person's string, normalized>)`. */
  oql: string;
  field: SearchField;
  /** What was normalized or read differently, in plain words for the note. */
  notes: string[];
}

/**
 * A string with quotes or wildcards but no operator or field tag is a search string only with this few other words
 * (`"coverage path planning" survey`); two prose words around a phrase are a request ("Karya tentang "...""). Chosen on
 * #1494's tuning strings (no Boolean string lost) and checked on a fresh chat-phrased draw, 2026-10-11.
 */
const MAX_PLAIN_WORDS = 1;

// Database field tags and functions, by the OpenAlex field they search. MeSH and "all fields" read as words.
const TAG_FIELD: Array<[RegExp, SearchField | "words"]> = [
  [/^(?:ti|title)$/i, "title"],
  [/^(?:ab|abstract)$/i, "abstract"],
  [/^(?:tiab|title\/abstract|tw|text word|ti,ab|ti,ab,kw|ti,ab,kf|tw,kf|kw|kf|all fields|all|ts|topic)$/i, "title-abstract-keywords"],
  [/^(?:mh|mesh|mesh terms|majr|mesh major topic|sh|tn|nm|pt)(?::noexp)?$/i, "words"],
];
const FUNC_FIELD: Record<string, SearchField | "words"> = {
  "TITLE-ABS-KEY": "title-abstract-keywords", "TITLE-ABS": "title-abstract-keywords", "ALL": "title-abstract-keywords",
  "TITLE": "title", "ABS": "abstract", "KEY": "title-abstract-keywords", "AUTHKEY": "title-abstract-keywords",
  "TS": "title-abstract-keywords", "TI": "title", "AB": "abstract", "AK": "title-abstract-keywords",
  "KP": "title-abstract-keywords",
};

const SCOPUS_FILTERS = new Set(["AUTH", "AUTHOR", "AFFIL", "AFFILORG", "AFFILCOUNTRY", "SRCTITLE", "EXACTSRCTITLE", "PUBYEAR",
  "DOCTYPE", "LANGUAGE", "SUBJAREA", "SRCTYPE", "ISSN", "DOI", "REF", "FUND", "CHEM", "CONF", "PMID", "EDITOR", "PUBLISHER"]);

type Tok =
  | { t: "(" | ")" }
  | { t: "op"; v: "AND" | "OR" | "NOT" }
  | { t: "term"; v: string; quoted: boolean; field?: SearchField | "words"; stemmed?: boolean }
  | { t: "near"; n: number };

function tagField(tag: string): SearchField | "words" | null {
  const clean = tag.replace(/:~\d+$/, "").trim();
  for (const [re, f] of TAG_FIELD) if (re.test(clean)) return f;
  return null;
}

/** Curly quotes and guillemets to straight ones; a leading "1." list marker and line breaks out. */
export function cleanSearchText(text: string): string {
  return text
    .replace(/[“”„‟«»]/g, '"')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/^\s*\d{1,2}[.)]\s+/, "")
    // PubMed's history shows tags in parentheses: kelp (All Fields) -> kelp[All Fields]
    .replace(/\s*\((all fields|title\/abstract|title|abstract|mesh terms|text word|mesh major topic)\)/gi, "[$1]")
    .replace(/\s+/g, " ")
    .trim();
}

/** Tokens of a search string, or null when it has something a search string can't (an unknown field code). */
function tokenize(s: string, notes: Set<string>): Tok[] | null {
  const out: Tok[] = [];
  const scope: Array<SearchField | "words" | undefined> = [];
  let i = 0;
  const cur = () => scope[scope.length - 1];
  let stemNext = false;
  const boundary = (j: number) => j >= s.length || /[\s()[\]]/.test(s[j]);
  while (i < s.length) {
    const c = s[i];
    if (/\s|,/.test(c)) { i++; continue; }
    // Google style +"required term": required is what AND already means
    if (c === "+" && (i === 0 || /[\s(]/.test(s[i - 1])) && /["'(\p{L}\p{N}]/u.test(s[i + 1] ?? "")) { i++; continue; }
    // Scopus field functions: TITLE-ABS-KEY(...). PUBYEAR > 2015, LIMIT-TO(...), AUTH(...) are filters, not
    // searches: the model handles strings with those.
    const fn = s.slice(i).match(/^([A-Z][A-Z-]{1,15})\s*\(/);
    if (fn && !/^(AND|OR|NOT)$/.test(fn[1])) {
      if (fn[1] in FUNC_FIELD) {
        scope.push(FUNC_FIELD[fn[1]]);
        out.push({ t: "(" });
        i += fn[0].length;
        continue;
      }
      if (fn[1].includes("-") || SCOPUS_FILTERS.has(fn[1])) return null;
    }
    if (/^(?:PUBYEAR|SUBJAREA|DOCTYPE|LANGUAGE)\b/.test(s.slice(i))) return null;
    // Web of Science field codes: TS=(...) or TI=word
    const eq = s.slice(i).match(/^([A-Z]{2,3})\s*=\s*/);
    if (eq) {
      if (!(eq[1] in FUNC_FIELD)) return null;   // PY=, AU=, DT= ...: filters
      i += eq[0].length;
      if (s[i] === "(") {
        scope.push(FUNC_FIELD[eq[1]]);
        out.push({ t: "(" });
        i++;
        continue;
      }
      const m = s.slice(i).match(/^"[^"]*"|^[^\s()]+/);
      if (!m) return null;
      const quoted = m[0].startsWith('"');
      out.push({ t: "term", v: quoted ? m[0].slice(1, -1) : m[0], quoted, field: FUNC_FIELD[eq[1]] });
      i += m[0].length;
      continue;
    }
    if (c === "(") { scope.push(cur()); out.push({ t: "(" }); i++; continue; }
    if (c === ")") { scope.pop(); out.push({ t: ")" }); i++; continue; }
    if (c === "|") { out.push({ t: "op", v: "OR" }); i += s[i + 1] === "|" ? 2 : 1; continue; }
    if (c === "&") { out.push({ t: "op", v: "AND" }); i += s[i + 1] === "&" ? 2 : 1; continue; }
    // quoted phrases: "..." anywhere, '...' only at a word boundary (so Sjögren's stays a word)
    if (c === '"' || (c === "'" && (i === 0 || /[\s(]/.test(s[i - 1])))) {
      let j = s.indexOf(c, i + 1);
      if (c === "'") while (j > 0 && !boundary(j + 1) && s[j + 1] !== "[" && s[j + 1] !== "~") j = s.indexOf(c, j + 1);
      if (j < 0) return null;   // an unclosed quote: not a clean search string
      const v = s.slice(i + 1, j).trim();
      i = j + 1;
      let field = cur();
      const tag = s.slice(i).match(/^\[([^\]]+)\]/);
      if (tag) { field = tagField(tag[1]) ?? field; i += tag[0].length; }
      const slop = s.slice(i).match(/^~(\d+)/);
      if (slop) i += slop[0].length;
      if (v) out.push({ t: "term", v: slop ? `"${v}"~${slop[1]}` : v, quoted: !slop, field, ...(stemNext && !slop ? { stemmed: true } : {}) });
      else notes.add("empty");
      stemNext = false;
      continue;
    }
    const m = s.slice(i).match(/^[^\s()"|,[\]]+/);
    if (!m) { i++; continue; }
    let w = m[0];
    i += w.length;
    if (/^(AND|OR|NOT)$/.test(w)) { out.push({ t: "op", v: w as "AND" | "OR" | "NOT" }); continue; }
    // OQL's own `stemmed "phrase"` (a phrase kept together that keeps stemming): a modifier, not a word to find
    if (/^stemmed$/i.test(w) && /^\s*"/.test(s.slice(i))) { stemNext = true; continue; }
    // proximity: Scopus W/3 PRE/3, WoS NEAR/3 NEAR, Ovid ADJ3 ADJ
    const near = w.match(/^(?:W|PRE|NEAR|N)\/(\d+)$/) ?? w.match(/^(?:NEAR|ADJ)(\d*)$/);
    if (near) {
      out.push({ t: "near", n: Number(near[1] || 1) });
      continue;
    }
    if (w.endsWith("~")) { w = w.slice(0, -1); notes.add("fuzzy"); }
    w = w.replace(/\$$/, "*");
    let field = cur();
    const tag = s.slice(i).match(/^\[([^\]]+)\]/);
    if (tag) { field = tagField(tag[1]) ?? field; i += tag[0].length; }
    if (w) out.push({ t: "term", v: w, quoted: false, field });
  }
  return out;
}

/**
 * The person's input as a Boolean search string, or null when it isn't one (plain words with no Boolean syntax, a
 * question or request in prose, an unknown field code, unbalanced parentheses or quotes).
 */
export function booleanSearch(text: string): BooleanSearch | null {
  const s = cleanSearchText(text);
  if (!s || s.length > 2000 || /\?\s*$/.test(s)) return null;
  const flags = new Set<string>();
  let toks = tokenize(s, flags);
  if (!toks || !toks.length) return null;
  // lowercase and / or / not are operators only beside quoted phrases ('phthalic anhydride' and 'integration'), never
  // in prose or titles ("abelian surfaces and their moduli")
  const quotedCount = toks.filter((t) => t.t === "term" && t.quoted).length;
  if (quotedCount >= 2 || toks.some((t) => t.t === "op" || (t.t === "term" && t.field !== undefined))) {
    toks = toks.map((t) => (t.t === "term" && !t.quoted && /^(and|or|not)$/.test(t.v) ? { t: "op", v: t.v.toUpperCase() as any } : t));
  }
  const terms = toks.filter((t): t is Extract<Tok, { t: "term" }> => t.t === "term");
  if (!terms.length) return null;
  const plain = terms.filter((t) => !t.quoted && !/^".*"~\d+$/.test(t.v)).map((t) => t.v.toLowerCase());
  if (plain.some((w) => REQUEST.has(w.replace(/[*?]+$/, "")))) return null;
  // Boolean syntax: an operator, a field tag, a quoted phrase or a wildcard. Parentheses alone don't count: titles
  // have them ("... Neural Operator (F-FNO)").
  const strong = toks.some((t) => t.t === "op" || t.t === "near") || terms.some((t) => t.field !== undefined);
  const weak = quotedCount > 0 || terms.some((t) => /[*?]/.test(t.v));
  if (!strong && !weak) return null;
  // quotes alone, with many other words around them, is prose ("Finde die Arbeit "Zur Allgemeinen Relativitätstheorie"")
  if (!strong && plain.filter((w) => !/[*?]/.test(w)).length > MAX_PLAIN_WORDS) return null;
  // balanced parentheses, and no operator left dangling
  let depth = 0;
  for (const t of toks) { depth += t.t === "(" ? 1 : t.t === ")" ? -1 : 0; if (depth < 0) return null; }
  if (depth !== 0) return null;

  const notes: string[] = [];
  const fields = new Set(terms.map((t) => t.field ?? "title-abstract-keywords"));
  if (fields.has("words")) {
    notes.push("MeSH and similar headings were searched as words in titles, abstracts and keywords");
    fields.delete("words");
    fields.add("title-abstract-keywords");
  }
  let field: SearchField = "title-abstract-keywords";
  if (fields.size === 1) field = [...fields][0] as SearchField;
  else notes.push("the string mixes field tags; every term was searched in titles, abstracts and keywords");

  // rebuild the string: phrases quoted, operators in capitals, proximity between two single words as "a b"~n
  const parts: string[] = [];
  // what was last written: two bare words side by side stay as typed ("landscape archaeology"); any other pair of
  // terms or groups gets its AND written out, because the live parser drops a phrase's quotes after a bare word
  // (`survey "coverage path planning"` echoes as four loose words; reported to #1555, 2026-10-11)
  let last: "bare" | "other" | "op" = "op";
  const term = (s: string, bare: boolean) => {
    if (last !== "op" && !(bare && last === "bare")) parts.push("AND");
    parts.push(s);
    last = bare ? "bare" : "other";
  };
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.t === "(") { if (last !== "op") parts.push("AND"); parts.push("("); last = "op"; }
    else if (t.t === ")") { parts.push(")"); last = "other"; }
    else if (t.t === "op") { parts.push(t.v); last = "op"; }
    else if (t.t === "near") {
      const a = toks[k - 1];
      const b = toks[k + 1];
      if (a?.t === "term" && b?.t === "term" && !/\s/.test(a.v) && !/\s/.test(b.v) && !/[*?]/.test(a.v + b.v) && parts.length) {
        parts[parts.length - 1] = `"${a.v.replace(/"/g, "")} ${b.v.replace(/"/g, "")}"~${t.n}`;
        last = "other";
        k++;
      } else {
        parts.push("AND");
        last = "op";
        flags.add("near-and");
      }
    } else if (t.t === "term") term(t.quoted ? `${t.stemmed ? "stemmed " : ""}"${t.v.replace(/"/g, "")}"` : t.v, !t.quoted && !/^".*"~\d+$/.test(t.v));
  }
  // join, with no space after "(" or before ")"
  let out = parts.join(" ").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")");
  if (flags.has("empty")) {
    // an empty "" dropped: drop the operator it leaves dangling too ("Templeton World Charity Foundation" OR "")
    for (let prev = ""; prev !== out;) {
      prev = out;
      out = out.replace(/\(\s*(?:AND|OR|NOT)\s+/g, "(").replace(/\s+(?:AND|OR|NOT)\s*\)/g, ")")
        .replace(/^\s*(?:AND|OR)\s+/, "").replace(/\s+(?:AND|OR|NOT)\s*$/, "").replace(/\(\)/g, "").trim();
    }
    notes.push("an empty phrase (\"\") was left out");
  }
  // an operator next to "(" or ")" or at either end leaves the string broken: not a clean search string
  if (/(?:^|\()\s*(?:AND|OR)\b|\b(?:AND|OR|NOT)\s*(?:\)|$)/.test(out)) return null;
  out = out.replace(/\(\)/g, "").trim();
  if (!out) return null;
  if (flags.has("near-and")) notes.push("a proximity operator between phrases or groups ran as AND");
  if (flags.has("fuzzy")) notes.push("fuzzy matching (~) isn't supported; those words ran as typed");
  if (mixesWithoutParens(toks)) {
    notes.push("OR is mixed with AND or NOT without parentheses: the query shows how OpenAlex grouped them; add parentheses to group differently");
  }
  return { oql: `get works where ${field} has (${out})`, field, notes };
}

/** True when some parenthesis level has OR beside AND or NOT directly in it ("a AND b OR c", "a OR b NOT c"). */
function mixesWithoutParens(toks: Tok[]): boolean {
  const levels: Array<Set<string>> = [new Set()];
  for (const t of toks) {
    if (t.t === "(") levels.push(new Set());
    else if (t.t === ")") levels.pop();
    else if (t.t === "op") {
      const l = levels[levels.length - 1];
      l.add(t.v);
      if (l.has("OR") && (l.has("AND") || l.has("NOT"))) return true;
    }
  }
  return false;
}

// "Find the paper titled "..."", "Encuentra el artículo titulado "..."", "Trouve l'ouvrage intitulé « ... »"
const TITLED = /(?<!\p{L})(?:titled|entitled|called|named|title|titulado|titulada|intitulé|intitulée|intitulado|intitulada|intitolato|betitelt|mit dem titel|titel)(?![\p{L}_-])/iu;   // not a field tag: TITLE-ABS-KEY(...), title_and_abstract.search:

// A request's opening, not a title's: "Find ...", "Research on ...", "Studies about ..."
const REQUEST_OPENING = /^(?:(?:find|show|list|get|give|search|look)\b|(?:research|studies|study|papers|articles|works|publications|literature)\s+(?:on|about|into|regarding|concerning)\b)/i;

export interface TitleCandidate {
  title: string;
  /** Asked for by its title ("Find the paper titled "..."", "Finde die Arbeit mit dem Titel "...""). */
  explicit: boolean;
}

/**
 * The title to look up, when the input asks for a paper by its quoted title or looks like a pasted title; else null.
 * Shortcut: shape only (4-60 words, or 3 with a colon; 6 when it starts lowercase; not a request's opening).
 * lookupTitle accepts a lookup only when a work's title matches and the phrase is rare, which keeps most topic searches
 * out; the lowercase rule keeps out short topic searches that happen to be a real title.
 */
export function titleCandidate(text: string): TitleCandidate | null {
  const s = cleanSearchText(text);
  if (TITLED.test(s)) {
    const q = [...s.matchAll(/"([^"]{8,})"/g)].map((m) => m[1].trim()).sort((a, b) => b.length - a.length)[0];
    if (q && titleWords(q).length >= 3) return { title: q, explicit: true };
  }
  // one quoted phrase of four or more words, alone: a title first (frontDoor falls back to the phrase search)
  const whole = s.match(/^"([^"]+)"\.?$/);
  if (whole && titleWords(whole[1]).length >= 4) return { title: whole[1].trim(), explicit: false };
  if (booleanSearch(s) || REQUEST_OPENING.test(s)) return null;
  const n = titleWords(s).length;
  if (n > 60 || (n < 4 && !(n >= 3 && s.includes(":")))) return null;
  // a short all-lowercase string is a topic search more often than a title ("circular economy and finance": two works
  // carry that phrase, but the person wanted the topic; #1494 traffic sample, 2026-10-11)
  if (!/^\p{Lu}/u.test(s) && n < 6) return null;
  return { title: s.replace(/"/g, "").replace(/[.\s]+$/, ""), explicit: false };
}

/** True when a work's title is the pasted one: the same words, or the pasted words are its main title (before ":"). */
export function sameTitle(candidate: string, title: string | null | undefined): boolean {
  if (!title) return false;
  const a = titleWords(candidate).join(" ");
  const b = titleWords(title).join(" ");
  if (!a || !b) return false;
  if (a === b) return true;
  const main = titleWords(title.split(/[:.?]\s/)[0]).join(" ");
  return main.split(" ").length >= 4 && a === main;
}

// words a title search leaves out: too common to narrow it, and "and"/"or"/"not" would read as operators
const TITLE_STOP = new Set(["a", "an", "the", "of", "and", "or", "not", "in", "on", "for", "to", "with", "by", "from", "at", "as",
  "is", "are", "de", "la", "le", "les", "des", "du", "el", "los", "las", "y", "e", "et", "da", "do", "das", "dos", "der", "die",
  "und", "zur", "zum", "von"]);
const titleContent = (s: string) => titleWords(s).filter((w) => !TITLE_STOP.has(w));
/** Fewer words than this (stopwords aside) read as a topic, not a title with a word missing ("Macroeconomic effects of AI"). */
const MIN_NEAR_TITLE_WORDS = 5;
/** More words than this in a work's title beyond the pasted ones, and it isn't the same title. */
const MAX_EXTRA_TITLE_WORDS = 3;

/**
 * True when a work's title is the pasted one with a little missing or changed: every pasted word is in it (a pasted
 * word may be the start of the title's: "plot" in "plots"), and it has at most a few words more ("Embedding a
 * restricted class of partial designs" for "... partial K-4-designs"; a stripped "$L_1$ and $L_2$").
 */
export function nearTitle(candidate: string, title: string | null | undefined): boolean {
  if (!title) return false;
  const typed = titleContent(candidate);
  const got = titleContent(title);
  if (typed.length < MIN_NEAR_TITLE_WORDS) return false;
  const missing = typed.filter((w) => !got.some((g) => g === w || (w.length >= 4 && g.startsWith(w))));
  return missing.length === 0 && got.length <= typed.length + MAX_EXTRA_TITLE_WORDS;
}

/** The OQL for works whose titles have all of these words (any order, stemmed). */
export const titleWordsOql = (candidate: string) => `get works with (${titleContent(candidate).join(" ")}) in the title`;

export type FrontDoor<P> =
  | { path: "title" | "search_string" | "id" | "name" | "keywords"; oql: string; preview: P | TitlePreview; note: string }
  | { path: "model"; tried: string[] };

const SEARCHED: Record<SearchField, string> = {
  "title-abstract-keywords": "titles, abstracts and keywords", title: "titles", abstract: "abstracts",
};

/** The API calls the plain-input routes make (an OpenAlexClient satisfies it; tests pass a fake). */
export type Lookup = Pick<OpenAlexLike, "get" | "post">;

export interface FrontDoorOptions {
  /** The API, for the plain-input routes (an id, a name, keywords; plainInput.ts). Without it only titles and Boolean strings answer here. */
  oa?: Lookup;
  /** A follow-up edits the page's query ("only open access"): its words are never a fresh search, so only the model reads them. */
  followUp?: boolean;
  /** A one-word name that could also be keywords ("Cell") runs as keywords with a "did you mean" note; off, the model reads it. */
  oneWordNames?: boolean;
}

/**
 * The deterministic pass, in order: an identifier; a pasted title that a lookup confirms, unless the input is the full
 * name of an institution, journal, funder or person; a Boolean search string that runs; plain keywords; else the model
 * (`tried` says what was tried, for the response's meta). `run` is chat.ts's runOql. An answer comes with its note to
 * the person.
 */
export async function frontDoor<P extends TitlePreview>(text: string, run: (oql: string) => Promise<P>, opts: FrontDoorOptions = {}): Promise<FrontDoor<P>> {
  const tried: string[] = [];
  const oa = opts.followUp ? undefined : opts.oa;
  if (oa) {
    const id = parseId(text);
    if (id) {
      const hit = await lookupId<P>(oa, id);
      if (hit) return hit;
      tried.push("id");
    }
  }
  const t = titleCandidate(text);
  const b = booleanSearch(text);
  // names (and a sure name's works), keywords and the title's words are looked up beside the title, so none waits on
  // another
  let plain: { found: Promise<Plain | null>; named: Promise<FrontDoor<P> | null> } | null = null;
  if (oa && !b && !t?.explicit) {
    const found = lookupPlain(oa, text);
    plain = { found, named: found.then((r) => (r ? nameAnswer<P>(oa, text, r) : null)) };
  }
  // (a capitalized title only: "age-related low testosterone in men" is a topic)
  const near = oa && plain && t && /^\p{Lu}/u.test(t.title) && titleContent(t.title).length >= MIN_NEAR_TITLE_WORDS
    ? runQuick(oa, titleWordsOql(t.title)) : null;
  if (t) {
    // the front door's own query runs in one call when it has the API; a follow-up keeps runOql
    const hit = oa ? await lookupTitle((q) => runQuick(oa, q), t.title, t.explicit) : await lookupTitle(run, t.title, t.explicit);
    if (hit) {
      // the full name of a journal or institution is that thing, even when one paper carries it as a title
      // ("Journal of Healthcare Engineering"); a name that may be the thing, or may not, is the model's call
      // ("Journal of Scholarly Publishing": a journal, and five works with that title)
      const r = plain && nameWords(text) <= MAX_NAME_WORDS ? await plain.found : null;
      const name = plain && r ? await plain.named : null;
      if (name) return name;
      if (r?.reading?.route === "unsure") return { path: "model", tried: ["title", "name"] };
      const n = hit.preview.count ?? 0;
      return { path: "title", oql: hit.oql, preview: hit.preview, note: n === 1 ? "The paper with this title." : `The ${n} works with this title.` };
    }
    tried.push("title");
    if (t.explicit) return { path: "model", tried };   // a request in prose, never a search string
  }
  if (b) {
    const p = await run(b.oql);
    if (p.ok) {
      const note = `Your search string, run as written over ${SEARCHED[b.field]}${b.notes.length ? `; ${b.notes.join("; ")}` : ""}.`;
      return { path: "search_string", oql: p.canonical ?? b.oql, preview: p, note };
    }
    tried.push("search_string");
  }
  if (!plain) return { path: "model", tried };
  const r = await plain.found;
  if (!r) return { path: "model", tried: [...tried, "name"] };
  const name = await plain.named;
  if (name) return name;
  // a title pasted with a word missing or changed: the few works whose titles have all its words
  const nt = near ? await near : null;
  if (t && nt?.ok && nt.count && nt.count <= MAX_TITLE_HITS && (nt.top_rows ?? []).some((x) => nearTitle(t.title, x.name))) {
    return { path: "title", oql: nt.canonical ?? titleWordsOql(t.title), preview: nt, note: nt.count === 1 ? "The paper whose title has these words." : `The ${nt.count} works whose titles have these words.` };
  }
  let maybe = "";
  if (r.reading?.route === "unsure") {
    tried.push("name");
    if (!(opts.oneWordNames && nameWords(text) === 1)) return { path: "model", tried };
    const m = r.reading.maybe;
    maybe = ` Did you mean the ${kindWord(m)} ${m.name} (${m.id})?`;
  }
  if (r.kw.count && r.kwSame && keywordsOk(text)) {
    return { path: "keywords", oql: r.kw.canonical!, preview: r.kw, note: `Works with these words in the title, abstract or keywords.${maybe}` };
  }
  tried.push("keywords");
  return { path: "model", tried };
}

// ---- the plain-input routes' lookups (rules in plainInput.ts) ----------------------------------------------------

/** Notes for an id's works, by what it names. */
const ID_NOTE: Record<IdKind, string> = {
  work: "The work with this", author: "Works by the author with this", institution: "Works from the institution with this",
  source: "Works in the source with this", funder: "Works funded by the funder with this", publisher: "Works from the publisher with this",
  topic: "Works in the topic with this",
};

/** The preview rows the page and the API's answer show (runOql's too). */
export const rowsOf = (results: any) => (Array.isArray(results) ? results : []).slice(0, 5).map((x: any) => ({
  id: String(x.id ?? "").split("/").pop(), name: x.display_name ?? x.title, year: x.publication_year, cited_by: x.cited_by_count,
}));

/** A list response as an answer's preview: the count, the top rows and the API's echo of the query (names filled in). */
function previewOf(r: any, asked?: string): TitlePreview {
  const echo = queryEcho(r).oql ?? asked;   // a query we wrote stands for itself if the API sends no echo
  return typeof r?.meta?.count === "number" && echo ? { ok: true, canonical: echo, count: r.meta.count, top_rows: rowsOf(r.results) } : { ok: false };
}

/**
 * Run an OQL query the front door wrote itself in one call (runOql checks first, for the model's queries). Never
 * throws: ok is false on an error.
 */
async function runQuick(oa: Lookup, oql: string): Promise<TitlePreview> {
  try {
    return previewOf(await oa.post({ oql, per_page: 5 }), oql);
  } catch {
    return { ok: false };
  }
}

/** The works an identifier names; null when the lookup fails (the model takes over). */
async function lookupId<P>(oa: Lookup, id: ParsedId): Promise<FrontDoor<P> | null> {
  let oql = id.oql;
  if (!oql && id.resolve) {
    try {
      const e = await oa.get(id.resolve, { select: "id" });
      const short = String(e?.id ?? "").split("/").pop();
      if (short) oql = worksOf(id.kind, short);
    } catch {
      // not found: the works that carry the id, if any
    }
    oql = oql ?? id.fallback ?? null;
  }
  if (!oql) return null;
  const p = await runQuick(oa, oql);
  if (!p.ok) return null;
  const note = p.count ? `${ID_NOTE[id.kind]} ${id.scheme}.` : `Nothing in OpenAlex has this ${id.scheme}.`;
  return { path: "id", oql: p.canonical ?? oql, preview: p, note };
}

/** Longer input isn't looked up as a name (a journal's full name runs to 13 words); a person's, from 2 to 6 words. */
const MAX_NAME_WORDS = 15;
const MAX_PERSON_WORDS = 6;
const nameWords = (text: string) => titleWords(cleanSearchText(text)).length;

// the names each kind is known by besides its display name
const ORG_PATHS: Array<[OrgKind, string, string[]]> = [
  ["institution", "/institutions", ["display_name_alternatives", "display_name_acronyms"]],
  ["source", "/sources", ["alternate_titles", "abbreviated_title"]],
  ["funder", "/funders", ["alternate_titles"]],
];

interface Plain {
  /** What the input names; null when it is too long to be a name. */
  reading: NameReading | null;
  /** The keyword search: what openalex.org's box finds for the input, with the API's OQL for it as `canonical`. */
  kw: TitlePreview;
  /**
   * The keyword OQL finds the box's count. The API's OQL quotes some words (an "and", a word OQL reads as its own),
   * and a quoted word isn't stemmed, so when it quotes anything it is run to check ("Group analysis of fMRI data": 67
   * against the box's 78); a mismatch goes to the model.
   */
  kwSame: boolean;
}

/**
 * Search the input as institutions, sources, funders and authors, and as keywords, all at once. Null when a lookup
 * failed, so what the input names is unknown (the model reads it). Never throws.
 */
async function lookupPlain(oa: Lookup, text: string): Promise<Plain | null> {
  const s = cleanSearchText(text);
  const words = nameWords(text);
  const search = (path: string, select: string[], perPage: number) =>
    oa.get(path, { search: s, per_page: perPage, select: ["id", "display_name", "works_count", ...select].join(",") })
      .then((d: any) => (Array.isArray(d?.results) ? d.results : []))
      .catch(() => null);
  const names = words <= MAX_NAME_WORDS;
  const person = names && words >= 2 && words <= MAX_PERSON_WORDS && !/\d/.test(s);
  const kwFound = oa.get("/works", { "search.title_abstract_keywords": s, per_page: 5, select: "id,display_name,publication_year,cited_by_count" })
    .then(previewOf, (): TitlePreview => ({ ok: false }));
  const kwChecked = kwFound.then(async (k) => !k.ok || !k.canonical!.includes('"') || !keywordsOk(text)
    || (await runQuick(oa, k.canonical!)).count === k.count);
  const [kw, kwSame, people, ...orgs] = await Promise.all([
    kwFound, kwChecked,
    person ? search("/authors", ["display_name_alternatives"], 50) : Promise.resolve([]),
    ...ORG_PATHS.map(([kind, path, alts]) => (names ? search(path, kind === "source" ? [...alts, "type"] : alts, 10) : Promise.resolve([]))),
  ]);
  if (!kw.ok || people === null || orgs.some((o) => o === null)) return null;
  if (!names) return { reading: null, kw, kwSame };
  const cand = (kind: Candidate["kind"], x: any, other: string[]): Candidate => {
    const alts = other.flatMap((f) => (Array.isArray(x[f]) ? x[f] : x[f] ? [x[f]] : []));
    return {
      kind, id: String(x.id ?? "").split("/").pop() ?? "", name: String(x.display_name ?? ""), works: Number(x.works_count ?? 0),
      exact: sameName(s, [x.display_name, ...alts], kind === "author"), ...(x.type ? { type: String(x.type) } : {}),
      ...(kind === "author" && sameWords(s, [x.display_name, ...alts]) ? { sameWords: true } : {}),
    };
  };
  const orgCands = ORG_PATHS.flatMap(([kind, , other], i) => (orgs[i] as any[]).map((x) => cand(kind, x, other)));
  const peopleCands = (people as any[]).map((x) => cand("author", x, ["display_name_alternatives"]));
  return { reading: readName(s, orgCands, peopleCands, kw.count ?? 0), kw, kwSame };
}

/** The OQL and note for a name the input is sure to mean; null when it isn't one (keywords, unsure, or a failed run). */
async function nameAnswer<P>(oa: Lookup, text: string, r: Plain): Promise<FrontDoor<P> | null> {
  const n = r.reading;
  if (!n || n.route === "keywords" || n.route === "unsure") return null;
  const typed = cleanSearchText(text).replace(/"/g, "");
  let oql: string;
  let note: string;
  if (n.route === "org") {
    oql = worksOf(n.pick.kind as IdKind, n.pick.id);
    note = `Works ${n.pick.kind === "institution" ? "from" : n.pick.kind === "funder" ? "funded by" : "in"} ${n.pick.name}, the ${kindWord(n.pick)} with this name.`;
  } else if (n.route === "person") {
    oql = worksOf("author", n.pick.id);
    note = n.others.length
      ? `Works by ${n.pick.name}, the author named "${typed}" with the most works. Others with this name: ${n.others.map((c) => `${c.name} (${c.id})`).join(", ")}.`
      : `Works by ${n.pick.name}, the author with this name.`;
  } else {
    oql = `get authors where name has "${typed}", most cited first`;
    note = `Many authors are named "${typed}": pick one to see their works.`;
  }
  const p = await runQuick(oa, oql);
  if (!p.ok) return null;
  return { path: "name", oql: p.canonical ?? oql, preview: p, note };
}

/** More works than this share the phrase: a common phrase, not one paper's title ("Letter to the editor"). */
export const MAX_TITLE_HITS = 20;

export interface TitlePreview { ok: boolean; canonical?: string; count?: number | null; top_rows?: Array<Record<string, any>> }

/**
 * Look a title up: `get works where title has ("<title>")`. A pasted title is accepted only when one of the top works
 * carries that title and few works share the phrase; a title the person asked for by name ("titled ...") whenever any
 * work's title has it (reprints and versions included). Null otherwise (the model takes over). `run` is runOql.
 */
export async function lookupTitle<P extends TitlePreview>(run: (oql: string) => Promise<P>, candidate: string, explicit = false): Promise<{ oql: string; preview: P } | null> {
  const oql = `get works where title has ("${candidate.replace(/"/g, "")}")`;
  const p = await run(oql);
  if (!p.ok || !p.count) return null;
  if (explicit) return { oql: p.canonical ?? oql, preview: p };
  if (p.count > MAX_TITLE_HITS) return null;
  if (!(p.top_rows ?? []).some((r) => sameTitle(candidate, r.name))) return null;
  return { oql: p.canonical ?? oql, preview: p };
}
