import { describe, it, expect } from "vitest";
import { normalizeOql, oqlHasSearch, oqlHasGroupBy, oqlHasSample, oneLine, reproduceUrl } from "../src/oql";

describe("oql helpers", () => {
  it("prefixes bare where-clauses", () => {
    expect(normalizeOql("title has (cancer)")).toBe("works where title has (cancer)");
    expect(normalizeOql("  works where year is (2020)  ")).toBe("works where year is (2020)");
    expect(normalizeOql("Authors where works count >= (10)")).toBe("Authors where works count >= (10)");
  });
  it("detects search, group by, sample", () => {
    expect(oqlHasSearch("works where title has (x)")).toBe(true);
    expect(oqlHasSearch("works where year is (2020)")).toBe(false);
    expect(oqlHasGroupBy("works where year is (2020) group by type")).toBe(true);
    expect(oqlHasSample("works where year is (2020) sample 50")).toBe(true);
  });
  it("one-lines and builds reproduce url", () => {
    expect(oneLine("works where\n  title has (x)\n  and year >= (2020)")).toBe("works where title has (x) and year >= (2020)");
    expect(reproduceUrl("works where title has (x)")).toBe("https://api.openalex.org/?oql=works%20where%20title%20has%20(x)");
  });
});

import { oqlMentionsRetracted, oqlExcludeRetracted, splitOqlTail } from "../src/oql";

describe("retraction default in OQL (oxjob #1281)", () => {
  it("detects an existing retracted filter, not the word in a search term", () => {
    expect(oqlMentionsRetracted("works where retracted is (true)")).toBe(true);
    expect(oqlMentionsRetracted("works where is_retracted is (false)")).toBe(true);
    expect(oqlMentionsRetracted("works where it's retracted")).toBe(true);
    expect(oqlMentionsRetracted("works where title has (retracted papers)")).toBe(false);
  });
  it("splits the tail at top level only", () => {
    expect(splitOqlTail("title has (x) sort by year")).toEqual(["title has (x)", "sort by year"]);
    expect(splitOqlTail('title has ("return on investment") group by year')).toEqual(['title has ("return on investment")', "group by year"]);
    expect(splitOqlTail("title has (return) and year >= (2020)")).toEqual(["title has (return) and year >= (2020)", ""]);
    expect(splitOqlTail("year is (2020) sample 25")).toEqual(["year is (2020)", "sample 25"]);
  });
  it("wraps the clause and keeps the tail", () => {
    expect(oqlExcludeRetracted("works where title has (x) or title has (y) sort by year")).toEqual({ oql: "works where (title has (x) or title has (y)) and retracted is (false) sort by year", applied: true });
    expect(oqlExcludeRetracted("works where year is (2020)")).toEqual({ oql: "works where (year is (2020)) and retracted is (false)", applied: true });
    expect(oqlExcludeRetracted("works")).toEqual({ oql: "works where retracted is (false)", applied: true });
    expect(oqlExcludeRetracted("works group by year")).toEqual({ oql: "works where retracted is (false) group by year", applied: true });
  });
  it("leaves explicit retracted filters and non-works queries alone", () => {
    expect(oqlExcludeRetracted("works where retracted is (true)")).toEqual({ oql: "works where retracted is (true)", applied: false });
    expect(oqlExcludeRetracted("authors where works count >= (10)")).toEqual({ oql: "authors where works count >= (10)", applied: false });
  });
});

import { splitOqlSort } from "../src/oql";
describe("splitOqlSort (#1521)", () => {
  it("moves a trailing sort by into the sort parameter", () => {
    expect(splitOqlSort("works where title has (kelp) and retracted is (false) sort by cited by count desc"))
      .toEqual({ oql: "works where title has (kelp) and retracted is (false)", sort: "cited_by_count", stripped: true });
    expect(splitOqlSort("works where title has (kelp) sort by relevance").sort).toBe("relevance");
  });
  it("leaves queries without a sort alone", () => {
    expect(splitOqlSort("works where title has (sort by) and year >= (2020)")).toEqual({ oql: "works where title has (sort by) and year >= (2020)", stripped: false });
  });
});

