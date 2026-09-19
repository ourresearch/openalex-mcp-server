/** Small text helpers for reference matching. Pure, unit-tested. */

const STOP = new Set(["a", "an", "the", "of", "and", "or", "in", "on", "for", "to", "with", "by", "from", "at", "is", "are", "vs", "via"]);

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

/**
 * Strip author lists, years, venue fragments and punctuation from a free-text citation so
 * what's left is mostly the title. Heuristic: split into chunks, score each by content words,
 * penalise author-list signals (commas, initials), and take the best.
 */
export function guessTitle(citation: string): string {
  let s = citation.replace(/\bhttps?:\/\/\S+/g, " ").replace(/\bdoi:\s*\S+/gi, " ");
  // Removed fragments leave a ¶ sentinel so the pieces around them become separate chunks.
  s = s.replace(/\bet\s+al\.?/gi, " ¶ ");
  s = s.replace(/\(\s*(1[89]\d{2}|20\d{2})[a-z]?\s*\)/g, " ¶ ").replace(/\b(1[89]\d{2}|20\d{2})[a-z]?\b\.?/g, " ¶ ");
  const quoted = s.match(/[“"']([^”"']{15,})[”"']/);
  if (quoted) return quoted[1].trim();
  const chunks = s
    .split(/(?<=[.?!])\s+|\s*[.]\s+(?=[A-Z])|;\s+|\s*¶\s*/)
    .map((c) => c.replace(/^[\s,.:;]+|[\s,.:;]+$/g, ""))
    .filter((c) => c.length > 0);
  const scored = chunks.map((c, i) => {
    const words = c.split(/\s+/);
    const initials = words.filter((w) => /^[A-Z]{1,3}\.?,?$/.test(w)).length;
    const commas = (c.match(/,/g) ?? []).length;
    const content = tokens(c).size;
    return { c, i, score: content - 1.5 * commas - 2 * initials, len: c.length };
  });
  scored.sort((a, b) => b.score - a.score || b.len - a.len || a.i - b.i);
  return (scored[0]?.c ?? citation).trim();
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

/** Capitalized surname-like tokens that precede "et al", a year, or the title guess. */
export function guessSurnames(citation: string): string[] {
  const head = citation.split(/\(?\b(1[89]\d{2}|20\d{2})\b/)[0] ?? citation;
  const cut = head.split(/\bet al\b/i)[0] ?? head;
  return [...new Set(
    cut
      .replace(/[“"'].*$/s, "")
      .split(/[^A-Za-zÀ-ɏ'-]+/)
      .filter((w) => w.length >= 3 && /^[A-ZÀ-Þ]/.test(w) && !["The", "And", "Journal", "Nature", "Science"].includes(w))
      .map((w) => w.toLowerCase())
  )].slice(0, 6);
}
