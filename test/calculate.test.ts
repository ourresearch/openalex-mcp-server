import { describe, it, expect } from "vitest";
import { rowId, shapeCalculation, serializeCalculation, shapeCheck } from "../src/calculate";
import { prepareOql } from "../src/oql";

// Trimmed from production responses, 2026-10-03 (#1537).
const CRISPR = {
  meta: {
    count: 94788, page: 1, per_page: 200, groups_count: 3, more_groups: false, next_cursor: null,
    measures: [
      { key: "count", measure: "count", column_id: null, oql: "count" },
      { key: "mean_fwci", measure: "mean", column_id: "fwci", oql: "mean FWCI" },
      { key: "percent_open_access_is_oa", measure: "percent", column_id: "open_access.is_oa", oql: "percent open access" },
    ],
    elapsed_ms: 44,
    cost: { credits: 1, usd: 0.0001, steps: [{ what: "the starting set", credits: 1 }] },
    x_query: { oql: "get works where topic is (T10878);\nthen group those works by institution in (I63966007, I97018004, I136199984);\nthen calculate count, mean FWCI, percent open access", url: null },
  },
  summary: { all: { key: "all", key_display_name: "all works", count: 94788, mean_fwci: 1.849, percent_open_access_is_oa: 56.3753 } },
  group_by: [
    { key: "https://openalex.org/I63966007", key_display_name: "Massachusetts Institute of Technology", count: 1140, mean_fwci: 10.5247, percent_open_access_is_oa: 79.2982 },
    { key: "https://openalex.org/I97018004", key_display_name: "Stanford University", count: 1253, mean_fwci: 4.0065, percent_open_access_is_oa: 75.419 },
    { key: "https://openalex.org/I136199984", key_display_name: "Harvard University", count: 2289, mean_fwci: 8.5282, percent_open_access_is_oa: 78.5496 },
  ],
  results: [],
};

const NESTED = {
  meta: {
    count: 125895, page: 1, groups_count: 2, more_groups: false,
    measures: [{ key: "count", oql: "count" }, { key: "percent_of_those", oql: "percent of those works" }],
    splits: [{ oql: "condition", kind: "conditions" }, { oql: "type", kind: "column" }],
    cost: { credits: 1, usd: 0.0001, steps: [] },
    x_query: { oql: "get works where year >= (2016) and country is (KE);\nthen group those works into ((institution is (I99464096)), (country is (BE)));\nthen group those works again by type;\nthen calculate count, percent of those works" },
  },
  summary: {
    all: { key: "all", key_display_name: "all works", count: 125895 },
    splits: [
      { groups: [{ key: "institution is (I99464096)", key_display_name: "institution is (I99464096)", count: 382, percent_of_those: 0.3034 }], more_groups: false },
      { groups: [{ key: "https://openalex.org/types/article", key_display_name: "article", count: 94975, percent_of_those: 75.4399 }], more_groups: false },
    ],
  },
  group_by: [
    { key: "institution is (I99464096)", key_display_name: "institution is (I99464096)", count: 382, percent_of_those: 0.3034, groups: [{ key: "https://openalex.org/types/article", key_display_name: "article", count: 295, percent_of_those: 77.2251 }] },
  ],
};

describe("shapeCalculation (#1537)", () => {
  it("returns one row per group keyed by the calculations' OQL words, the summary and the price", () => {
    const out = shapeCalculation(CRISPR);
    expect(out.columns).toEqual(["count", "mean FWCI", "percent open access"]);
    expect(out.groups[0]).toEqual({ id: "I63966007", name: "Massachusetts Institute of Technology", count: 1140, "mean FWCI": 10.5247, "percent open access": 79.2982 });
    expect(out.groups).toHaveLength(3);
    expect(out.summary).toEqual({ all: { name: "all works", count: 94788, "mean FWCI": 1.849, "percent open access": 56.3753 } });
    expect(out.price).toEqual({ credits: 1, usd: 0.0001, steps: [{ what: "the starting set", credits: 1 }] });
    expect(out.oql).toBe("get works where topic is (T10878); then group those works by institution in (I63966007, I97018004, I136199984); then calculate count, mean FWCI, percent open access");
    expect(out.reproduce_url).toMatch(/^https:\/\/api\.openalex\.org\/\?oql=get%20works/);
    expect(out.total_works).toBe(94788);
    expect(out.next_page).toBeUndefined();
  });
  it("nests inner splits in the groups; the summary has each split on its own, named", () => {
    const out = shapeCalculation(NESTED);
    expect(out.groups[0]).toEqual({ id: "institution is (I99464096)", count: 382, "percent of those works": 0.3034, groups: [{ id: "article", count: 295, "percent of those works": 77.2251 }] });
    expect(out.summary.all).toEqual({ name: "all works", count: 125895 });
    expect(out.summary.splits.map((s: any) => s.split)).toEqual(["condition", "type"]);
    expect(out.summary.splits[1].groups[0]).toEqual({ id: "article", count: 94975, "percent of those works": 75.4399 });
  });
  it("reads a classic grouped response (no measures, no total) as counts", () => {
    const out = shapeCalculation({ meta: { count: 10, page: 1, more_groups: true, cost_usd: 0.0001, x_query: { oql: "works where title has (kelp) group by year" } }, group_by: [{ key: "2020", key_display_name: "2020", count: 7 }] });
    expect(out.columns).toEqual(["count"]);
    expect(out.groups).toEqual([{ id: "2020", count: 7 }]);
    expect(out.next_page).toBe(2);
    expect(out.price).toEqual({ credits: 1, usd: 0.0001 });
  });
  it("orders a page by a calculated column on request", () => {
    expect(shapeCalculation(CRISPR, { sortBy: "mean fwci" }).groups.map((g: any) => g.id)).toEqual(["I63966007", "I136199984", "I97018004"]);
    expect(shapeCalculation(CRISPR, { sortBy: "count", ascending: true }).groups.map((g: any) => g.id)).toEqual(["I63966007", "I97018004", "I136199984"]);
    const miss = shapeCalculation(CRISPR, { sortBy: "h-index" });
    expect(miss.groups[0].id).toBe("I63966007");
    expect(miss.sort_note).toMatch(/not a calculated column/);
  });
  it("short ids for group keys", () => {
    expect(rowId("https://openalex.org/I63966007")).toBe("I63966007");
    expect(rowId("https://openalex.org/types/article")).toBe("article");
    expect(rowId("https://openalex.org/sdgs/3")).toBe("3");
    expect(rowId("1-9")).toBe("1-9");
    expect(rowId(2020)).toBe("2020");
  });
  it("trims inner groups, then rows, to fit the size budget, and stays valid JSON", () => {
    const many = { ...NESTED, group_by: Array.from({ length: 40 }, (_, i) => ({ key: `g${i}`, key_display_name: `g${i}`, count: i, groups: Array.from({ length: 300 }, (_, j) => ({ key: `https://openalex.org/A${j}`, key_display_name: `Author ${j}`, count: j })) })) };
    const text = serializeCalculation(shapeCalculation(many), 20_000);
    expect(text.length).toBeLessThanOrEqual(20_000);
    const parsed = JSON.parse(text);
    expect(parsed.truncation_note).toBeTruthy();
    expect(parsed.groups.length).toBeGreaterThan(0);
  });
});

