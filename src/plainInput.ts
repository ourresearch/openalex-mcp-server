/**
 * The front door's free routes for plain input (oxjob #2432): an identifier, the full name of one institution,
 * journal, funder or person, and plain keywords, each answered with no model. Most of what people type into
 * openalex.org's box is one of these (#1522: topic words 39%, names 20%, titles 15%, identifiers 2%), and the model
 * takes 4-8 s on each. The rules: assume the person wants works; when we're sure which thing they named, give that
 * thing's works; when it isn't a thing, search titles, abstracts and keywords, as openalex.org's box does; when it
 * could be either, the model decides (or, with ONE_WORD_NAMES=keywords, a one-word name runs as keywords with a
 * "did you mean" note). frontDoor.ts runs these after its Boolean and title checks.
 *
 * Pure helpers here (unit-tested): parseId, keywordsOk, readName. The lookups that feed them are in frontDoor.ts.
 */
import { fold, titleWords } from "./text";
import { arxivDoi, isSafeDoi } from "./ids";

// ---- identifiers -----------------------------------------------------------------------------------------------

export type IdKind = "work" | "author" | "institution" | "source" | "funder" | "publisher" | "topic";

export interface ParsedId {
  kind: IdKind;
  /** What the person pasted, named for the note: "DOI", "ORCID", "OpenAlex ID", "PMID", "PMCID", "arXiv ID", "ROR", "ISSN". */
  scheme: string;
  /** The OQL that lists the works, when it needs no lookup first; null when `resolve` must be looked up. */
  oql: string | null;
  /** The API path that resolves an external id to its OpenAlex record (ORCID, ROR, ISSN). */
  resolve?: string;
  /** The OQL to fall back on when the lookup finds nothing (works carrying the id), if there is one. */
  fallback?: string;
}

const OA_PREFIX: Record<string, IdKind> = { W: "work", A: "author", I: "institution", S: "source", F: "funder", P: "publisher", T: "topic" };

/** The OQL listing the works of an OpenAlex entity, by its id; the API's echo fills in the name. */
export function worksOf(kind: IdKind, id: string): string {
  switch (kind) {
    case "work": return `get works where openalex id is ${id}`;
    case "author": case "institution": return `get (${id})'s works`;
    case "source": return `get works in (${id})`;
    case "funder": return `get works funded by (${id})`;
    case "publisher": return `get works published by (${id})`;
    case "topic": return `get works in the topic (${id})`;
  }
}

/**
 * The input as one identifier, or null. The whole input must be the id (a URL form, a "doi:" or "PMID" label, and
 * a trailing period allowed): an id inside a sentence is a question for the model.
 */