import { splitOqlSteps, oqlIsPipeline, oqlHasCalculate, oqlAddSample, oqlAddGroupBy } from "../src/oql";
describe("pipeline queries (#1537)", () => {
  const CRISPR = "get works where topic is (T10878); then group those works by institution in (I63966007, I97018004, I136199984); then summarize using count, mean FWCI, percent open access";
  it("passes get <entity> through normalizeOql", () => {
    expect(normalizeOql(CRISPR)).toBe(CRISPR);
    expect(normalizeOql("Get authors where h-index > (50)")).toBe("Get authors where h-index > (50)");
    expect(normalizeOql("get works; then group those works by year")).toBe("get works; then group those works by year");
    // a bare clause with steps still gets the classic start, which the API accepts
    expect(normalizeOql("topic is (T10878); then summarize using count")).toBe("works where topic is (T10878); then summarize using count");
    expect(normalizeOql("getting (x)")).toBe("works where getting (x)");
  });
  it("splits steps at top-level semicolons only", () => {
    expect(splitOqlSteps(CRISPR)).toEqual(["get works where topic is (T10878)", "then group those works by institution in (I63966007, I97018004, I136199984)", "then summarize using count, mean FWCI, percent open access"]);
    expect(splitOqlSteps('get works where title has ("a; b" OR (c; d)); then summarize using count')).toEqual(['get works where title has ("a; b" OR (c; d))', "then summarize using count"]);
    expect(splitOqlSteps("works where title has (kelp)")).toEqual(["works where title has (kelp)"]);
  });
  it("detects pipelines, splits, calculations and samples", () => {
    expect(oqlIsPipeline(CRISPR)).toBe(true);
    expect(oqlIsPipeline("get works where year is (2020)")).toBe(true);
    expect(oqlIsPipeline("works where title has (kelp) group by year")).toBe(false);
    expect(oqlHasGroupBy(CRISPR)).toBe(true);
    expect(oqlHasGroupBy("get works where x is (1); then group those works into ((country is (BE)))")).toBe(true);
    expect(oqlHasGroupBy("get works where x is (1); then group those works again by year")).toBe(true);
    expect(oqlHasGroupBy("get works where topic is (T10878); then summarize using count")).toBe(false);
    expect(oqlHasCalculate(CRISPR)).toBe(true);
    expect(oqlHasCalculate("works where title has (calculate)")).toBe(false);
    expect(oqlHasSample("get works where year is (2020); then sample (50) of those works")).toBe(true);
    expect(oqlAddSample("get works where year is (2020)", 10)).toBe("get works where year is (2020); then sample (10) of those works");
    expect(oqlAddSample("works where year is (2020)", 10)).toBe("works where year is (2020) sample 10");
    expect(oqlAddGroupBy("works where year is (2020)", "year")).toBe("works where year is (2020) group by year");
    expect(oqlAddGroupBy("get works where topic is (T10878); then summarize using count, mean FWCI", "oa status")).toBe("get works where topic is (T10878); then group those works by oa status; then summarize using count, mean FWCI");
    expect(oqlAddGroupBy("get works where topic is (T10878)", "year")).toBe("get works where topic is (T10878); then group those works by year");
  });
  it("puts the retracted default on the starting set only", () => {
    expect(oqlExcludeRetracted(CRISPR)).toEqual({ oql: "get works where (topic is (T10878)) and retracted is (false); then group those works by institution in (I63966007, I97018004, I136199984); then summarize using count, mean FWCI, percent open access", applied: true });
    expect(oqlExcludeRetracted("get works; then group those works by year")).toEqual({ oql: "get works where retracted is (false); then group those works by year", applied: true });
    expect(oqlExcludeRetracted("works where topic is (T10878); then summarize using count")).toEqual({ oql: "works where (topic is (T10878)) and retracted is (false); then summarize using count", applied: true });
    expect(oqlExcludeRetracted("get works where year is (2020) or type is (review)")).toEqual({ oql: "get works where (year is (2020) or type is (review)) and retracted is (false)", applied: true });
  });
  it("leaves pipelines alone that mention retracted or don't start from works", () => {
    expect(oqlExcludeRetracted("get works where topic is (T10878); then summarize using count, percent retracted").applied).toBe(false);
    expect(oqlExcludeRetracted("get works where topic is (T10878); then group those works by retracted").applied).toBe(false);
    expect(oqlExcludeRetracted("get works where retracted is (true); then summarize using count").applied).toBe(false);
    expect(oqlExcludeRetracted("get authors where h-index > (50)")).toEqual({ oql: "get authors where h-index > (50)", applied: false });
    expect(oqlExcludeRetracted("get works where title has (kelp); then group those works by author where count of those works > (10) and h-index > (20)").oql)
      .toBe("get works where (title has (kelp)) and retracted is (false); then group those works by author where count of those works > (10) and h-index > (20)");
  });
  it("splits a sort off a pipeline and keeps the column words", () => {
    expect(splitOqlSort(CRISPR + "; then sort by mean FWCI")).toEqual({ oql: CRISPR, sort: undefined, by: "mean FWCI", ascending: undefined, stripped: true });
    expect(splitOqlSort(CRISPR + " sort by count asc")).toEqual({ oql: CRISPR, sort: undefined, by: "count", ascending: true, stripped: true });
    expect(splitOqlSort("get works where title has (kelp) sort by cited by count desc")).toMatchObject({ oql: "get works where title has (kelp)", sort: "cited_by_count", stripped: true });
    expect(splitOqlSort(CRISPR)).toEqual({ oql: CRISPR, stripped: false });
    expect(splitOqlSort("get works where title has (sort by); then summarize using count").stripped).toBe(false);
  });
});

