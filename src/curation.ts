/**
 * Pure helpers for the profile-curation tools: friendly curation items -> exact users-api
 * payloads (https://help.openalex.org/api/author-curation/), the audit shape of an authorship,
 * the profile summary, and human descriptions of curation rows.
 */
import { shortId } from "./ids";
import { normalizeOrcid, orcidUrl } from "./orcid";
import {
  type AuthorshipLike, authorshipIndexForAuthor, findMatchedAuthorshipCascade, nameTokens, fullMatchCount, type MatchTier,
} from "./names";
import type { CurationPayload, CurationRow } from "./users";

export const OPENALEX = "https://openalex.org/";
export const ADD_WORK_PROPERTY_RE = /^authorships\[raw_author_name="(.+)"\]\.author\.id$/;

export type CurationItem =
  | { action: "add_work"; work_id: string; raw_author_name: string }
  | { action: "remove_work"; work_id: string }
  | { action: "set_display_name"; value: string }
  | { action: "set_full_name"; value: string }
  | { action: "set_orcid"; value: string }
  | { action: "remove_orcid"; value: string }
  | { action: "cancel"; curation_id: string };

export class CurationItemError extends Error {}

const workUrl = (id: string) => {
  const s = shortId(id);
  if (!s || !/^W\d+$/.test(s)) throw new CurationItemError(`work_id must be an OpenAlex work ID like W2741809807, got "${id}".`);
  return OPENALEX + s;
};

/** Build the exact users-api payload for one item (cancel items are handled separately). */
export function toPayload(item: Exclude<CurationItem, { action: "cancel" }>, authorShortId: string): CurationPayload {
  const author = OPENALEX + authorShortId;
  switch (item.action) {
    case "add_work": {
      const name = (item.raw_author_name ?? "").trim();
      if (!name) throw new CurationItemError("add_work needs raw_author_name: the byline on the work, exactly as OpenAlex returns it.");
      if (name.includes('"]')) throw new CurationItemError("raw_author_name contains the sequence \"] which the property syntax cannot carry.");
      return { entity: "works", entity_id: workUrl(item.work_id), property: `authorships[raw_author_name="${name}"].author.id`, action: "replace", value: author };
    }
    case "remove_work":
      return { entity: "works", entity_id: workUrl(item.work_id), property: "authorships.author.id", action: "remove", value: author };
    case "set_display_name":
    case "set_full_name": {
      const v = (item.value ?? "").trim();
      if (!v) throw new CurationItemError(`${item.action} needs a non-empty value.`);
      if (v.length > 300) throw new CurationItemError(`${item.action} value is too long.`);
      return { entity: "authors", entity_id: author, property: item.action === "set_display_name" ? "display_name" : "full_name", action: "replace", value: v };
    }
    case "set_orcid":
    case "remove_orcid": {
      const o = normalizeOrcid(item.value);
      if (!o) throw new CurationItemError(`"${item.value}" is not a valid ORCID (16 digits with hyphens; the last character may be X; the check digit must be right).`);
      return { entity: "authors", entity_id: author, property: "orcid", action: item.action === "set_orcid" ? "replace" : "remove", value: orcidUrl(o) };
    }
  }
}

/** One line a person can read, for curation rows coming back from users-api. */
export function describeCuration(row: Pick<CurationRow, "entity" | "entity_id" | "property" | "action" | "value">): string {
  const eid = shortId(row.entity_id) ?? row.entity_id;
  const val = shortId(row.value) ?? row.value;
  if (row.entity === "works") {
    const m = row.property.match(ADD_WORK_PROPERTY_RE);
    if (m && row.action === "replace") return `add ${eid} to author ${val} as "${m[1]}"`;
    if (row.action === "remove") return `remove ${eid} from author ${val}`;
    return `${row.action} ${row.property} on ${eid}`;
  }
  if (row.entity === "authors") {
    if (row.property === "orcid") return row.action === "remove" ? `detach ORCID ${val} from ${eid}` : `set ORCID of ${eid} to ${val}`;
    return `set ${row.property} of ${eid} to "${row.value}"`;
  }
  return `${row.action} ${row.property} ${row.entity_id} -> ${row.value}`;
}

