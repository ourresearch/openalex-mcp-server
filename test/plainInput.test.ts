import { describe, it, expect } from "vitest";
import { keywordsOk, keywordText, parseId, readName, sameName, type Candidate } from "../src/plainInput";
import { frontDoor, type Lookup } from "../src/frontDoor";

describe("parseId", () => {
  it("reads one identifier, in its common forms", () => {
    expect(parseId("10.1038/nature12373")).toMatchObject({ kind: "work", scheme: "DOI", oql: "get works where DOI is 10.1038/nature12373" });
    expect(parseId("https://doi.org/10.1038/nature12373.")?.oql).toBe("get works where DOI is 10.1038/nature12373");
    expect(parseId("doi: 10.1038/nature12373")?.oql).toBe("get works where DOI is 10.1038/nature12373");
    expect(parseId("https://orcid.org/0000-0001-6187-6610")).toMatchObject({ kind: "author", resolve: "/authors/orcid:0000-0001-6187-6610" });
    expect(parseId("W2741809807")?.oql).toBe("get works where openalex id is W2741809807");
    expect(parseId("https://openalex.org/authors/A5023888391")?.oql).toBe("get (A5023888391)'s works");
    expect(parseId("s137773608")?.oql).toBe("get works in (S137773608)");
    expect(parseId("T10878")?.oql).toBe("get works in the topic (T10878)");
    expect(parseId("PMID: 29456894")?.oql).toBe("get works where PMID is 29456894");
    expect(parseId("PMC5815332")?.oql).toBe("get works where PMCID is 5815332");
    expect(parseId("arXiv:2305.18290v2")?.oql).toBe("get works where DOI is 10.48550/arxiv.2305.18290");
    expect(parseId("https://ror.org/00ghzk478")).toMatchObject({ kind: "institution", resolve: "/institutions/ror:00ghzk478" });
    expect(parseId("0028-0836")).toMatchObject({ kind: "source", resolve: "/sources/issn:0028-0836" });
  });
  it("leaves alone anything that isn't only an id", () => {
    for (const s of ["kelp", "P2020", "T123", "2020", "iec 62321", "papers citing 10.1038/nature12373", "12345678", "A1"]) expect(parseId(s)).toBeNull();
  });
});

describe("keywordsOk", () => {
  it("takes plain words, in any language", () => {
    for (const s of ["kelp", "disinformation llm", "recruitment, halo effect", "Diabetes type 2 treatment", "工业设计", "part time student college", "danger \"artificial intelligence\" creation"]) {
      expect(keywordsOk(s), s).toBe(true);
    }
  });
  it("leaves questions, requests, years, citations, organizations and broken Boolean strings to the model", () => {
    for (const s of ["how has kelp research grown?", "Facts about polar bears", "Artículo de medicina", "Tolong carikan paper mengenai matahari",
      "de witte job insecurity 1990", "jolliff et al", "Selçuk Üniversitesi uluslararası ilişkiler", "Stanford University kelp",
      'physical education" OR "educación física', "kelp OR seaweed"]) {
      expect(keywordsOk(s), s).toBe(false);
    }
  });
  it("drops a lone quote at either end", () => {
    expect(keywordText("“Lean Leadership")).toBe("Lean Leadership");
    expect(keywordsOk("“Lean Leadership")).toBe(true);
  });
});

const org = (kind: Candidate["kind"], name: string, works: number, exact = true): Candidate => ({ kind, id: `${kind[0].toUpperCase()}1${works}`, name, works, exact });