export function parseId(text: string): ParsedId | null {
  const s = text.trim().replace(/[.,;]+$/, "").trim();
  if (!s || /\s/.test(s.replace(/^(?:doi|pmid|pmcid|pmc|arxiv|orcid|issn|ror)\s*:?\s+/i, ""))) return null;
  // DOI: bare, doi:, or a doi.org URL
  const doi = s.match(/^(?:doi:\s*|https?:\/\/(?:dx\.)?doi\.org\/)?(10\.\d{4,9}\/\S+)$/i);
  if (doi) return isSafeDoi(doi[1]) ? { kind: "work", scheme: "DOI", oql: `get works where DOI is ${doi[1]}` } : null;
  // ORCID: bare or an orcid.org URL
  const orcid = s.match(/^(?:orcid:\s*|https?:\/\/(?:www\.)?orcid\.org\/)?(\d{4}-\d{4}-\d{4}-\d{3}[\dX])\/?$/i);
  if (orcid) {
    const o = orcid[1].toUpperCase();
    return { kind: "author", scheme: "ORCID", oql: null, resolve: `/authors/orcid:${o}`, fallback: `get works where ORCID is ${o}` };
  }
  // OpenAlex ID: bare (W2741809807) or a URL (openalex.org/W..., openalex.org/works/W...). Topic ids are five digits,
  // others six or more, so a model number like "P2020" isn't read as an id.
  const oa = s.match(/^(?:https?:\/\/(?:api\.)?openalex\.org\/(?:(?:works|authors|institutions|sources|funders|publishers|topics)\/)?)?([WAISFPT])(\d+)$/i);
  if (oa) {
    const p = oa[1].toUpperCase();
    const digits = oa[2];
    if ((p === "T" && digits.length === 5) || (p !== "T" && digits.length >= 6)) {
      const kind = OA_PREFIX[p];
      return { kind, scheme: "OpenAlex ID", oql: worksOf(kind, p + digits) };
    }
    return null;
  }
  const pmid = s.match(/^pmid\s*:?\s*(\d{1,9})$/i);
  if (pmid) return { kind: "work", scheme: "PMID", oql: `get works where PMID is ${pmid[1]}` };
  const pmcid = s.match(/^(?:pmcid\s*:?\s*)?pmc\s*:?\s*(\d{4,9})$/i);
  if (pmcid) return { kind: "work", scheme: "PMCID", oql: `get works where PMCID is ${pmcid[1]}` };
  if (/arxiv/i.test(s) || /^\d{4}\.\d{4,5}(?:v\d+)?$/.test(s)) {
    const a = arxivDoi(s.replace(/^arxiv\s*:\s*/i, "arXiv:"));
    if (a) return { kind: "work", scheme: "arXiv ID", oql: `get works where DOI is ${a}` };
  }
  const ror = s.match(/^(?:ror:\s*|https?:\/\/(?:www\.)?ror\.org\/)(0[0-9a-z]{8})\/?$/i);
  if (ror) return { kind: "institution", scheme: "ROR", oql: null, resolve: `/institutions/ror:${ror[1].toLowerCase()}`, fallback: `get works where ROR ID is ${ror[1].toLowerCase()}` };
  const issn = s.match(/^(?:issn\s*:?\s*)?(\d{4}-\d{3}[\dX])$/i);
  if (issn) return { kind: "source", scheme: "ISSN", oql: null, resolve: `/sources/issn:${issn[1].toUpperCase()}`, fallback: `get works where ISSN is ${issn[1].toUpperCase()}` };
  return null;
}

// ---- plain keywords --------------------------------------------------------------------------------------------

/**
 * Words that make a string a request in prose rather than a search string ("papers on kelp AND climate since 2020"),
 * in the languages of #1494's traffic sample (frontDoor.ts's Boolean check compares them unfolded). Prose in other
 * languages is caught there by MAX_PLAIN_WORDS when it has no operator.
 */
export const REQUEST = new Set(["find", "search", "show", "list", "give", "get", "me", "my", "our", "papers", "paper", "articles",
  "article", "works", "publications", "since", "between", "published", "about", "how", "what", "which", "who", "where",
  "when", "why", "many", "much", "most", "top", "cited", "citations", "count", "number", "percent", "percentage", "share",
  "rank", "ranking", "compare", "versus", "please", "want", "need", "looking", "can", "could", "would", "should", "do",
  "does", "did", "i", "we", "you",
  "buscar", "busca", "busque", "encontre", "encuentra", "encontrar", "trabajos", "trabalhos", "artículos", "artigos",
  "trouve", "trouver", "cherche", "travaux", "articles", "finde", "finden", "suche", "arbeiten", "finn", "cerca", "trova"]);

// The same for plain input, plus the question and request words of the box's other languages (#1522: en, es, fr, zh,
// pt, de, id): "Tolong carikan paper mengenai matahari", "Facts about polar bears", "Artículo de medicina". Folded.
const ASKING = new Set([...REQUEST, "publication", "vs", "latest", "recent", "best", "journals",
  "artículo", "artigo", "sobre", "acerca", "qué", "cuál", "cuáles", "cuántos", "cuantos", "quais", "quantos",
  "comment", "pourquoi", "quels", "quelles", "wie", "warum", "welche", "über",
  "tolong", "carikan", "cari", "mengenai", "tentang", "bagaimana", "apa", "mengapa", "jurnal", "skripsi"].map(fold));

// A university, institute or journal named inside other words: the model reads the name and the topic apart.
// "university of ...", "Stanford University", and "... curtin university" at the end; not "part time student college".
const ORG_PATTERNS = [
  /(?<![\p{L}\p{N}])(?:university of|universidad|universidade|université|universität|università|universiteit|universitas|üniversitesi|institute of|instituto|journal of|revista|proceedings of)(?![\p{L}\p{N}])/iu,
  /\p{Lu}\p{L}+ (?:University|Institute|College)\b/u,
  /\p{L} university$/iu,
];