export function shapeCurationRow(row: CurationRow) {
  return {
    id: row.id,
    describe: describeCuration(row),
    status: row.status,
    action: row.action,
    entity: row.entity,
    entity_id: shortId(row.entity_id) ?? row.entity_id,
    property: row.property,
    value: shortId(row.value) ?? row.value,
    previous_value: row.previous_value ?? undefined,
    created: row.created ? String(row.created).slice(0, 19) : undefined,
    applied_at: row.applied_at ? String(row.applied_at).slice(0, 19) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Audit shape: which byline on a work is this person, with the evidence around it
// ---------------------------------------------------------------------------

export interface ThisAuthorship {
  position: number | null;
  raw_author_name: string | null;
  raw_affiliation_strings: string[];
  institutions: string[];
  raw_orcid: string | null;
  /** Who OpenAlex currently attributes this byline to (null = unattributed). */
  current_author_id: string | null;
  current_author_name: string | null;
  /** "attributed" when the byline is already this author's; otherwise the cascade tier. */
  match: "attributed" | MatchTier;
  /** Verbatim name tokens shared with the query name (ranking signal). */
  name_tokens_matched?: number;
}

const stripOrcid = (s: any) => (s ? String(s).replace(/^https?:\/\/orcid\.org\//i, "") : null);

function shapeAuthorship(a: AuthorshipLike, position: number, match: ThisAuthorship["match"], queryTokens?: string[]): ThisAuthorship {
  return {
    position,
    raw_author_name: a?.raw_author_name ?? a?.author?.display_name ?? null,
    raw_affiliation_strings: Array.isArray(a?.raw_affiliation_strings) ? a.raw_affiliation_strings.slice(0, 3) : [],
    institutions: (a?.institutions ?? []).map((i: any) => i?.display_name).filter(Boolean).slice(0, 3),
    raw_orcid: stripOrcid(a?.raw_orcid),
    current_author_id: shortId(a?.author?.id) ?? null,
    current_author_name: a?.author?.display_name ?? null,
    match,
    name_tokens_matched: queryTokens ? fullMatchCount(a, queryTokens) : undefined,
  };
}

export interface ThisAuthorshipResult {
  this_authorship: ThisAuthorship | null;
  /** Tied bylines when the cascade was ambiguous, so Claude can ask which one. */
  ambiguous_bylines?: string[];
}

/**
 * Pick the byline for `authorShortId` (attributed) or, failing that, for `name` via the cascade.
 * Never guesses: ambiguity is reported, not resolved.
 */
export function pickAuthorship(authorships: AuthorshipLike[], authorShortId: string | null, name: string | null): ThisAuthorshipResult {
  const auths = authorships ?? [];
  if (authorShortId) {
    const i = authorshipIndexForAuthor(auths, authorShortId);
    if (i >= 0) return { this_authorship: shapeAuthorship(auths[i], i, "attributed", name ? nameTokens(name) : undefined) };
  }
  if (!name) return { this_authorship: null };
  const r = findMatchedAuthorshipCascade(auths, name);
  if (r.idx >= 0) return { this_authorship: shapeAuthorship(auths[r.idx], r.idx, r.tier, nameTokens(name)) };
  if (r.tier === "ambiguous") {
    return { this_authorship: null, ambiguous_bylines: r.candidateIdxs.map((i) => auths[i]?.raw_author_name ?? auths[i]?.author?.display_name ?? "?") };
  }
  return { this_authorship: null };
}

/** Coauthor surnames (everyone except `excludeIdx`), capped. */
export function coauthorNames(authorships: AuthorshipLike[], excludeIdx: number | null, max = 8): string[] {
  const out: string[] = [];
  (authorships ?? []).forEach((a, i) => {
    if (i === excludeIdx) return;
    const n = a?.author?.display_name ?? a?.raw_author_name;
    if (n) out.push(n);
  });
  const extra = out.length - max;
  return extra > 0 ? [...out.slice(0, max), `+${extra} more`] : out;
}

// ---------------------------------------------------------------------------
// Profile summary from group_by responses
// ---------------------------------------------------------------------------

export interface GroupRow { key: string; key_display_name?: string; count: number }

export function profileSummary(input: {
  works_count: number;
  names: GroupRow[];
  institutions: GroupRow[];
  topics: GroupRow[];
  years: GroupRow[];
  types?: GroupRow[];
}) {
  const yrs = input.years.map((y) => Number(y.key)).filter((n) => Number.isFinite(n));
  const top = (rows: GroupRow[], n: number) => rows.slice(0, n).map((r) => ({ name: r.key_display_name ?? r.key, id: shortId(r.key) ?? undefined, works: r.count }));
  return {
    works_count: input.works_count,
    name_variants: input.names.slice(0, 15).map((r) => ({ name: r.key_display_name ?? r.key, works: r.count })),
    institutions: top(input.institutions, 10),
    topics: top(input.topics, 8),
    years: yrs.length ? { first: Math.min(...yrs), last: Math.max(...yrs) } : null,
    types: input.types ? input.types.slice(0, 6).map((r) => ({ type: r.key, works: r.count })) : undefined,
  };
}
