/** Small text helpers for reference matching. Pure, unit-tested. */

const STOP = new Set(["a", "an", "the", "of", "and", "or", "in", "on", "for", "to", "with", "by", "from", "at", "is", "are", "vs", "via"]);

/** Lowercase, accents off, every script kept ("Arañas" -> "aranas", Cyrillic stays Cyrillic). */
export const fold = (s: string) => s.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "");

export function tokens(s: string | null | undefined): Set<string> {
  if (!s) return new Set();
  return new Set(
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .split(" ")
      .filter((t) => t.length > 1 && !STOP.has(t))
  );
}

/** Share of the candidate title's tokens that appear in the query (0..1). */
export function titleCoverage(query: string, title: string | null | undefined): number {
  const q = tokens(query);
  const t = tokens(title);
  if (!t.size) return 0;
  let hit = 0;
  for (const w of t) if (q.has(w)) hit++;
  return hit / t.size;
}

/** Pull a 4-digit year out of a citation string, if any. */
export function extractYear(s: string): number | null {
  const m = s.match(/\b(1[89]\d{2}|20\d{2})\b/);
  return m ? Number(m[1]) : null;
}

/** Find a DOI anywhere in a string. */
export function extractDoi(s: string): string | null {
  const m = s.match(/\b(10\.\d{4,9}\/[^\s"'<>]+)/i);
  if (!m) return null;
  return m[1].replace(/[.,;:)\]]+$/, "");
}

/** Page numbers, volumes and article numbers ("521", "e1000097", "s48", "4b") say nothing about a title. */
const isNumberish = (t: string) => /^\d+$/.test(t) || /^[a-z]{1,2}\d+$/.test(t) || /^\d+[a-z]$/.test(t);

/** Title words of a chunk: tokens() without page numbers and volumes. */
export const contentTokens = (s: string) => [...tokens(s)].filter((t) => !isNumberish(t));

/** An order-free key for "same words" comparisons of two titles. */
export const tokenKey = (s: string) => [...tokens(s)].join(" ");

/** Abbreviated journal-name words that are not English words ("J Biol Chem", "Clin Dermatol", "Phys. Plasmas"). */
const ABBREV = new Set(("j am soc med natl acad sci biol chem phys res rev int clin eng lett proc trans ann bull appl " +
  "environ technol mater surg mol biochem anal comput struct mech geophys ecol psychol pharmacol neurosci immunol microbiol " +
  "physiol endocrinol cardiol oncol dermatol pediatr obstet gynecol epidemiol nutr agric commun syst inf inform sens electron " +
  "opt quant renew sustain manag econ financ educ stud philos hist ling nurs dent vet anim pathol genet genom evol zool bot " +
  "entomol hydrol meteorol atmos geol geogr astrophys astron math stat probab theor exp nucl therm ceram polym compos metall " +
  "corros catal electrochem photochem spectrosc crystallogr biophys biomed biotechnol bioinform pharm toxicol ther rehabil " +
  "orthop neurol neurosurg ophthalmol otolaryngol radiol urol nephrol gastroenterol hepatol respir crit infect dis hematol " +
  "rheumatol plast reconstr anesth emerg prev trop hyg parasitol virol adv conf symp ieee acm asme aiaa spie assoc dev " +
  "psychiatr ind eur jpn chin br aust arch acta rep jama bmj plos nat jhep prog curr opin").split(" "));

/** Words that mark a venue, publisher or report rather than a title. */
const VENUE_WORDS = /\b(journal|proceedings|proc|conference|symposium|workshop|transactions|magazine|bulletin|annals|press|publishers?|publishing|publications|verlag|editora|editorial|arxiv|preprint|biorxiv|medrxiv|ssrn|springer|elsevier|wiley|routledge|kluwer|blackwell|thesis|dissertation|patent|revista|revue|dergisi|zeitschrift|rivista|lecture notes|vol|pp|edn|eds?|unpublished|accessed)\b/i;

/** How much a chunk looks like a venue, publisher or place rather than a title (0..1). */
export function venueness(chunk: string): number {
  const c = chunk.trim();
  if (c.split(/\s*,\s*/).every((p) => PLACE.test(p))) return 1;
  if (/^(in:|paper presented|presented at|proceedings|proc\.)/i.test(c)) return 1;
  // "In LPNMR", "In NAACL-HLT" (a short venue after "In"); not "In vivo ..." or "In Defense of Food".
  if (/^In\s+[A-Z]/.test(c) && c.split(/\s+/).length <= 4) return 1;
  // "Cambridge, MA: Harvard University Press", "London: Routledge", "New York, NY: Springer"
  const place = c.match(/^([A-Z][\p{L}.' -]{1,30}?)(?:,\s*([A-Z][\p{L}.]{1,12}))?:\s*(\S.*)$/u);
  if (place && (PLACE.test(place[1]!.trim()) || (VENUE_WORDS.test(place[3]!) && place[3]!.split(/\s+/).length <= 5))) return 1;
  const words = c.split(/[\s,]+/).filter(Boolean);
  const abbreviated = words.filter((w) => /^[A-Z][a-z]{0,6}\.$/.test(w) || ABBREV.has(w.toLowerCase().replace(/\.$/, ""))).length;
  if (words.length <= 8 && abbreviated / words.length >= 0.5) return 0.9;
  if (VENUE_WORDS.test(c) && contentTokens(c).length <= 10) return 0.8;
  // "Advances in Neural Information Processing Systems", "Lecture Notes in Computer Science": a series in Title Case.
  if (/^(advances|lecture notes|progress|topics|studies|methods) in\b/i.test(c) && words.slice(2).every((w) => /^[A-Z\d]/.test(w) || STOP.has(w))) return 0.8;
  return 0;
}

// A comma-separated byline: "W. Zhou", "J.-P. Sartre", "Hellstrom, W.J.", "Ahmad GN", "and H. Niu", "& Clarke".
const NAME_SEG = /^(?:(?:and|&)\s+)?(?:(?:[A-Z]\.\s?-?){1,3}\s*[A-Z][\p{L}'’-]+(?:\s+[A-Z][\p{L}'’-]+)?|[\p{Lu}a-z][\p{L}'’-]+(?:\s+[A-Z][\p{L}'’-]+)?\s+(?:[A-Z]{1,3}|(?:[A-Z]\.){1,3}|(?:[A-Z]\s){1,2}[A-Z])|(?:[A-Z]\.\s?-?){1,3}|[A-Z][\p{L}'’-]+)$/u;
const PLACE = /^(london|oxford|cambridge|new york|ny|ma|nj|ca|boston|chicago|berlin|heidelberg|dordrecht|amsterdam|paris|cham|switzerland|the netherlands|netherlands|singapore|tokyo|philadelphia|washington|dc|usa|us|uk|france|germany|italy|spain|china|japan|canada|australia|india|brazil|january|february|march|april|may|june|july|august|september|october|november|december)$/i;

const SEG_SPLIT = /(\s*,\s*|\s+(?=(?:and|&)\s+[A-Z]))/;
const bylineSegs = (chunk: string) => chunk.split(SEG_SPLIT).filter((s, i) => i % 2 === 0 && s);
const isName = (seg: string) => NAME_SEG.test(seg);
// A lone capitalized word is only a name inside a byline that has initials somewhere.
const hasInitials = (segs: string[]) => segs.some((s) => /(^|\s)[A-Z]\.|\s[A-Z]{1,3}$/.test(s));

/** A chunk that is nothing but names ("Hanahan D, Weinberg RA", "W. Zhou, D. Liu and H. Niu"). */
function isByline(chunk: string): boolean {
  const segs = bylineSegs(chunk);
  return segs.length > 0 && segs.every(isName) && hasInitials(segs);
}

/** Drop a leading comma-separated author list and trailing venue pieces from a chunk. */
function trimChunk(chunk: string): string {
  if (isByline(chunk)) return chunk;
  // parts alternates segment, separator, segment...; trimming keeps the original separators.
  let parts = chunk.split(SEG_SPLIT);
  const text = (p: string[]) => p.join("");
  let lead = 0;
  while (lead + 2 < parts.length && isName(parts[lead]!)) lead += 2;
  if (lead && !hasInitials(parts.filter((_, i) => i < lead && i % 2 === 0))) lead = 0;
  if (lead && contentTokens(text(parts.slice(lead))).length >= 2) parts = parts.slice(lead);
  while (parts.length > 2) {
    const last = parts[parts.length - 1]!;
    const junk = venueness(last) >= 0.8 || /^[A-Z]\.?$/.test(last) || contentTokens(last).length === 0
      || /^(vol(ume)?|issue|no|nos|nr|number|pp?|pages?|part|suppl?)\.?\s*[\divx]/i.test(last);
    if (!junk || contentTokens(text(parts.slice(0, -2))).length < 2) break;
    parts = parts.slice(0, -2);
  }
  return text(parts);
}

/**
 * Candidate titles of a free-text citation, most title-like first (at most `max`, distinct).
 * Heuristic: drop links, ids, notes and years, split into chunks, trim bylines and venue pieces off each chunk,
 * then score by title words, penalising author-list signals (commas, initials) and venue signals.
 */
export function titleHypotheses(citation: string, max = 3): string[] {
  let s = citation.replace(/\s+/g, " ").replace(/^\s*(\[\d+\]|\d{1,3}[.)])\s+/, "");
  s = s.replace(/\bhttps?:\/\/\S+/g, " ¶ ").replace(/\bdoi:\s*\S+/gi, " ¶ ").replace(/\barxiv:\s*\d{4}\.\d{4,5}(v\d+)?/gi, " ¶ ");
  s = s.replace(/\b(available (at|from|online)|dispon[ií]vel em|disponible en|retrieved from|accessed|acesso em|consultado el)\b[^.]*\.?/gi, " ¶ ");
  s = s.replace(/\[[^\]]{0,40}\]/g, " ¶ ").replace(/\.(?=[A-Z][a-z])/g, ". ");
  // Springer-style byline ending in a colon: "Kabsch, W.: A solution...", "Cao, J., Yang, J.: Mechanical...".
  s = s.replace(/^((?:(?:and\s+|&\s+)?[\p{Lu}][\p{L}'’-]+(?:[ -][\p{Lu}][\p{L}'’-]+)*,\s*(?:[\p{Lu}]\.\s?-?){1,3},?\s*)+):\s+/u, " ¶ ");
  // Removed fragments leave a ¶ sentinel so the pieces around them become separate chunks.
  s = s.replace(/\bet\s+al\.?/gi, " ¶ ");
  // A year separates only where punctuation follows it ("2015;521", "1973. The", "2020, Defending"), so a year
  // inside a title ("The PRISMA 2020 statement", "Global cancer statistics 2018: GLOBOCAN") stays.
  s = s.replace(/\(\s*(1[89]\d{2}|20\d{2})[a-z]?\s*\)/g, " ¶ ").replace(/\b(1[89]\d{2}|20\d{2})[a-z]?\b(?=\s*(?:[.;,)]|$|:\s*\d))\.?/g, " ¶ ");
  s = s.replace(/\s*\((?=[^)]*\b(press|publishers?|springer|elsevier|wiley|routledge|kluwer|university)\b)[^)]*\)?/gi, " ¶ ");
  s = s.replace(/,?\s+in:\s+/gi, " ¶ In: ");
  // Initials inside a byline ("W. Zhou,", "P. M. Bennett and") must not end a chunk.
  s = s.replace(/\b((?:[A-Z]\.[ ]?-?){1,3})(?=[A-Z][\p{L}'’-]+(?:[ ][A-Z][\p{L}'’-]+)?(?:,|[ ]+and\b|[ ]*&))/gu, (m) => m.replace(/ /g, "\u00a0"));
  const out: string[] = [];
  // A quoted span is usually the title ("Preface," / « Sur la notion de minorité »), but can be a quoted subtitle,
  // so it competes with the other chunks, with a head start.
  const q = s.match(/[“"«‘]\s*([^”"»’]{15,}?)\s*[”"»’]/);
  const quoted = q?.[1]?.replace(/[\s,.:;]+$/, "").trim();
  if (q) s = s.replace(q[0], " ¶ ");
  const chunks = s
    .split(/(?<=[.?!])[ ]+|[ ]*[.][ ]+(?=[A-Z])|;[ ]+|[ ]*¶[ ]*/)
    .map((c) => trimChunk(c.replace(/^[\s,.:;]+|[\s,.:;]+$/g, "")).replace(/\u00a0/g, " "))
    .filter((c) => c.length > 0);
  if (quoted) chunks.unshift(quoted);
  const scored = chunks.map((c, i) => {
    const words = c.split(/\s+/);
    const initials = words.filter((w) => /^(?:[A-Z]\.?|[A-Z]{2}[.,]|[A-Z]\.[A-Z]\.?),?$/.test(w)).length;
    const commas = (c.match(/,/g) ?? []).length;
    const content = contentTokens(c).length;
    // A chunk without title words ("11(2):186-8") loses to any chunk with some, however many commas that one has.
    const score = isByline(c) ? -50 : !content ? -100 : content * (1 - 0.8 * venueness(c)) - 1.5 * commas - 2 * initials + (quoted && i === 0 ? 2 : 0);
    return { c, i, score, len: c.length };
  });
  scored.sort((a, b) => b.score - a.score || b.len - a.len || a.i - b.i);
  for (const { c, score } of scored) {
    if (out.length >= max) break;
    if (score <= 0 && out.length) break;
    const key = tokenKey(c);
    if (key && !out.some((o) => tokenKey(o) === key)) out.push(c);
  }
  return out.length ? out : [citation.trim()];
}