describe("the #1555 step words", () => {
  const ECHO = "get works where country is [Kenya](KE) and year >= 2015;\nthen, group those works by year;\nfinally, summarize using count and percent open access";
  const COMPARE = "get works where topic is [CRISPR and Genetic Engineering](T10878); then, compare institution [MIT](I63966007) versus [Stanford University](I97018004) using count";
  it("finds the summary step after any opener", () => {
    expect(oqlHasCalculate(ECHO)).toBe(true);
    expect(oqlHasCalculate("get works where year > 2020; then, summarize using count")).toBe(true);
    expect(oqlHasCalculate("get works where year > 2020; summarize using count")).toBe(true);
    expect(oqlHasCalculate(COMPARE)).toBe(true);
    expect(oqlHasCalculate("get works where title has (summarize using)")).toBe(false);
  });
  it("reads a comparison as a split", () => {
    expect(oqlHasGroupBy(COMPARE)).toBe(true);
    expect(oqlHasGroupBy("get works where title has (compare)")).toBe(false);
  });
  it("adds a split before the summary", () => {
    expect(oqlAddGroupBy("get works where topic is (T10878); finally, summarize using count", "oa status"))
      .toBe("get works where topic is (T10878); then group those works by oa status; finally, summarize using count");
  });
  it("keeps a saved list's place when it leaves retracted works out", () => {
    expect(oqlExcludeRetracted("get works in the collection [Our lab](col_x) where year > 2020").oql)
      .toBe("get works in the collection [Our lab](col_x) where (year > 2020) and retracted is (false)");
    expect(oqlExcludeRetracted("get works in the collection (col_x)").oql)
      .toBe("get works in the collection (col_x) where retracted is (false)");
  });
});

// Thing-first (oxjob #1555): one row per author over the works that match
import { oqlThingFirst } from "../src/oql";
describe("thing-first", () => {
  const UBC = "get authors at [University of British Columbia](I141945490) since 2022 who published works where title-abstract has kelp";
  it("reads the start", () => {
    expect(oqlThingFirst(UBC)).toEqual({ head: "get authors at [University of British Columbia](I141945490) since 2022 who published works", thing: "authors", body: "where title-abstract has kelp" });
    expect(oqlThingFirst("get institutions in [Asia](Q48) that published works where topic is [Poultry](T13294)")?.thing).toBe("institutions");
    expect(oqlThingFirst("get authors who published more than 5 works where title has kelp")?.thing).toBe("authors");
    expect(oqlThingFirst("get topics of works where institution is (I1)")?.thing).toBe("topics");
    expect(oqlThingFirst("get authors where h-index is above 20")).toBeNull();
    expect(oqlThingFirst("get sources where works count is above 1000")).toBeNull();
  });
  it("is a split", () => {
    expect(oqlHasGroupBy(UBC)).toBe(true);
    expect(oqlHasGroupBy("get authors where h-index is above 20")).toBe(false);
  });
  it("leaves retracted works out of the works it names", () => {
    expect(oqlExcludeRetracted(UBC + "; then, summarize each author using count")).toEqual({
      oql: "get authors at [University of British Columbia](I141945490) since 2022 who published works where (title-abstract has kelp) and retracted is (false); then, summarize each author using count",
      applied: true });
    expect(oqlExcludeRetracted("get authors where h-index is above 20").applied).toBe(false);
  });
});
