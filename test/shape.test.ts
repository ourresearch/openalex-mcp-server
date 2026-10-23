import { describe, it, expect } from "vitest";
import { abstractFromInvertedIndex, shapeWork, shapeEntity, serializeWithinBudget, truncate } from "../src/shape";
import { buildWorkFilter, assertSemanticCompatible } from "../src/filters";
import { normalizeWorkId, normalizeEntityId, shortId, idList, workPath, entityPath, InvalidIdError } from "../src/ids";

describe("abstractFromInvertedIndex", () => {
  it("rebuilds word order", () => {
    expect(abstractFromInvertedIndex({ the: [0, 3], cat: [1], sat: [2], mat: [4] })).toBe("the cat sat the mat");
  });
  it("handles null/empty", () => {
    expect(abstractFromInvertedIndex(null)).toBeNull();
    expect(abstractFromInvertedIndex({})).toBeNull();
  });
});

describe("ids", () => {
  it("normalizes work ids", () => {
    expect(normalizeWorkId("https://openalex.org/w2741809807")).toBe("W2741809807");
    expect(normalizeWorkId("10.7717/peerj.4375")).toBe("https://doi.org/10.7717/peerj.4375");
    expect(normalizeWorkId("https://doi.org/10.7717/peerj.4375")).toBe("https://doi.org/10.7717/peerj.4375");
    expect(normalizeWorkId("doi:10.7717/peerj.4375")).toBe("https://doi.org/10.7717/peerj.4375");
    expect(normalizeWorkId("pmid:12345")).toBe("pmid:12345");
    expect(normalizeWorkId("12345")).toBe("pmid:12345");
  });
  it("normalizes entity ids", () => {
    expect(normalizeEntityId("authors", "https://orcid.org/0000-0001-6187-6610")).toBe("https://orcid.org/0000-0001-6187-6610");
    expect(normalizeEntityId("authors", "0000-0001-6187-6610")).toBe("https://orcid.org/0000-0001-6187-6610");
    expect(normalizeEntityId("institutions", "https://ror.org/02y3ad647")).toBe("https://ror.org/02y3ad647");
    expect(normalizeEntityId("institutions", "02y3ad647")).toBe("https://ror.org/02y3ad647");
    expect(normalizeEntityId("sources", "0028-0836")).toBe("issn:0028-0836");
    expect(normalizeEntityId("authors", "a5067184382")).toBe("A5067184382");
  });
  it("reads PMCIDs and MAG ids as path ids", () => {
    expect(normalizeWorkId("PMC1234567")).toBe("pmcid:1234567");
    expect(normalizeWorkId("pmcid:PMC1234567")).toBe("pmcid:1234567");
    expect(normalizeWorkId("pmc: 1234567")).toBe("pmcid:1234567");
    expect(normalizeWorkId("mag:2741809807")).toBe("mag:2741809807");
    expect(normalizeEntityId("institutions", "ror:02y3ad647")).toBe("ror:02y3ad647");
    expect(normalizeEntityId("sources", "wikidata:Q180445")).toBe("wikidata:Q180445");
  });
  it("still reads the forms the API resolved before the id check: ROR and Wikidata URLs, openalex:, website URLs", () => {
    for (const kind of ["institutions", "funders", "publishers"] as const) {
      expect(normalizeEntityId(kind, "https://ror.org/021nxhr62")).toBe("https://ror.org/021nxhr62");
      expect(normalizeEntityId(kind, "ror.org/021nxhr62")).toBe("https://ror.org/021nxhr62");
      expect(entityPath(kind, "https://ror.org/021nxhr62")).toBe(`/${kind}/https://ror.org/021nxhr62`);
    }
    for (const kind of ["institutions", "sources", "funders", "publishers"] as const) {
      expect(normalizeEntityId(kind, "https://www.wikidata.org/wiki/Q49108")).toBe("wikidata:Q49108");
      expect(normalizeEntityId(kind, "http://www.wikidata.org/entity/q49108")).toBe("wikidata:Q49108");
    }
    expect(normalizeEntityId("authors", "https://www.wikidata.org/wiki/Q49108")).toBeNull();
    expect(normalizeEntityId("authors", "openalex:A5067184382")).toBe("A5067184382");
    expect(normalizeWorkId("openalex:W2741809807")).toBe("W2741809807");
    expect(normalizeWorkId("https://openalex.org/works/W2741809807")).toBe("W2741809807");
    expect(workPath("https://openalex.org/works/w2741809807")).toBe("/works/W2741809807");
    expect(normalizeEntityId("authors", "https://openalex.org/authors/A5067184382")).toBe("A5067184382");
    expect(normalizeEntityId("institutions", "https://openalex.org/institutions/I27837315")).toBe("I27837315");
    // the wrong kind, and anything that would leave a dot segment, are still refused
    expect(normalizeEntityId("institutions", "https://openalex.org/authors/A5067184382")).toBeNull();
    for (const bad of ["https://openalex.org/works/../snapshots/credentials", "openalex:../snapshots/credentials", "https://openalex.org/works/..", "openalex:."]) {
      expect(() => workPath(bad)).toThrow(InvalidIdError);
      expect(() => entityPath("funders", bad)).toThrow(InvalidIdError);
    }
  });
  it("refuses anything that is not an id, so no request is built (#1762)", () => {
    const bad = ["../snapshots/credentials", ".", "..", "/snapshots/credentials", "W1/../../snapshots/credentials", "pmcid:../../x", "hello world"];
    for (const s of bad) {
      expect(normalizeWorkId(s)).toBeNull();
      expect(() => workPath(s)).toThrow(InvalidIdError);
      expect(normalizeEntityId("authors", s)).toBeNull();
      expect(() => entityPath("authors", s)).toThrow(InvalidIdError);
    }
    // a DOI with a dot segment, alone or inside a free-text reference
    for (const s of ["10.1234/../../../../../snapshots/credentials", "doi:10.1234/../../../../../snapshots/credentials", "10.1234/./x", "10.1234/x/.."]) {
      expect(normalizeWorkId(s)).toBeNull();
      expect(() => workPath(s)).toThrow(InvalidIdError);
    }
    expect(() => entityPath("sources", "wikidata:../../snapshots/credentials")).toThrow(InvalidIdError);
    expect(() => entityPath("institutions", "A5067184382")).toThrow(/institutions/);
  });
  it("builds paths that stay under /works/ and /<entity>/ after URL parsing", () => {
    const resolved = (p: string) => new URL("https://api.openalex.org" + p).pathname;
    expect(workPath("W2741809807")).toBe("/works/W2741809807");
    expect(workPath("https://doi.org/10.7717/peerj.4375/")).toBe("/works/https%3A//doi.org/10.7717/peerj.4375/");
    expect(workPath("10.1093/nar/gkaa1100")).toBe("/works/https%3A//doi.org/10.1093/nar/gkaa1100");
    expect(workPath("10.1002/(SICI)1097-4636(199712)37:4<1::AID>3.0.CO;2-#")).toBe("/works/https%3A//doi.org/10.1002/(SICI)1097-4636(199712)37%3A4%3C1%3A%3AAID%3E3.0.CO%3B2-%23");
    expect(entityPath("authors", "0000-0001-6187-6610")).toBe("/authors/https://orcid.org/0000-0001-6187-6610");
    expect(entityPath("sources", "0028-0836")).toBe("/sources/issn:0028-0836");
    for (const id of ["W1", "10.1093/nar/gkaa1100", "10.1234/%2e%2e/x", "10.1234/x?y#z", "10.1234/a\\..\\..\\b", "pmid:1"]) {
      expect(resolved(workPath(id))).toMatch(/^\/works\//);
    }
    for (const id of ["A1", "0000-0001-6187-6610", "orcid:0000-0001-6187-6610"]) expect(resolved(entityPath("authors", id))).toMatch(/^\/authors\//);
  });
  it("shortId + idList", () => {
    expect(shortId("https://openalex.org/A5067184382")).toBe("A5067184382");
    expect(idList(["https://openalex.org/A1, A2", "a3"])).toEqual(["A1", "A2", "A3"]);
  });
});

describe("buildWorkFilter", () => {
  it("defaults to excluding retracted", () => {
    expect(buildWorkFilter({})).toBe("is_retracted:false");
  });
  it("builds year ranges", () => {
    expect(buildWorkFilter({ from_year: 2020, to_year: 2024, include_retracted: true })).toBe("publication_year:2020-2024");
    expect(buildWorkFilter({ from_year: 2020, include_retracted: true })).toBe("publication_year:>2019");
    expect(buildWorkFilter({ to_year: 2020, include_retracted: true })).toBe("publication_year:<2021");
    expect(buildWorkFilter({ from_year: 2020, to_year: 2020, include_retracted: true })).toBe("publication_year:2020");
    expect(() => buildWorkFilter({ from_year: 2024, to_year: 2020 })).toThrow();
  });
  it("joins ids and composes", () => {
    const f = buildWorkFilter({
      author_ids: ["https://openalex.org/A1", "A2"],
      types: ["article", "review"],
      min_citations: 100,
      open_access_only: true,
      countries: ["us", "gb"],
      raw_filter: "has_abstract:true",
    });
    expect(f).toBe(
      "type:article|review,is_oa:true,cited_by_count:>99,authorships.author.id:A1|A2,authorships.institutions.country_code:US|GB,is_retracted:false,has_abstract:true"
    );
  });
  it("rejects semantic-incompatible filters", () => {
    expect(() => assertSemanticCompatible({ min_citations: 5 })).toThrow(/min_citations/);
    expect(() => assertSemanticCompatible({ countries: ["US"] })).toThrow(/countries/);
    expect(() => assertSemanticCompatible({ from_year: 2020 })).not.toThrow();
  });
});

const sampleWork = {
  id: "https://openalex.org/W2741809807",
  doi: "https://doi.org/10.7717/peerj.4375",
  display_name: "The state of OA",
  publication_year: 2018,
  type: "article",
  authorships: [
    { author: { id: "https://openalex.org/A1", display_name: "Heather Piwowar", orcid: "https://orcid.org/0000-0003-1613-5981" }, institutions: [{ display_name: "Impactstory" }], author_position: "first", is_corresponding: true },
    { author: { id: "https://openalex.org/A2", display_name: "Jason Priem" }, institutions: [] },
    { author: { id: "https://openalex.org/A3", display_name: "C" }, institutions: [] },
    { author: { id: "https://openalex.org/A4", display_name: "D" }, institutions: [] },
    { author: { id: "https://openalex.org/A5", display_name: "E" }, institutions: [] },
    { author: { id: "https://openalex.org/A6", display_name: "F" }, institutions: [] },
    { author: { id: "https://openalex.org/A7", display_name: "G" }, institutions: [] },
  ],
  primary_location: { source: { id: "https://openalex.org/S1983995261", display_name: "PeerJ" }, landing_page_url: "https://peerj.com/articles/4375", license: "cc-by" },
  open_access: { is_oa: true, oa_status: "gold", oa_url: "https://peerj.com/articles/4375.pdf" },
  cited_by_count: 1254,
  fwci: 41.23456,
  primary_topic: { id: "https://openalex.org/T10102", display_name: "scientometrics", subfield: { display_name: "Stats" }, field: { display_name: "Decision" }, domain: { display_name: "Social" } },
  abstract_inverted_index: { Despite: [0], growing: [1], interest: [2] },
  is_retracted: false,
  relevance_score: 12.3456789,
  referenced_works_count: 44,
  counts_by_year: [{ year: 2024, cited_by_count: 100 }],
  biblio: { volume: "6", first_page: "e4375" },
};

describe("shapeWork", () => {
  it("compact list shape", () => {
    const s = shapeWork(sampleWork, { abstractChars: 500 }) as any;
    expect(s.id).toBe("W2741809807");
    expect(s.doi).toBe("10.7717/peerj.4375");
    expect(s.authors).toEqual(["Heather Piwowar (Impactstory)", "Jason Priem", "C", "D", "E", "+2 more"]);
    expect(s.venue).toBe("PeerJ");
    expect(s.fwci).toBe(41.23);
    expect(s.abstract).toBe("Despite growing interest");
    expect(s.primary_topic).toBe("scientometrics");
    expect(s.is_retracted).toBeUndefined();
    expect(s.openalex_url).toBe("https://openalex.org/W2741809807");
    expect("authors" in s && Array.isArray(s.authors)).toBe(true);
  });
  it("full shape", () => {
    const s = shapeWork(sampleWork, { full: true }) as any;
    expect(s.authors).toHaveLength(7);
    expect(s.authors[0]).toEqual({ name: "Heather Piwowar", id: "A1", orcid: "0000-0003-1613-5981", position: "first", is_corresponding: true, institutions: ["Impactstory"] });
    expect(s.primary_topic.name).toBe("scientometrics");
    expect(s.pages).toBe("e4375");
    expect(s.citations_by_year).toEqual([{ year: 2024, citations: 100 }]);
  });
});

describe("shapeEntity", () => {
  it("author", () => {
    const a = shapeEntity("authors", {
      id: "https://openalex.org/A5067184382", display_name: "Jennifer A. Doudna", orcid: "https://orcid.org/0000-0001-9161-999X",
      works_count: 682, cited_by_count: 121742, summary_stats: { h_index: 150 },
      last_known_institutions: [{ display_name: "UC Berkeley" }],
      topics: [{ display_name: "CRISPR" }], affiliations: [{ institution: { display_name: "UC Berkeley", id: "https://openalex.org/I1" }, years: [2020, 2018] }],
    }) as any;
    expect(a).toMatchObject({ id: "A5067184382", orcid: "0000-0001-9161-999X", h_index: 150, current_institutions: ["UC Berkeley"], topics: ["CRISPR"] });
    expect(a.affiliation_history).toBeUndefined();
    const full = shapeEntity("authors", { id: "A1", affiliations: [{ institution: { display_name: "X" }, years: [2020, 2018] }] }, true) as any;
    expect(full.affiliation_history[0].years).toBe("2018-2020");
  });
});

describe("serializeWithinBudget", () => {
  it("drops abstracts then trims results", () => {
    const results = Array.from({ length: 40 }, (_, i) => ({ id: `W${i}`, abstract: "x".repeat(3000) }));
    const text = serializeWithinBudget({ results }, 20_000);
    const parsed = JSON.parse(text);
    expect(parsed.results[0].abstract).toBeUndefined();
    expect(parsed.truncation_note).toMatch(/Abstracts omitted/);
    expect(text.length).toBeLessThanOrEqual(20_000);
    const big = Array.from({ length: 400 }, (_, i) => ({ id: `W${i}`, title: "t".repeat(100) }));
    const t2 = serializeWithinBudget({ results: big }, 5_000);
    expect(t2.length).toBeLessThanOrEqual(5_000);
    expect(JSON.parse(t2).truncation_note).toMatch(/trimmed/);
  });
  it("truncate at word boundary", () => {
    expect(truncate("hello brave new world", 12)).toBe("hello brave…");
  });
});

import { RETRACTION_WARNING } from "../src/shape";

describe("retracted works lead with the flag (oxjob #1281)", () => {
  const retracted = { ...sampleWork, is_retracted: true };
  it("list rows put is_retracted first", () => {
    const s = shapeWork(retracted) as any;
    expect(Object.keys(s)[0]).toBe("is_retracted");
    expect(s.warning).toBeUndefined();
  });
  it("full records put the warning second", () => {
    const s = shapeWork(retracted, { full: true }) as any;
    expect(Object.keys(s).slice(0, 2)).toEqual(["is_retracted", "warning"]);
    expect(s.warning).toBe(RETRACTION_WARNING);
  });
});
