import { describe, it, expect } from "vitest";
import { newWords, searchStrings, stem, words } from "../src/searchWords";

describe("stem (Porter)", () => {
  it("matches Porter's own outputs", () => {
    const cases: Record<string, string> = {
      caresses: "caress", ponies: "poni", cats: "cat", agreed: "agre", plastered: "plaster", motoring: "motor",
      hopping: "hop", falling: "fall", filing: "file", happy: "happi", relational: "relat", conditional: "condit",
      rational: "ration", generalizations: "gener", oscillators: "oscil", adoption: "adopt", effective: "effect",
      controlling: "control", teachers: "teacher", studies: "studi", study: "studi", depression: "depress",
    };
    for (const [w, s] of Object.entries(cases)) expect([w, stem(w)]).toEqual([w, s]);
  });
});

describe("searchStrings", () => {
  it("reads today's has-clauses", () => {
    expect(searchStrings('get works where title-abstract-keywords has ((kelp OR "sea weed") AND climat* NOT fish) and published since 2020'))
      .toEqual(['(kelp OR "sea weed") AND climat* NOT fish']);
    expect(searchStrings('get works where title has ("Attention Is All You Need")')).toEqual(['"Attention Is All You Need"']);
    expect(searchStrings("get works where title has adolescen* and it's open access")).toEqual(["adolescen*"]);
    expect(searchStrings("get authors who published works where title-abstract has kelp; then, summarize each author using count")).toEqual(["kelp"]);
  });
  it("reads the rewrite's echo forms and compared searches", () => {
    expect(searchStrings("get works about (kelp AND forest) since 2020")).toEqual(["kelp AND forest"]);
    expect(searchStrings('get works with ("deep learning") in the title')).toEqual(['"deep learning"']);
    expect(searchStrings('get works where published since 2020; then, compare title-abstract has "machine learning" versus "edge AI" using count'))
      .toEqual(['"machine learning"', '"edge AI"']);
  });
  it("skips names and non-search fields", () => {
    expect(searchStrings("get works where raw affiliation has (Harvard) and it has a DOI")).toEqual([]);
    expect(searchStrings("get works where institution is [MIT](I63966007) and keyword is (kelp)")).toEqual([]);
  });
});

describe("words", () => {
  it("drops operators, proximity and stopwords, keeps wildcards", () => {
    expect(words('(smart and phone within 3 words of each other) AND "the addiction" NOT teen*')).toEqual(["smart", "phone", "addiction", "teen*"]);
    expect(words("Arañas de Sinaloa")).toEqual(["aranas", "sinaloa"]);
  });
});

describe("newWords", () => {
  const q = (s: string) => `get works where title-abstract-keywords has (${s})`;
  it("passes the person's own words, stems, plurals and wildcards", () => {
    expect(newWords(q("coffee AND health") + " and it's open access", ["open access articles about coffee and health"])).toEqual([]);
    expect(newWords(q("adolescen*"), ["studies on adolescents"])).toEqual([]);
    expect(newWords(q("teacher AND wellbeing"), ["teachers' wellbeing"])).toEqual([]);
    expect(newWords(q("covid19 AND vaccine"), ["COVID-19 vaccines"])).toEqual([]);
    expect(newWords(q('"COVID-19" AND vaccines'), ["covid-19 vaccine"])).toEqual([]);
    expect(newWords('get works where title has (aranas AND Sinaloa)', ["arañas de Sinaloa"])).toEqual([]);
  });
  it("flags synonyms and related terms", () => {
    expect(newWords(q("kelp OR seaweed"), ["kelp papers"])).toEqual(["seaweed"]);
    expect(newWords('get works where title-abstract has ((adolescen* OR teen*) AND depress*)', ["teen depression"])).toEqual(["adolescen*"]);
    expect(newWords(q('"machine learning" OR "deep learning"'), ["machine learning in health"])).toEqual(["deep"]);
  });
  it("counts the page's current query as typed (follow-ups)", () => {
    expect(newWords(q("kelp") + " and published since 2020", ["only since 2020", q("kelp")])).toEqual([]);
  });
});
