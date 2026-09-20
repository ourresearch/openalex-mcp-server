import { describe, it, expect } from "vitest";
import { toPayload, describeCuration, pickAuthorship, coauthorNames, profileSummary, CurationItemError } from "../src/curation";
import { normalizeOrcid, parseOrcidWorks } from "../src/orcid";

const A = "A5023888391";

describe("toPayload", () => {
  it("maps every friendly action onto the documented shape", () => {
    expect(toPayload({ action: "add_work", work_id: "https://openalex.org/W4404012345", raw_author_name: "Smith, J." }, A)).toEqual({
      entity: "works", entity_id: "https://openalex.org/W4404012345", property: 'authorships[raw_author_name="Smith, J."].author.id', action: "replace", value: "https://openalex.org/A5023888391",
    });
    expect(toPayload({ action: "remove_work", work_id: "w4404012345" }, A)).toEqual({
      entity: "works", entity_id: "https://openalex.org/W4404012345", property: "authorships.author.id", action: "remove", value: "https://openalex.org/A5023888391",
    });
    expect(toPayload({ action: "set_display_name", value: " John Smith " }, A)).toMatchObject({ entity: "authors", property: "display_name", action: "replace", value: "John Smith", entity_id: "https://openalex.org/A5023888391" });
    expect(toPayload({ action: "set_full_name", value: "John W. Smith" }, A)).toMatchObject({ property: "full_name", action: "replace" });
    expect(toPayload({ action: "set_orcid", value: "0000000208899220" }, A)).toMatchObject({ property: "orcid", action: "replace", value: "https://orcid.org/0000-0002-0889-9220" });
    expect(toPayload({ action: "remove_orcid", value: "https://orcid.org/0000-0002-1825-0097" }, A)).toMatchObject({ property: "orcid", action: "remove", value: "https://orcid.org/0000-0002-1825-0097" });
  });
  it("keeps inner quotes verbatim (George \"Vern\" Yocum) and rejects bad input", () => {
    expect(toPayload({ action: "add_work", work_id: "W1", raw_author_name: 'George "Vern" Yocum' }, A).property).toBe('authorships[raw_author_name="George "Vern" Yocum"].author.id');
    expect(() => toPayload({ action: "add_work", work_id: "10.1/abc", raw_author_name: "x" }, A)).toThrow(CurationItemError);
    expect(() => toPayload({ action: "add_work", work_id: "W1", raw_author_name: "  " }, A)).toThrow(CurationItemError);
    expect(() => toPayload({ action: "set_orcid", value: "0000-0002-0889-9221" }, A)).toThrow(/check digit|valid ORCID/);
    expect(() => toPayload({ action: "set_display_name", value: "" }, A)).toThrow(CurationItemError);
    expect(() => toPayload({ action: "set_display_name", value: "J\u0000Smith" }, A)).toThrow(/control characters/);
    expect(() => toPayload({ action: "add_work", work_id: "W1", raw_author_name: "Smith\u0007" }, A)).toThrow(/control characters/);
  });
});

describe("describeCuration", () => {
  it("reads back the row in words", () => {
    expect(describeCuration({ entity: "works", entity_id: "https://openalex.org/W1", property: 'authorships[raw_author_name="Smith, J."].author.id', action: "replace", value: "https://openalex.org/A5" })).toBe('add W1 to author A5 as "Smith, J."');
    expect(describeCuration({ entity: "works", entity_id: "https://openalex.org/W1", property: "authorships.author.id", action: "remove", value: "https://openalex.org/A5" })).toBe("remove W1 from author A5");
    expect(describeCuration({ entity: "authors", entity_id: "https://openalex.org/A5", property: "display_name", action: "replace", value: "J Smith" })).toBe('set display_name of A5 to "J Smith"');
    expect(describeCuration({ entity: "authors", entity_id: "https://openalex.org/A5", property: "orcid", action: "remove", value: "https://orcid.org/0000-0002-1825-0097" })).toBe("detach ORCID https://orcid.org/0000-0002-1825-0097 from A5");
  });
});

