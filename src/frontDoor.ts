/**
 * The query writer's deterministic front door (oxjob #1494, Jason 2026-10-11): before any model, input that parses as
 * a Boolean search string runs exactly as written over title, abstract and keywords, and input that looks like a
 * pasted title gets a title lookup. In #1494's sample of real search-box strings, 63 of 200 were Boolean strings and
 * 44 pasted titles. Pure helpers here (unit-tested); queryText.ts runs them and checks the result on the live API.
 */

import { fold } from "./text";

export type SearchField = "title-abstract-keywords" | "title" | "abstract";

export interface BooleanSearch {
  /** The OQL query: `get works where <field> has (<the person's string, normalized>)`. */
  oql: string;
  field: SearchField;
  /** What was normalized or read differently, in plain words for the note. */
  notes: string[];
}

// Words that make a string a request in prose rather than a search string ("papers on kelp AND climate since 2020"),
// in the languages of #1494's traffic sample. Prose in other languages is caught by MAX_PLAIN_WORDS when it has no
// operator ("Encontre trabalhos que mencionem "realidade virtual" e audiência").
const REQUEST = new Set(["find", "search", "show", "list", "give", "get", "me", "my", "our", "papers", "paper", "articles",
  "article", "works", "publications", "since", "between", "published", "about", "how", "what", "which", "who", "where",
  "when", "why", "many", "much", "most", "top", "cited", "citations", "count", "number", "percent", "percentage", "share",
  "rank", "ranking", "compare", "versus", "please", "want", "need", "looking", "can", "could", "would", "should", "do",
  "does", "did", "i", "we", "you",
  "buscar", "busca", "busque", "encontre", "encuentra", "encontrar", "trabajos", "trabalhos", "artículos", "artigos",
  "trouve", "trouver", "cherche", "travaux", "articles", "finde", "finden", "suche", "arbeiten", "finn", "cerca", "trova"]);
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
  | { t: "term"; v: string; quoted: boolean; field?: SearchField | "words" }
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
      if (v) out.push({ t: "term", v: slop ? `"${v}"~${slop[1]}` : v, quoted: !slop, field });
      else notes.add("empty");
      continue;
    }
    const m = s.slice(i).match(/^[^\s()"|,[\]]+/);
    if (!m) { i++; continue; }
    let w = m[0];
    i += w.length;
    if (/^(AND|OR|NOT)$/.test(w)) { out.push({ t: "op", v: w as "AND" | "OR" | "NOT" }); continue; }
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
    } else if (t.t === "term") term(t.quoted ? `"${t.v.replace(/"/g, "")}"` : t.v, !t.quoted && !/^".*"~\d+$/.test(t.v));
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
const TITLED = /(?<!\p{L})(?:titled|entitled|called|named|title|titulado|titulada|intitulé|intitulée|intitulado|intitulada|intitolato|betitelt|mit dem titel|titel)(?!\p{L})/iu;

/** Folded words of a title, stopwords kept, for comparing a pasted title with a work's. */
export function titleWords(s: string): string[] {
  return fold(s).match(/[\p{L}\p{N}]+/gu) ?? [];
}

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

export type FrontDoor<P> =
  | { path: "title" | "search_string"; oql: string; preview: P; note: string }
  | { path: "model"; tried: string[] };

const SEARCHED: Record<SearchField, string> = {
  "title-abstract-keywords": "titles, abstracts and keywords", title: "titles", abstract: "abstracts",
};

/**
 * The deterministic pass, in order: a pasted title that a lookup confirms; a Boolean search string that runs; else
 * the model (`tried` says what was tried, for the response's meta). `run` is chat.ts's runOql. An answer comes with
 * its note to the person.
 */
export async function frontDoor<P extends TitlePreview>(text: string, run: (oql: string) => Promise<P>): Promise<FrontDoor<P>> {
  const tried: string[] = [];
  const t = titleCandidate(text);
  if (t) {
    const hit = await lookupTitle(run, t.title, t.explicit);
    if (hit) {
      const n = hit.preview.count ?? 0;
      return { path: "title", oql: hit.oql, preview: hit.preview, note: n === 1 ? "The paper with this title." : `The ${n} works with this title.` };
    }
    tried.push("title");
    if (t.explicit) return { path: "model", tried };   // a request in prose, never a search string
  }
  const b = booleanSearch(text);
  if (b) {
    const p = await run(b.oql);
    if (p.ok) {
      const note = `Your search string, run as written over ${SEARCHED[b.field]}${b.notes.length ? `; ${b.notes.join("; ")}` : ""}.`;
      return { path: "search_string", oql: p.canonical ?? b.oql, preview: p, note };
    }
    tried.push("search_string");
  }
  return { path: "model", tried };
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
