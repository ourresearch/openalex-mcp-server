import { describe, it, expect } from "vitest";
import { countAuthors, candidatesFromGroups, attributeEvidence, coauthorIds, currentlyAt, rankExperts } from "../src/experts";

const W = (id: string, cites: number, year: number, ...authors: string[]) => ({
  id: `https://openalex.org/${id}`, display_name: `Title ${id}`, publication_year: year, cited_by_count: cites, doi: `https://doi.org/10.1/${id}`,
  authorships: authors.map((a) => ({ author: { id: `https://openalex.org/${a}`, display_name: `Name ${a}` } })),
});

describe("experts helpers", () => {
  const works = [W("W1", 100, 2024, "A1", "A2"), W("W2", 50, 2022, "A1"), W("W3", 10, 2019, "A2", "A3"), W("W4", 5, 2023, "A1", "A1")];

  it("counts authors once per work and shapes group rows", () => {
    const c = countAuthors(works);
    expect(c[0]).toEqual({ id: "A1", name: "Name A1", matching_works: 3 });
    expect(c.find((x) => x.id === "A3")?.matching_works).toBe(1);
    expect(candidatesFromGroups([{ key: "https://openalex.org/A9", key_display_name: "Nine", count: 4 }, { key: "unknown", count: 1 }])).toEqual([{ id: "A9", name: "Nine", matching_works: 4 }]);
  });

  it("attributes evidence from the sample, most cited first, with totals", () => {
    const ev = attributeEvidence(works, ["A1", "A3"], 2);
    expect(ev.get("A1")).toMatchObject({ citations_in_sample: 155, works_in_sample: 3, latest_year: 2024 });
    expect(ev.get("A1")!.evidence.map((e) => e.id)).toEqual(["W1", "W2"]);
    expect(ev.get("A1")!.evidence[0].doi).toBe("10.1/W1");
    expect(ev.get("A3")!.works_in_sample).toBe(1);
    expect(ev.has("A2")).toBe(false);
  });

  it("collects coauthors and checks current institutions by lineage", () => {
    expect([...coauthorIds(works, ["A1"])].sort()).toEqual(["A2", "A3"]);
    const author = { last_known_institutions: [{ id: "https://openalex.org/I2", lineage: ["https://openalex.org/I2", "https://openalex.org/I1"], country_code: "us" }] };
    expect(currentlyAt(author, new Set(["I1"]))).toBe(true);
    expect(currentlyAt(author, new Set(["I3"]))).toBe(false);
    expect(currentlyAt(author, new Set())).toBe(true);
  });

  it("ranks by each sort key with stable tiebreaks", () => {
    const rows = [
      { id: "A1", name: "B", matching_works: 5, recent_matching_works: 1, citations_in_sample: 10, h_index: 40 },
      { id: "A2", name: "A", matching_works: 5, recent_matching_works: 4, citations_in_sample: 300, h_index: 12 },
      { id: "A3", name: "C", matching_works: 9, recent_matching_works: 0, citations_in_sample: 50, h_index: 20 },
    ];
    expect(rankExperts(rows, "matching_works").map((r) => r.id)).toEqual(["A3", "A2", "A1"]);
    expect(rankExperts(rows, "recent").map((r) => r.id)).toEqual(["A2", "A1", "A3"]);
    expect(rankExperts(rows, "citations").map((r) => r.id)).toEqual(["A2", "A3", "A1"]);
    expect(rankExperts(rows, "h_index").map((r) => r.id)).toEqual(["A1", "A3", "A2"]);
  });
});

import { affiliatedWith, topicWorks, oqlWhereClause, oqlWithYearFloor } from "../src/experts";

describe("experts helpers: scope, topics, oql", () => {
  const author = {
    last_known_institutions: [{ id: "https://openalex.org/I2", lineage: ["https://openalex.org/I2"] }],
    affiliations: [{ institution: { id: "https://openalex.org/I7", lineage: ["https://openalex.org/I7", "https://openalex.org/I1"] }, years: [2015] }],
    topics: [{ id: "https://openalex.org/T1", count: 30 }, { id: "https://openalex.org/T2", count: 5 }],
  };
  it("any_affiliation looks through affiliation history by lineage", () => {
    expect(affiliatedWith(author, new Set(["I1"]))).toBe(true);
    expect(affiliatedWith(author, new Set(["I2"]))).toBe(true);
    expect(affiliatedWith(author, new Set(["I9"]))).toBe(false);
    expect(currentlyAt(author, new Set(["I1"]))).toBe(false);
  });
  it("sums the profile's topic counts for the requested topics", () => {
    expect(topicWorks(author, new Set(["T1", "T2"]))).toBe(35);
    expect(topicWorks(author, new Set(["T3"]))).toBeNull();
    expect(topicWorks(author, new Set())).toBeNull();
  });
  it("extracts a where-clause and refuses trailing clauses", () => {
    expect(oqlWhereClause('works where title/abstract has (x) and year >= (2020)')).toEqual({ clause: "title/abstract has (x) and year >= (2020)" });
    expect(oqlWhereClause("works where title has (x) group by author")).toHaveProperty("error");
    expect(oqlWhereClause("authors where name has (x)")).toHaveProperty("error");
    expect(oqlWithYearFloor("title has (x) or title has (y)", 2024)).toBe("works where (title has (x) or title has (y)) and year >= (2024)");
  });
});