/**
 * The main title of a "Main title: subtitle" guess, when both halves carry title words. Book records often hold only
 * the main title ("Evolutionary Ecology of Birds"), so a search for the whole guess never finds them.
 */
export function mainTitle(guess: string): string | null {
  const m = guess.match(/^(.{6,}?)(?:\s*[:?]\s+|\s+[–—-]\s+|\.\s+)(.+)$/);
  if (!m) return null;
  const head = contentTokens(m[1]!);
  // One word is enough when it is a long one ("Potentialities: Collected Essays in Philosophy").
  const enough = head.length >= 2 || (head.length === 1 && head[0]!.length >= 7);
  return enough && contentTokens(m[2]!).length >= 2 ? m[1]!.trim() : null;
}

/**
 * Share of a candidate's venue name found in the citation, abbreviations included ("PLoS Med" for PLoS Medicine,
 * "J. Am. Ceram. Soc." for Journal of the American Ceramic Society). Words of the candidate's own title don't count.
 */
export function venueCoverage(citation: string, venue: string | null | undefined, title?: string | null): number {
  const v = contentTokens(venue ?? "");
  if (!v.length) return 0;
  const own = tokens(title);
  const cit = contentTokens(citation).filter((t) => !own.has(t));
  // tokens() drops one-letter words, so "J." for Journal is read from the raw text.
  const j = /\bJ\b\.?/.test(citation);
  let hit = 0;
  for (const w of v) if (cit.some((c) => c === w || (c.length >= 2 && w.startsWith(c)) || (w.length >= 3 && c.startsWith(w))) || (w === "journal" && j)) hit++;
  return hit / v.length;
}

