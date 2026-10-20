/**
 * The no-new-words check (oxjob #1494, Jason 2026-10-11): every word in a text search the query writer submits must
 * come from what the person typed. Their stems, plurals and wildcards are fine; synonyms, related terms, translations
 * and spellings of the model's own are not. Measured before this check: models added unrequested search words in 39%
 * (Haiku) to 62% (Opus) of their text searches (#1555 rethink, 2026-10-11).
 *
 * Text searches are the `<field> has (...)` clauses of today's OQL (title, abstract, title-abstract,
 * title-abstract-keywords, full text) and the forms #1555's rewrite will echo: `works about (...)` and
 * `with (...) in the title`. Raw affiliation searches are names, not aboutness, and aren't checked. Pure, unit-tested.
 */
import { fold } from "./text";

const STOP = new Set(["a", "an", "the", "of", "and", "or", "not", "in", "on", "for", "to", "with", "by", "from", "at", "is",
  "are", "as", "vs", "via", "within", "words", "each", "other", "de", "la", "le", "et", "des", "du", "en", "el", "y", "di"]);

const FIELD = String.raw`(?<![\w-])(?:title-abstract-keywords|title-abstract|title|abstract|full\s+text|fulltext)\s+has\s+`;

/** The argument at s[i]: a balanced (...) group, a "quoted phrase", or one bare token. Returns [text, end]. */
function argAt(s: string, i: number): [string, number] | null {
  if (s[i] === "(") {
    let depth = 0;
    let inQuote = false;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (c === '"') inQuote = !inQuote;
      else if (!inQuote && c === "(") depth++;
      else if (!inQuote && c === ")" && --depth === 0) return [s.slice(i + 1, j), j + 1];
    }
    return [s.slice(i + 1), s.length];
  }
  if (s[i] === '"') {
    const j = s.indexOf('"', i + 1);
    return j < 0 ? [s.slice(i), s.length] : [s.slice(i, j + 1), j + 1];
  }
  const m = s.slice(i).match(/^[^\s;,)]+/);
  return m ? [m[0], i + m[0].length] : null;
}

