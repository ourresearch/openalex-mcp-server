import { describe, it, expect } from "vitest";
import { buildKeywordSearch, keywordSlug, filterClauses, quoteWildcards } from "../src/keywordSearch";
import { buildWorkFilter } from "../src/filters";

const micro = { label: "microplastics", text: "microplastic or microplastics", keyword_ids: ["https://openalex.org/keywords/microplastics"] };
const health = { label: "human health", text: '"human health"', keyword_ids: ["keywords/human-health"] };

describe("keywordSlug", () => {
  it("strips URL and entity prefixes", () => {
    expect(keywordSlug("https://openalex.org/keywords/Human-Health")).toBe("human-health");
    expect(keywordSlug("keywords/remote-work")).toBe("remote-work");
    expect(keywordSlug(" remote-work ")).toBe("remote-work");
  });
});

describe("buildKeywordSearch", () => {
  it("ORs text and keywords within a facet and ANDs the facets", () => {
    const { queries } = buildKeywordSearch([micro, health], {});
    expect(queries.combined).toBe(
      'works where (title/abstract/keywords has (microplastic or microplastics) or keyword is (microplastics)) and (title/abstract/keywords has ("human health") or keyword is (human-health)) and retracted is (false)'
    );
    expect(queries.text_only).toBe('works where title/abstract/keywords has (microplastic or microplastics) and title/abstract/keywords has ("human health") and retracted is (false)');
  });

  it("puts the not-clause before the filters (after retracted is (false) the parser reads it as a second value)", () => {
    const { queries } = buildKeywordSearch([micro, health], { open_access_only: true });
    expect(queries.added_by_keywords).toMatch(/\) and not \(title\/abstract\/keywords has \(microplastic or microplastics\) and title\/abstract\/keywords has \("human health"\)\) and open access is \(true\) and retracted is \(false\)$/);
  });

  it("per facet: text, keyword and keyword-not-text", () => {
    const { perFacet } = buildKeywordSearch([micro], { from_year: 2015, to_year: 2020 });
    expect(perFacet[0]).toEqual({
      label: "microplastics",
      text: "works where title/abstract/keywords has (microplastic or microplastics) and year >= (2015) and year <= (2020) and retracted is (false)",
      keyword: "works where keyword is (microplastics) and year >= (2015) and year <= (2020) and retracted is (false)",
      keyword_not_text: "works where keyword is (microplastics) and not (title/abstract/keywords has (microplastic or microplastics)) and year >= (2015) and year <= (2020) and retracted is (false)",
      others: null,
    });
  });

  it("a text-only facet stays text-only and is flagged", () => {
    const r = buildKeywordSearch([micro, { text: '"human health"' }], {});
    expect(r.queries.combined).toContain('and title/abstract/keywords has ("human health")');
    expect(r.warnings.join(" ")).toMatch(/No keyword for: "human health"/);
  });

  it("a keyword-only facet has no text-only baseline and is flagged", () => {
    const r = buildKeywordSearch([micro, { keyword_ids: ["human-health"] }], {});
    expect(r.queries.text_only).toBeNull();
    expect(r.queries.added_by_keywords).toBeNull();
    expect(r.warnings.join(" ")).toMatch(/No text for/);
  });

  it("rejects empty facets and non-ids", () => {
    expect(() => buildKeywordSearch([{ label: "x" }], {})).toThrow(/needs text, keyword_ids, or both/);
    expect(() => buildKeywordSearch([{ text: "a", keyword_ids: ["human health"] }], {})).toThrow(/not keyword ids/);
  });
});

describe("quoteWildcards", () => {
  it("quotes bare wildcard terms and leaves quoted ones alone", () => {
    expect(quoteWildcards('"remote work*" or telework* or (telecommut* and WFH) or "home office"')).toBe('"remote work*" or "telework*" or ("telecommut*" and WFH) or "home office"');
    expect(quoteWildcards("well-being or depress*")).toBe('well-being or "depress*"');
    expect(quoteWildcards("microplastic or microplastics")).toBe("microplastic or microplastics");
  });
  it("is applied to facet text", () => {
    const { queries } = buildKeywordSearch([{ text: "telework*", keyword_ids: ["work–life-balance"] }], {});
    expect(queries.combined).toBe('works where (title/abstract/keywords has ("telework*") or keyword is (work–life-balance)) and retracted is (false)');
  });
});

describe("others (does a facet narrow anything?)", () => {
  it("is every other facet, under the filters", () => {
    const { perFacet } = buildKeywordSearch([micro, health], { open_access_only: true });
    expect(perFacet[0]!.others).toBe('works where (title/abstract/keywords has ("human health") or keyword is (human-health)) and open access is (true) and retracted is (false)');
    expect(buildKeywordSearch([micro], {}).perFacet[0]!.others).toBeNull();
  });
});

describe("filterClauses", () => {
  it("types, language, extra OQL and retracted", () => {
    expect(filterClauses({ types: ["article", "review"], language: "EN", extra_oql: "country is (BR)" })).toEqual([
      "type is (article or review)", "language is (en)", "(country is (BR))", "retracted is (false)",
    ]);
    expect(filterClauses({ include_retracted: true })).toEqual([]);
    expect(filterClauses({ extra_oql: "retracted is (true)" })).toEqual(["(retracted is (true))"]);
    expect(() => filterClauses({ from_year: 2020, to_year: 2010 })).toThrow(/after/);
  });
});

describe("keyword_ids filter", () => {
  it("adds keywords.id with OR", () => {
    expect(buildWorkFilter({ keyword_ids: ["microplastics", "https://openalex.org/keywords/human-health"] })).toBe("keywords.id:microplastics|human-health,is_retracted:false");
  });
});
