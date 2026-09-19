/** ID normalization helpers. OpenAlex accepts several ID forms; we accept even more. */

const OPENALEX_PREFIX = /^https?:\/\/openalex\.org\//i;

/** "https://openalex.org/W123" | "w123" -> "W123". Leaves DOIs, ORCIDs, RORs etc. alone. */
export function shortId(id: string | null | undefined): string | null {
  if (!id) return null;
  const s = id.trim().replace(OPENALEX_PREFIX, "");
  if (/^[wasitpfkg]\d+$/i.test(s)) return s.toUpperCase();
  return s;
}

/** Normalize a user-supplied work identifier into a path segment for /works/{id}. */
export function normalizeWorkId(input: string): string {
  let s = input.trim();
  s = s.replace(OPENALEX_PREFIX, "");
  if (/^w\d+$/i.test(s)) return s.toUpperCase();
  // DOI in any common form
  const doiMatch = s.match(/(10\.\d{4,9}\/[^\s]+)/i);
  if (doiMatch) return "https://doi.org/" + doiMatch[1];
  if (/^pmid:\s*\d+$/i.test(s)) return "pmid:" + s.replace(/^pmid:\s*/i, "");
  if (/^pmcid?:\s*/i.test(s)) return "pmcid:" + s.replace(/^pmcid?:\s*/i, "").replace(/^PMC/i, "");
  if (/^\d+$/.test(s)) return "pmid:" + s;
  return s;
}

export type EntityType = "authors" | "institutions" | "sources" | "topics" | "funders" | "publishers";

export const ENTITY_PREFIX: Record<EntityType, string> = {
  authors: "A",
  institutions: "I",
  sources: "S",
  topics: "T",
  funders: "F",
  publishers: "P",
};

/** Normalize a user-supplied non-work identifier into a path segment for /{entity}/{id}. */
export function normalizeEntityId(entity: EntityType, input: string): string {
  let s = input.trim().replace(OPENALEX_PREFIX, "");
  const prefix = ENTITY_PREFIX[entity];
  if (new RegExp(`^${prefix}\\d+$`, "i").test(s)) return s.toUpperCase();
  // ORCID
  const orcid = s.match(/(\d{4}-\d{4}-\d{4}-\d{3}[\dX])/i);
  if (entity === "authors" && orcid) return "https://orcid.org/" + orcid[1].toUpperCase();
  // ROR
  const ror = s.match(/ror\.org\/([0-9a-z]+)/i) ?? (entity === "institutions" && /^0[0-9a-z]{8}$/i.test(s) ? [s, s] : null);
  if (entity === "institutions" && ror) return "https://ror.org/" + ror[1];
  // ISSN
  if (entity === "sources" && /^\d{4}-\d{3}[\dX]$/i.test(s)) return "issn:" + s.toUpperCase();
  if (/^wikidata:/i.test(s)) return s;
  return s;
}

/** Split a comma/space separated list of IDs into short IDs, dropping blanks. */
export function idList(ids: string[] | undefined): string[] {
  if (!ids) return [];
  return ids
    .flatMap((x) => x.split(/[,\s]+/))
    .map((x) => shortId(x))
    .filter((x): x is string => !!x);
}