describe("readName", () => {
  it("is an organization when its full name outweighs the keyword search", () => {
    expect(readName("Journal of Healthcare Engineering", [org("source", "Journal of Healthcare Engineering", 4094)], [], 1427)).toMatchObject({ route: "org" });
    // the institution and the funder of one name: the much bigger one
    const uct = readName("University of Cape Town", [org("institution", "University of Cape Town", 227718), org("funder", "University of Cape Town", 17026)],
      [org("author", "University of Cape Town", 4)], 8825);
    expect(uct).toMatchObject({ route: "org", pick: { kind: "institution" } });
  });
  it("is keywords when the name is a minor reading of a topic phrase", () => {
    expect(readName("Machine Learning", [org("source", "Machine Learning", 3148)], [org("author", "Machine Learning", 3)], 2929369)).toEqual({ route: "keywords" });
    expect(readName("kelp", [], [org("author", "Kelp", 4)], 16050)).toEqual({ route: "keywords" });
  });
  it("is unsure when both readings are likely, or a one-word name is a real thing", () => {
    expect(readName("Remote Sensing of Environment", [org("source", "Remote Sensing of Environment", 12018)], [], 57966)).toMatchObject({ route: "unsure" });
    expect(readName("National Institutes of Health", [org("funder", "NIH", 1972676), org("institution", "NIH", 401926)], [], 223914)).toMatchObject({ route: "unsure" });
    expect(readName("Cell", [org("source", "Cell", 27158)], [], 13673331)).toMatchObject({ route: "unsure" });
    expect(readName("Michigan", [org("institution", "University of Michigan", 967611, false)], [], 169691)).toMatchObject({ route: "unsure" });
    expect(readName("Nanomedicine", [org("source", "Nanomedicine", 3766)], [], 61012)).toEqual({ route: "keywords" });
  });
  it("is a person, a few people to pick from, or the list of them", () => {
    expect(readName("silvia martelo landroguez", [], [org("author", "Silvia Martelo-Landroguez", 50)], 0)).toMatchObject({ route: "person", others: [] });
    const few = readName("Jane Roe", [], [org("author", "Jane Roe", 40), org("author", "Jane Roe", 30), org("author", "Jane Roe", 1)], 3);
    expect(few).toMatchObject({ route: "person", others: [{ works: 30 }] });
    const many = readName("Yujie Liu", [], [385, 265, 195, 150, 120, 100].map((n) => org("author", "Yujie Liu", n)), 111);
    expect(many).toEqual({ route: "people" });
  });
  it("matches names whatever their case, accents, punctuation or (for people) order", () => {
    expect(sameName("silvia martelo landroguez", ["Silvia Martelo-Landroguez"])).toBe(true);
    expect(sameName("PARTHIBAN S", ["S. Parthiban"], true)).toBe(true);
    expect(sameName("PARTHIBAN S", ["S. Parthiban"])).toBe(false);
  });
});

/** A fake API: searches answer from `entities`, the keyword search with `kw`, a POSTed query with its own OQL. */
function fakeApi(entities: Record<string, any[]>, kw: number, posts: string[] = []): Lookup {
  return {
    async get(path: string, params: any = {}) {
      if (path === "/works") return { meta: { count: kw, x_query: { x_new_oql: `get works about (${params["search.title_abstract_keywords"]})` } }, results: [] };
      if (path.startsWith("/authors/orcid:")) return { id: "https://openalex.org/A5023888391" };
      return { results: entities[path] ?? [] };
    },
    async post(body: any) {
      posts.push(body.oql);
      return { meta: { count: 7, x_query: { x_new_oql: body.oql } }, results: [{ id: "https://openalex.org/W1", display_name: "A work" }] };
    },
  };
}
const noRun = async () => ({ ok: false });

describe("frontDoor's plain-input routes", () => {
  it("answers an id, a full name and keywords with no model", async () => {
    const posts: string[] = [];
    expect(await frontDoor("10.1038/nature12373", noRun, { oa: fakeApi({}, 0, posts) })).toMatchObject({ path: "id", note: "The work with this DOI." });
    expect(await frontDoor("0000-0001-6187-6610", noRun, { oa: fakeApi({}, 0, posts) })).toMatchObject({ path: "id", oql: "get (A5023888391)'s works" });
    const jhe = { id: "https://openalex.org/S36625193", display_name: "Journal of Healthcare Engineering", works_count: 4094, type: "journal" };
    expect(await frontDoor("Journal of Healthcare Engineering", noRun, { oa: fakeApi({ "/sources": [jhe] }, 1427) }))
      .toMatchObject({ path: "name", oql: "get works in (S36625193)", note: "Works in Journal of Healthcare Engineering, the journal with this name." });
    expect(await frontDoor("kelp", noRun, { oa: fakeApi({}, 16050) })).toMatchObject({ path: "keywords", oql: "get works about (kelp)" });
  });
  it("leaves a one-word name to the model unless the switch is on", async () => {
    const cell = { id: "https://openalex.org/S110447773", display_name: "Cell", works_count: 27158, type: "journal" };
    const oa = fakeApi({ "/sources": [cell] }, 13673331);
    expect(await frontDoor("Cell", noRun, { oa })).toEqual({ path: "model", tried: ["name"] });
    expect(await frontDoor("Cell", noRun, { oa, oneWordNames: true }))
      .toMatchObject({ path: "keywords", note: "Works with these words in the title, abstract or keywords. Did you mean the journal Cell (S110447773)?" });
  });
  it("sends a follow-up, a question, a zero-result search and a failed lookup to the model", async () => {
    expect(await frontDoor("only open access", noRun, { oa: fakeApi({}, 100), followUp: true })).toEqual({ path: "model", tried: [] });
    expect(await frontDoor("how has kelp research grown?", noRun, { oa: fakeApi({}, 100) })).toEqual({ path: "model", tried: ["keywords"] });
    expect(await frontDoor("bauhinia CuO nanoparticles", noRun, { oa: fakeApi({}, 0) })).toEqual({ path: "model", tried: ["keywords"] });
    const broken: Lookup = { get: async () => { throw new Error("down"); }, post: async () => { throw new Error("down"); } };
    expect(await frontDoor("kelp", noRun, { oa: broken })).toEqual({ path: "model", tried: ["name"] });
  });
});