describe("pickAuthorship", () => {
  const auths = [
    { raw_author_name: "Piwowar, Heather", author: { id: "https://openalex.org/A1", display_name: "Heather Piwowar" }, raw_affiliation_strings: ["Impactstory"], institutions: [{ display_name: "OurResearch" }] },
    { raw_author_name: "Priem, Jason", author: { id: "https://openalex.org/A2", display_name: "Jason Priem" }, raw_orcid: "https://orcid.org/0000-0001-6187-6610" },
  ];
  it("prefers the attributed byline, else the cascade, and reports ambiguity", () => {
    expect(pickAuthorship(auths, "A2", "Jason Priem").this_authorship).toMatchObject({ position: 1, match: "attributed", raw_orcid: "0000-0001-6187-6610", current_author_id: "A2", name_tokens_matched: 2 });
    expect(pickAuthorship(auths, "A999", "J Priem").this_authorship).toMatchObject({ position: 1, match: 1, current_author_id: "A2" });
    expect(pickAuthorship(auths, null, "Nobody Here").this_authorship).toBeNull();
    const amb = pickAuthorship([{ raw_author_name: "Smith J A" }, { raw_author_name: "Smith J B" }], null, "John Smith");
    expect(amb.this_authorship).toBeNull();
    expect(amb.ambiguous_bylines).toEqual(["Smith J A", "Smith J B"]);
  });
  it("lists coauthors without the person", () => {
    expect(coauthorNames(auths, 1)).toEqual(["Heather Piwowar"]);
    expect(coauthorNames(Array.from({ length: 12 }, (_, i) => ({ raw_author_name: `P${i}` })), null, 3)).toEqual(["P0", "P1", "P2", "+9 more"]);
  });
});

describe("profileSummary", () => {
  it("shapes group_by rows", () => {
    const s = profileSummary({
      works_count: 42,
      names: [{ key: "Jason Priem", count: 30 }, { key: "J. Priem", count: 12 }],
      institutions: [{ key: "https://openalex.org/I1", key_display_name: "OurResearch", count: 20 }],
      topics: [{ key: "https://openalex.org/T1", key_display_name: "Scientometrics", count: 25 }],
      years: [{ key: "2010", count: 3 }, { key: "2024", count: 5 }],
    });
    expect(s.years).toEqual({ first: 2010, last: 2024 });
    expect(s.institutions[0]).toEqual({ name: "OurResearch", id: "I1", works: 20 });
    expect(s.name_variants[1]).toEqual({ name: "J. Priem", works: 12 });
  });
});

describe("orcid", () => {
  it("normalizes and checks", () => {
    expect(normalizeOrcid("0000-0002-1825-0097")).toBe("0000-0002-1825-0097");
    expect(normalizeOrcid("https://orcid.org/0000-0001-6187-6610/")).toBe("0000-0001-6187-6610");
    expect(normalizeOrcid("0000000208899220")).toBe("0000-0002-0889-9220");
    expect(normalizeOrcid("0000-0002-1694-233X")).toBe("0000-0002-1694-233X");
    expect(normalizeOrcid("0000-0002-1825-0098")).toBeNull();
    expect(normalizeOrcid("garbage")).toBeNull();
  });
  it("flattens the public works summary", () => {
    const body = { group: [{
      "external-ids": { "external-id": [{ "external-id-type": "doi", "external-id-value": "10.7717/PeerJ.4375", "external-id-normalized": { value: "10.7717/peerj.4375" } }] },
      "work-summary": [{ "put-code": 7, title: { title: { value: "The state of OA" } }, type: "journal-article", "publication-date": { year: { value: "2018" } }, "external-ids": { "external-id": [{ "external-id-type": "pmid", "external-id-value": "29456894" }] } }],
    }] };
    expect(parseOrcidWorks(body)).toEqual([{ put_code: 7, title: "The state of OA", year: 2018, type: "journal-article", doi: "10.7717/peerj.4375", pmid: "29456894", external_ids: [{ type: "doi", value: "10.7717/peerj.4375" }, { type: "pmid", value: "29456894" }] }]);
    expect(parseOrcidWorks({})).toEqual([]);
  });
});