describe("shapeCheck (#1537)", () => {
  it("a valid query: price, estimate, canonical text with names", () => {
    const out = shapeCheck({
      oql: "get works where topic is (T10878 [CRISPR and Genetic Engineering]);\nthen calculate count",
      oql_oneline: "get works where topic is (T10878 [CRISPR and Genetic Engineering]); then calculate count",
      validation: { valid: true, errors: [], warnings: [] },
      check: { valid: true, limits: [], estimate: { seconds: 1.2, es_calls: 1, budget_seconds: 10, within_budget: true }, cost: { credits: 1, usd: 0.0001, steps: [{ what: "the starting set", credits: 1 }] } },
    });
    expect(out).toEqual({
      valid: true,
      canonical_oql: "get works where topic is (T10878 [CRISPR and Genetic Engineering]); then calculate count",
      estimated_seconds: 1.2, time_budget_seconds: 10,
      price: { credits: 1, usd: 0.0001, steps: [{ what: "the starting set", credits: 1 }] },
    });
  });
  it("a parse error: the message and its fix, split", () => {
    const out = shapeCheck({ validation: { valid: false, errors: [{ type: "parse_error", message: "Failed to parse OQL: a query can split its works at most 3 times; this one splits 4 times  Fix: drop a split, or run one query per value of the outer split", location: null }], warnings: [] } });
    expect(out.valid).toBe(false);
    expect(out.problems).toEqual([{ problem: "parse_error", message: "a query can split its works at most 3 times; this one splits 4 times", fix: "drop a split, or run one query per value of the outer split" }]);
    expect(out.price).toBeUndefined();
  });
  it("limits: listed once each, with fixes, and the price of what was refused", () => {
    const out = shapeCheck({
      oql_oneline: "get works where year >= (2000); then group those works by author; then group those works again by year; then calculate count",
      validation: { valid: false, errors: [{ type: "too_many_groups", message: "Splitting by author gives about 86,531,190 groups here; ... Narrow the starting set." }, { type: "query_too_slow", message: "estimated at 654305 seconds" }], warnings: [] },
      check: { valid: false, limits: [{ error: "too_many_groups", message: "Splitting by author gives about 86,531,190 groups here; a nested split takes up to 10,000 groups per split.", fix: "Narrow the starting set." }, { error: "query_too_slow", message: "This query is estimated at 654305 seconds; queries get about 10.", fix: "Narrow the starting set." }], estimate: { seconds: 654304.8, budget_seconds: 10 }, cost: { credits: 1, usd: 0.0001 } },
    });
    expect(out.valid).toBe(false);
    expect(out.problems.map((p: any) => p.problem)).toEqual(["too_many_groups", "query_too_slow"]);
    expect(out.problems[0].fix).toBe("Narrow the starting set.");
    expect(out.estimated_seconds).toBe(654304.8);
  });
  it("a classic-form query has no check block: valid at 1 credit", () => {
    const out = shapeCheck({ oql_oneline: "works where title has (kelp)", validation: { valid: true, errors: [], warnings: [] }, check: null });
    expect(out.valid).toBe(true);
    expect(out.price.credits).toBe(1);
  });
});

describe("prepareOql (#1537)", () => {
  it("expands, splits the sort off, and hides retracted works on the starting set", () => {
    const p = prepareOql("get works where topic is (T10878); then group those works by year; then calculate count, mean FWCI; then sort by mean FWCI", false);
    expect(p.oql).toBe("get works where (topic is (T10878)) and retracted is (false); then group those works by year; then calculate count, mean FWCI");
    expect(p.sort.by).toBe("mean FWCI");
    expect(prepareOql("get works where topic is (T10878); then calculate count", true).oql).toBe("get works where topic is (T10878); then calculate count");
  });
});