/** The search strings of every text-search clause in an OQL query (compare items after `versus` included). */
export function searchStrings(oql: string): string[] {
  const out: string[] = [];
  const re = new RegExp(String.raw`${FIELD}|(?<![\w-])about\s+|(?<![\w-])with\s+(?=[("])`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(oql))) {
    let a = argAt(oql, m.index + m[0].length);
    if (!a) continue;
    const isWith = /^with\s/i.test(m[0]);
    if (isWith && !/^\s+in\s+the\s+(?:title|abstract|full\s+text|title\s+and\s+abstract)/i.test(oql.slice(a[1]))) continue;
    out.push(a[0]);
    // `compare title-abstract has "machine learning" versus "edge AI"`: each compared search
    for (let v = oql.slice(a[1]).match(/^\s+versus\s+/i); v; v = oql.slice(a[1]).match(/^\s+versus\s+/i)) {
      const next = argAt(oql, a[1] + v[0].length);
      if (!next || !/^[("]/.test(oql[a[1] + v[0].length])) break;
      out.push(next[0]);
      a = next;
    }
    re.lastIndex = a[1];
  }
  return out;
}

/** Words of a search string or of what the person typed: folded, operators and proximity dropped, wildcards kept. */
export function words(s: string): string[] {
  const t = fold(s.replace(/\bwithin\s+\d+\s+words\s+of\s+each\s+other\b/gi, " ").replace(/~\d+/g, " "));
  return (t.match(/[\p{L}\p{N}*?]+/gu) ?? []).filter((w) => w.replace(/[*?]/g, "").length > 1 && !STOP.has(w));
}

// Porter (1980) stemmer, as in Martin Porter's C version: enough to tell "teachers" from "teacher" the way a search
// engine's English stemming does. Shortcut: English rules only; other languages compare as typed (plus plurals in -s).
const cons = (w: string, i: number): boolean => {
  const c = w[i];
  if ("aeiou".includes(c)) return false;
  return c === "y" ? (i === 0 ? true : !cons(w, i - 1)) : true;
};
function measure(s: string): number {
  let n = 0;
  let i = 0;
  while (i < s.length && cons(s, i)) i++;
  while (i < s.length) {
    while (i < s.length && !cons(s, i)) i++;
    if (i >= s.length) break;
    while (i < s.length && cons(s, i)) i++;
    n++;
  }
  return n;
}
const hasVowel = (s: string) => [...s].some((_, i) => !cons(s, i));
const doubleCons = (s: string) => s.length > 1 && s[s.length - 1] === s[s.length - 2] && cons(s, s.length - 1);
const cvc = (s: string) => {
  const L = s.length;
  return L > 2 && cons(s, L - 3) && !cons(s, L - 2) && cons(s, L - 1) && !"wxy".includes(s[L - 1]);
};
/** Replace the first (longest) listed suffix w ends with, when the stem before it passes `ok`. */
function swap(w: string, table: Array<[string, string]>, ok: (stem: string) => boolean): string {
  for (const [suf, rep] of table) {
    if (w.endsWith(suf)) {
      const stem = w.slice(0, -suf.length);
      return ok(stem) ? stem + rep : w;
    }
  }
  return w;
}
const STEP2: Array<[string, string]> = [["ational", "ate"], ["ization", "ize"], ["iveness", "ive"], ["fulness", "ful"],
  ["ousness", "ous"], ["tional", "tion"], ["biliti", "ble"], ["entli", "ent"], ["ousli", "ous"], ["ation", "ate"],
  ["alism", "al"], ["aliti", "al"], ["iviti", "ive"], ["enci", "ence"], ["anci", "ance"], ["izer", "ize"], ["alli", "al"],
  ["ator", "ate"], ["logi", "log"], ["bli", "ble"], ["eli", "e"]];
const STEP3: Array<[string, string]> = [["icate", "ic"], ["ative", ""], ["alize", "al"], ["iciti", "ic"], ["ical", "ic"],
  ["ness", ""], ["ful", ""]];
const STEP4 = ["ement", "ance", "ence", "able", "ible", "ment", "ant", "ent", "ion", "ism", "ate", "iti", "ous", "ive",
  "ize", "al", "er", "ic", "ou"];

export function stem(word: string): string {
  let w = word;
  if (w.length <= 2 || !/^[a-z]+$/.test(w)) return w.length > 3 && /\p{L}s$/u.test(w) ? w.slice(0, -1) : w;
  // step 1a-b: plurals, -ed, -ing
  if (w.endsWith("sses") || w.endsWith("ies")) w = w.slice(0, -2);
  else if (!w.endsWith("ss") && w.endsWith("s")) w = w.slice(0, -1);
  if (w.endsWith("eed")) {
    if (measure(w.slice(0, -3)) > 0) w = w.slice(0, -1);
  } else {
    const suf = w.endsWith("ed") ? 2 : w.endsWith("ing") ? 3 : 0;
    if (suf && hasVowel(w.slice(0, -suf))) {
      w = w.slice(0, -suf);
      if (/(at|bl|iz)$/.test(w)) w += "e";
      else if (doubleCons(w) && !"lsz".includes(w[w.length - 1])) w = w.slice(0, -1);
      else if (measure(w) === 1 && cvc(w)) w += "e";
    }
  }
  // step 1c
  if (w.endsWith("y") && hasVowel(w.slice(0, -1))) w = w.slice(0, -1) + "i";
  w = swap(w, STEP2, (s) => measure(s) > 0);
  w = swap(w, STEP3, (s) => measure(s) > 0);
  for (const suf of STEP4) {
    if (w.endsWith(suf)) {
      const s = w.slice(0, -suf.length);
      if (suf === "ion" && !/[st]$/.test(s)) continue;
      if (measure(s) > 1) w = s;
      break;
    }
  }
  if (w.endsWith("e")) {
    const s = w.slice(0, -1);
    const a = measure(s);
    if (a > 1 || (a === 1 && !cvc(s))) w = s;
  }
  if (measure(w) > 1 && doubleCons(w) && w.endsWith("l")) w = w.slice(0, -1);
  return w;
}

export interface Vocabulary { raw: Set<string>; stems: Set<string> }

/** What the person typed, as words to match against: each word, its stem, and hyphenated words joined ("covid19"). */
export function typedVocabulary(texts: Array<string | null | undefined>): Vocabulary {
  const raw = new Set<string>();
  for (const raw0 of texts) {
    if (!raw0) continue;
    // A question mark that ends a word in prose ("...the hippocampus?") is punctuation, not a one-letter wildcard:
    // read it as the bare word too, or the last word of every question counts as never typed (2026-10-20).
    const t = raw0 + " " + raw0.replace(/(?<=[\p{L}\p{N}])\?+(?=[\s"'’”)\].,;:!]|$)/gu, "");
    for (const w of words(t)) raw.add(w);
    for (const w of words(t.replace(/(?<=[\p{L}\p{N}])[-‐–'’](?=[\p{L}\p{N}])/gu, ""))) raw.add(w);
  }
  return { raw, stems: new Set([...raw].map(stem)) };
}

/**
 * The search words of a query that the person never typed (an empty list when the query uses only their words).
 * A wildcard word passes when some typed word starts with its stem (`adolescen*` after "adolescents"). Pass a
 * Vocabulary (typedVocabulary) to check many queries against the same typed words.
 */
export function newWords(oql: string, typed: Array<string | null | undefined> | Vocabulary): string[] {
  const v = Array.isArray(typed) ? typedVocabulary(typed) : typed;
  const out = new Set<string>();
  for (const s of searchStrings(oql)) {
    for (const w of words(s)) {
      if (/[*?]/.test(w)) {
        const head = w.split(/[*?]/)[0];
        if (!head || [...v.raw].some((t) => t.startsWith(head))) continue;
        out.add(w);
      } else if (!v.raw.has(w) && !v.stems.has(stem(w))) {
        out.add(w);
      }
    }
  }
  return [...out];
}