/** Share of the query's tokens that appear in the title (precision of a title guess). */
export function queryCoverage(query: string, title: string | null | undefined): number {
  const q = tokens(query);
  const t = tokens(title);
  if (!q.size) return 0;
  let hit = 0;
  for (const w of q) if (t.has(w)) hit++;
  return hit / q.size;
}

/**
 * Capitalized surname-like tokens that precede "et al", a year, or the title guess. Pass the title guess when there is
 * one: in "Hanahan D, Weinberg RA. The hallmarks of cancer. Cell. 2000" only the words before it are names.
 */
export function guessSurnames(citation: string, title?: string): string[] {
  const at = title ? citation.indexOf(title) : -1;
  const byline = at > 0 ? citation.slice(0, at) : citation;
  const head = byline.split(/\(?\b(1[89]\d{2}|20\d{2})\b/)[0] ?? byline;
  const cut = head.split(/\bet al\b/i)[0] ?? head;
  return [...new Set(
    cut
      .replace(/[“"'].*$/s, "")
      .split(/[^A-Za-zÀ-ɏ'-]+/)
      .filter((w) => w.length >= 3 && /^[A-ZÀ-Þ]/.test(w) && !["The", "And", "Journal", "Nature", "Science"].includes(w))
      .map((w) => w.toLowerCase())
  )].slice(0, 6);
}
