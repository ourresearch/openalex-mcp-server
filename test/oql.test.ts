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
