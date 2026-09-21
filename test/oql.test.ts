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