/** The words to search: quotes made straight, spaces collapsed. */
const keywordText = (text: string): string => text.trim().replace(/[“”„‟«»]/g, '"').replace(/\s+/g, " ");

/**
 * Plain words worth a keyword search: no question, request, year, citation or organization, and no Boolean syntax
 * left over from a string the Boolean check couldn't read (an unclosed quote, a dangling OR).
 */
export function keywordsOk(text: string): boolean {
  const s = keywordText(text);
  if (!s || /[?？¿]/.test(s) || /:\/\/|\bwww\./i.test(s)) return false;   // a question, or a link (a DOI prefix, a site)
  if (/\b(?:1[5-9]|20)\d{2}\b/.test(s) || /\bet al\b/i.test(s)) return false;   // a year or a citation: the model reads it
  if (ORG_PATTERNS.some((re) => re.test(s))) return false;
  // Boolean syntax the Boolean check couldn't read (an odd quote, an operator, a wildcard), or a citation's author list
  if ((s.match(/"/g) ?? []).length % 2 || /\b(?:AND|OR|NOT)\b/.test(s) || /\*/.test(s)) return false;
  if ((s.match(/\(/g) ?? []).length !== (s.match(/\)/g) ?? []).length) return false;   // "mentoring and industry 5.0) and type is (book"
  // grouping or quotes with a lowercase operator, or OQL's own words: a search string, not plain words
  // ("(logica) or (razonamiento) or ("sentido comun")", "not stemmed "mental health" and within 1 (mental, health)")
  if (/[()"]/.test(s) && (/(?<![\p{L}])(?:and|or|not)(?![\p{L}])/u.test(s) || /(?<![\p{L}])(?:stemmed|within)(?![\p{L}])/iu.test(s))) return false;
  if (/(?<![\p{L}])\p{Lu}\.\s*,/u.test(s)) return false;   // "Alarcón Díaz, N., Alarcón Díaz, O."
  const words = titleWords(s);
  return words.length > 0 && !words.some((w) => ASKING.has(w));
}

// ---- names -----------------------------------------------------------------------------------------------------

export type OrgKind = "institution" | "source" | "funder";

export interface Candidate {
  kind: OrgKind | "author";
  id: string;
  name: string;
  works: number;
  /** The input is this thing's name (its display name or one of its other names, ignoring case and accents). */
  exact: boolean;
  /** A source's type (journal, repository, conference...), for the note. */
  type?: string;
  /** Not the name, but the same words in another order ("Ahmed Gamal Mohammed" for "Gamal Ahmed Mohammed"). */
  sameWords?: boolean;
}

/** Folded words of a name: case, accents and punctuation off ("Martelo-Landroguez" = "martelo landroguez"). */
export const nameKey = (s: string) => titleWords(s).join(" ");
/**
 * A person's name typed family name first or last ("PARTHIBAN S" = "S. Parthiban", "Liu Yujie" = "Yujie Liu"): the
 * same words with the first or last moved to the other end. Any other order is another name ("Gamal Ahmed Mohammed"
 * isn't "Ahmed Gamal Mohammed").
 */
const personKeys = (s: string): string[] => {
  const all = nameKey(s).split(" ");
  const out: string[] = [];
  // a middle initial the person didn't type ("aric hagberg" for "Aric A. Hagberg"); a lone initial stays
  for (const w of [all, all.filter((x, i) => x.length > 1 || i === 0 || i === all.length - 1)]) {
    out.push(...[w, [...w.slice(1), w[0]], [w[w.length - 1], ...w.slice(0, -1)]].map((x) => x.join(" ")));
  }
  return out;
};

/** The thing's names that count as typing its name exactly. */
export function sameName(text: string, names: Array<string | null | undefined>, person = false): boolean {
  const k = nameKey(text);
  if (!k) return false;
  return names.some((n) => !!n && (person ? personKeys(n).includes(k) : nameKey(n) === k));
}

/** One of the names has exactly the typed words, in any order. */
export function sameWords(text: string, names: Array<string | null | undefined>): boolean {
  const sorted = (s: string) => nameKey(s).split(" ").sort().join(" ");
  const k = sorted(text);
  return !!k && names.some((n) => !!n && sorted(n) === k);
}

/**
 * An organization whose works are fewer than this share of the keyword search's isn't a likely reading ("Ocean
 * Dynamics", a journal of 3,575 works, against 64,648 works about ocean dynamics).
 */
const ORG_SHARE = 0.1;
/** The same for the people of that name together ("Kelp", an author of 4 works, against 16,050 works about kelp). */
const PERSON_SHARE = 0.1;
/**
 * A one-word name counts as a reading from this many works up ("Cell", the journal, 27,158 works, against 13.7 million
 * works about cells; not "Nanomedicine", a journal of 3,766).
 */
const ONE_WORD_MIN_WORKS = 10000;
/** Two organizations of the same name: the bigger one is the reading when it has this many times the works (Harvard University the institution, 973K, and the funder, 47K). */
const ORG_LEAD = 5;
/** One person's profile is the reading when it holds this share of the works of everyone by that name (profile splits). */
const PERSON_LEAD = 0.8;
/** People of the same name offered as choices; more than this and the page lists the authors instead. */
const MAX_PEOPLE = 4;

const byWorks = (cs: Candidate[]) => [...cs].sort((a, b) => b.works - a.works);
const sumWorks = (cs: Candidate[]) => cs.reduce((n, c) => n + c.works, 0);

export type NameReading =
  | { route: "org"; pick: Candidate }
  | { route: "person"; pick: Candidate; others: Candidate[] }
  | { route: "people" }
  | { route: "keywords" }
  /** Readable as a name and as keywords: the model decides, or a one-word name runs as keywords with a note. */
  | { route: "unsure"; maybe: Candidate };

/**
 * What plain input names, from the lookups: `orgs` (institutions, sources, funders found by searching the input),
 * `people` (authors found the same way) and `kw` (how many works a keyword search finds). Only exact names count, and
 * only when they are a likely reading beside the keyword search. A full name (two or more words) of one organization
 * that outweighs the keyword search is that organization; of a person, that person (or the few people of that name to
 * pick from, or the list of them); a one-word name never decides alone.
 */
export function readName(text: string, orgs: Candidate[], people: Candidate[], kw: number): NameReading {
  const key = nameKey(text);
  if (!key.includes(" ")) {
    // one word: never decides alone. An exact name with real weight, or a place or short name whose institution
    // outweighs the words ("Michigan": the University of Michigan), makes it unsure.
    const named = byWorks(orgs.filter((c) => c.exact && c.works >= ONE_WORD_MIN_WORKS));
    const within = byWorks(orgs.filter((c) => !c.exact && c.kind === "institution" && ` ${nameKey(c.name)} `.includes(` ${key} `)
      && c.works >= kw && c.works >= ONE_WORD_MIN_WORKS));
    const maybe = named[0] ?? within[0];
    return maybe ? { route: "unsure", maybe } : { route: "keywords" };
  }
  const o = byWorks(orgs.filter((c) => c.exact && c.works > 0 && c.works >= ORG_SHARE * kw));
  const p = byWorks(people.filter((c) => c.exact && c.works > 0));
  const peopleWorks = sumWorks(p);
  const likelyPeople = p.length > 0 && peopleWorks >= PERSON_SHARE * kw;
  if (o.length && likelyPeople) return { route: "unsure", maybe: o[0] };
  if (o.length) {
    const [top, next] = o;
    if (top.works >= kw && (!next || top.works >= ORG_LEAD * next.works)) return { route: "org", pick: top };
    return { route: "unsure", maybe: top };
  }
  if (likelyPeople) {
    const [top] = p;
    // profiles with a real share of the works; the 1-work splits of one person don't make the name ambiguous
    const real = p.filter((c) => c.works >= 0.05 * top.works);
    if (top.works >= PERSON_LEAD * peopleWorks || real.length === 1) return { route: "person", pick: top, others: real.slice(1, 3) };
    if (real.length <= MAX_PEOPLE) return { route: "person", pick: top, others: real.slice(1, MAX_PEOPLE) };
    return { route: "people" };
  }
  // no one has the name, but people have its words in another order: a name, but whose isn't sure
  const reordered = byWorks(people.filter((c) => c.sameWords && c.works > 0));
  if (reordered.length && sumWorks(reordered) >= PERSON_SHARE * kw) return { route: "unsure", maybe: reordered[0] };
  return { route: "keywords" };
}

/** What the thing is, in the note's words: "institution", "journal", "repository", "funder", "author". */
export const kindWord = (c: Candidate) => (c.kind === "source" ? (c.type ?? "source").replace(/_/g, " ") : c.kind);
