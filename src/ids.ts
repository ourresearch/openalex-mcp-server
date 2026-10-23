/** ID normalization helpers. OpenAlex accepts several ID forms; we accept even more. */

const OPENALEX_PREFIX = /^https?:\/\/openalex\.org\//i;

/** "https://openalex.org/W123" | "w123" -> "W123". Leaves DOIs, ORCIDs, RORs etc. alone. */
export function shortId(id: string | null | undefined): string | null {
  if (!id) return null;
  const s = id.trim().replace(OPENALEX_PREFIX, "");
  if (/^[wasitpfkg]\d+$/i.test(s)) return s.toUpperCase();
  return s;
}

/**
 * The id inside an OpenAlex reference, for the path normalizers: "openalex:W1", "https://openalex.org/W1" and the
 * website's "https://openalex.org/works/W1" all give "W1". Anything left that isn't an id is refused after this.
 */
function stripOpenAlex(input: string): string {
  return input.trim().replace(/^openalex:/i, "").replace(/^https?:\/\/openalex\.org\/(?:(?:works|authors|institutions|sources|topics|funders|publishers)\/)?/i, "");
}

/**
 * A DOI that is safe to put in a URL path: no whitespace, and no "." or ".." segment, which URL parsing would resolve
 * out of /works/ into another API path (oxjob #1762).
 */
export function isSafeDoi(doi: string): boolean {
  return /^10\.\d{4,9}\/\S+$/i.test(doi) && doi.split("/").every((seg) => seg !== "." && seg !== "..");
}

/**
 * Normalize a user-supplied work identifier for /works/{id}: an OpenAlex W id, a DOI, a PMID, a PMCID or a MAG id.
 * Anything else is null: an unrecognized string must never become a path.
 */
export function normalizeWorkId(input: string): string | null {
  const s = stripOpenAlex(input);
  if (/^w\d+$/i.test(s)) return s.toUpperCase();
  // DOI in any common form
  const doiMatch = s.match(/(10\.\d{4,9}\/[^\s]+)/i);
  if (doiMatch) return isSafeDoi(doiMatch[1]) ? "https://doi.org/" + doiMatch[1] : null;
  const pmid = s.match(/^pmid:\s*(\d+)$/i);
  if (pmid) return "pmid:" + pmid[1];
  const pmcid = s.match(/^(?:pmc(?:id)?:\s*(?:pmc)?|pmc)(\d+)$/i);
  if (pmcid) return "pmcid:" + pmcid[1];
  const mag = s.match(/^mag:\s*(\d+)$/i);
  if (mag) return "mag:" + mag[1];
  if (/^\d+$/.test(s)) return "pmid:" + s;
  return null;
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

/** `<namespace>:<value>` external ids the API resolves at /{entity}/{id}; the value has no "/", so it stays one path segment. */
const EXTERNAL_ID_RE = /^(?:mag|orcid|ror|grid|issn|issn_l|wikidata|scopus|fatcat|crossref):[a-z0-9._-]+$/i;

/** The entities with ROR ids, and those with Wikidata ids, in OpenAlex. */
const ROR_ENTITIES: EntityType[] = ["institutions", "funders", "publishers"];
const WIKIDATA_ENTITIES: EntityType[] = ["institutions", "sources", "funders", "publishers"];

/**
 * Normalize a user-supplied non-work identifier for /{entity}/{id}: the entity's OpenAlex id, an ORCID (authors), a
 * ROR (institutions, funders, publishers), a Wikidata URL, an ISSN (sources) or another `<namespace>:<value>` id.
 * Anything else is null.
 */
export function normalizeEntityId(entity: EntityType, input: string): string | null {
  const s = stripOpenAlex(input);
  const prefix = ENTITY_PREFIX[entity];
  if (new RegExp(`^${prefix}\\d+$`, "i").test(s)) return s.toUpperCase();
  // ORCID
  const orcid = s.match(/(\d{4}-\d{4}-\d{4}-\d{3}[\dX])/i);
  if (entity === "authors" && orcid) return "https://orcid.org/" + orcid[1].toUpperCase();
  // ROR: the URL form institutions have always been looked up by
  const ror = s.match(/ror\.org\/([0-9a-z]+)/i) ?? (entity === "institutions" && /^0[0-9a-z]{8}$/i.test(s) ? [s, s] : null);
  if (ROR_ENTITIES.includes(entity) && ror) return "https://ror.org/" + ror[1];
  // Wikidata URL
  const wikidata = s.match(/wikidata\.org\/(?:wiki|entity)\/(Q\d+)$/i);
  if (WIKIDATA_ENTITIES.includes(entity) && wikidata) return "wikidata:" + wikidata[1].toUpperCase();
  // ISSN
  if (entity === "sources" && /^\d{4}-\d{3}[\dX]$/i.test(s)) return "issn:" + s.toUpperCase();
  if (EXTERNAL_ID_RE.test(s)) return s;
  return null;
}

/** An id that names no OpenAlex record form; thrown before any request is built. */
export class InvalidIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidIdError";
  }
}

const clip = (s: string) => (s.length > 80 ? s.slice(0, 80) + "..." : s);

const ENTITY_ID_FORMS: Record<EntityType, string> = {
  authors: "an OpenAlex author ID (A5067184382) or an ORCID",
  institutions: "an OpenAlex institution ID (I27837315) or a ROR",
  sources: "an OpenAlex source ID (S137773608) or an ISSN",
  topics: "an OpenAlex topic ID (T10102)",
  funders: "an OpenAlex funder ID (F…)",
  publishers: "an OpenAlex publisher ID (P…)",
};

/** A built path must never carry a "." or ".." segment: URL parsing would resolve it into another API path (#1762). */
function checkedPath(path: string, input: string): string {
  if (path.split("/").some((seg) => seg === "." || seg === "..")) throw new InvalidIdError(`"${clip(input)}" is not a valid ID.`);
  return path;
}

/**
 * The API path for one work: "/works/<id>". encodeURIComponent escapes "?", "#", "%" and "\"; "/" is put back,
 * since DOIs carry it. Throws InvalidIdError for anything normalizeWorkId does not recognize.
 */
export function workPath(input: string): string {
  const id = normalizeWorkId(input);
  if (!id) throw new InvalidIdError(`"${clip(input)}" is not a work ID OpenAlex can look up: use an OpenAlex work ID (W2741809807), a DOI, a PMID or a PMCID.`);
  return checkedPath("/works/" + encodeURIComponent(id).replace(/%2F/g, "/"), input);
}

/** The API path for one non-work entity: "/<entity>/<id>". Throws InvalidIdError for an id normalizeEntityId does not recognize. */
export function entityPath(entity: EntityType, input: string): string {
  const id = normalizeEntityId(entity, input);
  if (!id) throw new InvalidIdError(`"${clip(input)}" is not an ID OpenAlex can look up for ${entity}: use ${ENTITY_ID_FORMS[entity]}.`);
  return checkedPath(`/${entity}/` + encodeURIComponent(id).replace(/%2F/g, "/").replace(/%3A/g, ":"), input);
}

/** Split a comma/space separated list of IDs into short IDs, dropping blanks. */
export function idList(ids: string[] | undefined): string[] {
  if (!ids) return [];
  return ids
    .flatMap((x) => x.split(/[,\s]+/))
    .map((x) => shortId(x))
    .filter((x): x is string => !!x);
}
