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
  const CRISPR = "get works where topic is (T10878); then group those works by institution in (I63966007, I97018004, I136199984); then calculate count, mean FWCI, percent open access";
  it("passes get <entity> through normalizeOql", () => {
    expect(normalizeOql(CRISPR)).toBe(CRISPR);
    expect(normalizeOql("Get authors where h-index > (50)")).toBe("Get authors where h-index > (50)");
    expect(normalizeOql("get works; then group those works by year")).toBe("get works; then group those works by year");
    // a bare clause with steps still gets the classic start, which the API accepts
    expect(normalizeOql("topic is (T10878); then calculate count")).toBe("works where topic is (T10878); then calculate count");
    expect(normalizeOql("getting (x)")).toBe("works where getting (x)");
  });
  it("splits steps at top-level semicolons only", () => {
    expect(splitOqlSteps(CRISPR)).toEqual(["get works where topic is (T10878)", "then group those works by institution in (I63966007, I97018004, I136199984)", "then calculate count, mean FWCI, percent open access"]);
    expect(splitOqlSteps('get works where title has ("a; b" OR (c; d)); then calculate count')).toEqual(['get works where title has ("a; b" OR (c; d))', "then calculate count"]);
    expect(splitOqlSteps("works where title has (kelp)")).toEqual(["works where title has (kelp)"]);
  });
  it("detects pipelines, splits, calculations and samples", () => {
    expect(oqlIsPipeline(CRISPR)).toBe(true);
    expect(oqlIsPipeline("get works where year is (2020)")).toBe(true);
    expect(oqlIsPipeline("works where title has (kelp) group by year")).toBe(false);
    expect(oqlHasGroupBy(CRISPR)).toBe(true);
    expect(oqlHasGroupBy("get works where x is (1); then group those works into ((country is (BE)))")).toBe(true);
    expect(oqlHasGroupBy("get works where x is (1); then group those works again by year")).toBe(true);
    expect(oqlHasGroupBy("get works where topic is (T10878); then calculate count")).toBe(false);
    expect(oqlHasCalculate(CRISPR)).toBe(true);
    expect(oqlHasCalculate("works where title has (calculate)")).toBe(false);
    expect(oqlHasSample("get works where year is (2020); then sample (50) of those works")).toBe(true);
    expect(oqlAddSample("get works where year is (2020)", 10)).toBe("get works where year is (2020); then sample (10) of those works");
    expect(oqlAddSample("works where year is (2020)", 10)).toBe("works where year is (2020) sample 10");
    expect(oqlAddGroupBy("works where year is (2020)", "year")).toBe("works where year is (2020) group by year");
    expect(oqlAddGroupBy("get works where topic is (T10878); then calculate count, mean FWCI", "oa status")).toBe("get works where topic is (T10878); then group those works by oa status; then calculate count, mean FWCI");
    expect(oqlAddGroupBy("get works where topic is (T10878)", "year")).toBe("get works where topic is (T10878); then group those works by year");
  });
  it("puts the retracted default on the starting set only", () => {
    expect(oqlExcludeRetracted(CRISPR)).toEqual({ oql: "get works where (topic is (T10878)) and retracted is (false); then group those works by institution in (I63966007, I97018004, I136199984); then calculate count, mean FWCI, percent open access", applied: true });
    expect(oqlExcludeRetracted("get works; then group those works by year")).toEqual({ oql: "get works where retracted is (false); then group those works by year", applied: true });
    expect(oqlExcludeRetracted("works where topic is (T10878); then calculate count")).toEqual({ oql: "works where (topic is (T10878)) and retracted is (false); then calculate count", applied: true });
    expect(oqlExcludeRetracted("get works where year is (2020) or type is (review)")).toEqual({ oql: "get works where (year is (2020) or type is (review)) and retracted is (false)", applied: true });
  });
  it("leaves pipelines alone that mention retracted or don't start from works", () => {
    expect(oqlExcludeRetracted("get works where topic is (T10878); then calculate count, percent retracted").applied).toBe(false);
    expect(oqlExcludeRetracted("get works where topic is (T10878); then group those works by retracted").applied).toBe(false);
    expect(oqlExcludeRetracted("get works where retracted is (true); then calculate count").applied).toBe(false);
    expect(oqlExcludeRetracted("get authors where h-index > (50)")).toEqual({ oql: "get authors where h-index > (50)", applied: false });
    expect(oqlExcludeRetracted("get works where title has (kelp); then group those works by author where count of those works > (10) and h-index > (20)").oql)
      .toBe("get works where (title has (kelp)) and retracted is (false); then group those works by author where count of those works > (10) and h-index > (20)");
  });
  it("splits a sort off a pipeline and keeps the column words", () => {
    expect(splitOqlSort(CRISPR + "; then sort by mean FWCI")).toEqual({ oql: CRISPR, sort: undefined, by: "mean FWCI", ascending: undefined, stripped: true });
    expect(splitOqlSort(CRISPR + " sort by count asc")).toEqual({ oql: CRISPR, sort: undefined, by: "count", ascending: true, stripped: true });
    expect(splitOqlSort("get works where title has (kelp) sort by cited by count desc")).toMatchObject({ oql: "get works where title has (kelp)", sort: "cited_by_count", stripped: true });
    expect(splitOqlSort(CRISPR)).toEqual({ oql: CRISPR, stripped: false });
    expect(splitOqlSort("get works where title has (sort by); then calculate count").stripped).toBe(false);
  });
});
