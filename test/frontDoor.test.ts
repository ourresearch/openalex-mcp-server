import { describe, it, expect } from "vitest";
import { booleanSearch, frontDoor, sameTitle, titleCandidate } from "../src/frontDoor";

const oql = (s: string) => booleanSearch(s)?.oql ?? null;

describe("booleanSearch", () => {
  it("runs a Boolean string as written over title, abstract and keywords", () => {
    expect(oql('("urban agriculture" OR "urban farming")AND("livestock housing" OR "animal housing")'))
      .toBe('get works where title-abstract-keywords has (("urban agriculture" OR "urban farming") AND ("livestock housing" OR "animal housing"))');
    expect(oql("XAS AND imaging AND synchrotron AND battery")).toBe("get works where title-abstract-keywords has (XAS AND imaging AND synchrotron AND battery)");
    expect(oql('"coverage path planning"')).toBe('get works where title-abstract-keywords has ("coverage path planning")');
    expect(oql("adolescen* depress*")).toBe("get works where title-abstract-keywords has (adolescen* depress*)");
    // the AND beside a phrase is written out (the live parser drops a phrase's quotes after a bare word)
    expect(oql('survey "coverage path planning"')).toBe('get works where title-abstract-keywords has (survey AND "coverage path planning")');
    expect(oql('kelp ("forest" OR bed*)')).toBe('get works where title-abstract-keywords has (kelp AND ("forest" OR bed*))');
  });
  it("normalizes what people paste: curly and single quotes, list markers, line breaks, | and &", () => {
    expect(oql("1. “agentic AI” AND “pervasive computing”")).toBe('get works where title-abstract-keywords has ("agentic AI" AND "pervasive computing")');
    expect(oql("('triticum aestivum' and 'pericarp weight')")).toBe('get works where title-abstract-keywords has (("triticum aestivum" AND "pericarp weight"))');
    expect(oql('("political repression" OR "state repression")\nAND\n("collective action")')).toBe('get works where title-abstract-keywords has (("political repression" OR "state repression") AND ("collective action"))');
    expect(oql('"watchful waiting"|surveillance~')).toBe('get works where title-abstract-keywords has ("watchful waiting" OR surveillance)');
    expect(booleanSearch('"Sjögren\'s syndrome" OR sjogren')?.oql).toBe('get works where title-abstract-keywords has ("Sjögren\'s syndrome" OR sjogren)');
  });
  it("reads PubMed, Scopus and Web of Science field tags", () => {
    expect(oql("kelp[ti] AND forest[ti]")).toBe("get works where title has (kelp AND forest)");
    expect(oql('"kelp forest"[tiab] AND decline[tiab]')).toBe('get works where title-abstract-keywords has ("kelp forest" AND decline)');
    expect(oql('TITLE-ABS-KEY("kelp forest" AND decline)')).toBe('get works where title-abstract-keywords has (("kelp forest" AND decline))');
    expect(oql('TS=("kelp forest" OR seaweed)')).toBe('get works where title-abstract-keywords has (("kelp forest" OR seaweed))');
    expect(oql("Smart Building (All Fields) or Pathfinder (All Fields)")).toBe("get works where title-abstract-keywords has (Smart Building OR Pathfinder)");
    const mixed = booleanSearch("kelp[ti] AND decline[tiab]");
    expect(mixed?.field).toBe("title-abstract-keywords");
    expect(mixed?.notes.join()).toContain("mixes field tags");
    expect(booleanSearch("asthma[mh] AND child*")?.notes.join()).toContain("MeSH");
  });
  it("keeps proximity between two words and says when it can't", () => {
    expect(oql("smart W/3 phone")).toBe('get works where title-abstract-keywords has ("smart phone"~3)');
    const b = booleanSearch('"smart phone" NEAR/3 addiction');
    expect(b?.oql).toBe('get works where title-abstract-keywords has ("smart phone" AND addiction)');
    expect(b?.notes.join()).toContain("proximity");
  });
  it("says when AND and OR are mixed without parentheses", () => {
    expect(booleanSearch('"University library" AND "Information literacy" OR "Information behavior"')?.notes.join()).toContain("how OpenAlex grouped them");
    expect(booleanSearch('"University library" AND ("Information literacy" OR "Information behavior")')?.notes).toEqual([]);
  });
  it("drops an empty phrase and the operator it leaves", () => {
    const b = booleanSearch('"Templeton World Charity Foundation" OR ""');
    expect(b?.oql).toBe('get works where title-abstract-keywords has ("Templeton World Charity Foundation")');
    expect(b?.notes.join()).toContain("empty phrase");
  });
  it("leaves prose, titles, filters and broken strings to the model", () => {
    for (const s of [
      "kelp forest decline",                                         // plain words: no Boolean syntax
      "papers on kelp AND climate since 2020",                       // a request in prose
      'how do I search for "machine learning"?',                     // a question
      "A special case of the Garnier system, (1,4)-polarized abelian surfaces and their moduli",   // a title with parentheses
      "3D elastic wave propagation with a Factorized Fourier Neural Operator (F-FNO)",
      'TITLE-ABS-KEY(kelp) AND PUBYEAR > 2015',                      // a Scopus filter
      'TS=(kelp) AND PY=(2015-2020)',                                // a Web of Science filter
      '("kelp" OR "seaweed"',                                        // unbalanced
      'emergency shelter" sanitation',                               // unclosed quote
      "kelp AND",                                                    // dangling operator
      'Encontre trabalhos que mencionem "realidade virtual" e audiência',   // prose with quotes, in any language
      'Buscar trabajos con "ética" Y "chatbots" Y "bibliotecas universitarias"',
      'Finde die Arbeit "Zur Allgemeinen Relativitätstheorie"',
    ]) expect([s, booleanSearch(s)]).toEqual([s, null]);
  });
});

describe("titleCandidate", () => {
  it("takes pasted titles and quoted titles in requests", () => {
    expect(titleCandidate("Masked Autoencoders Are Scalable Vision Learners")?.title).toBe("Masked Autoencoders Are Scalable Vision Learners");
    expect(titleCandidate('Find the paper titled "Power of invariant tests for linear hypotheses under spherical symmetry"')?.title).toBe("Power of invariant tests for linear hypotheses under spherical symmetry");
    expect(titleCandidate("Trouve l'ouvrage intitulé « Analyse harmonique sur les espaces »")?.title).toBe("Analyse harmonique sur les espaces");
    expect(titleCandidate('"Generative Adversarial Networks in Time Series"')?.title).toBe("Generative Adversarial Networks in Time Series");
    expect(titleCandidate("empirical martingale price estimators for financial derivatives")?.title).toBe("empirical martingale price estimators for financial derivatives");
  });
  it("marks a title asked for by name as explicit, in any language", () => {
    expect(titleCandidate('Finde die Arbeit mit dem Titel "Zur Allgemeinen Relativitätstheorie"')).toEqual({ title: "Zur Allgemeinen Relativitätstheorie", explicit: true });
    expect(titleCandidate("Masked Autoencoders Are Scalable Vision Learners")?.explicit).toBe(false);
  });
  it("skips short strings, short lowercase topics, Boolean strings and requests", () => {
    expect(titleCandidate("kelp forest")).toBeNull();
    expect(titleCandidate("circular economy and finance")).toBeNull();
    expect(titleCandidate('"kelp" AND "climate"')).toBeNull();
    expect(titleCandidate("Research on experiential learning")).toBeNull();
    expect(titleCandidate("Find works on blended learning and the SECI model")).toBeNull();
  });
});

describe("sameTitle", () => {
  it("matches the same words, or the main title before a colon", () => {
    expect(sameTitle("Masked autoencoders are scalable vision learners.", "Masked Autoencoders Are Scalable Vision Learners")).toBe(true);
    expect(sameTitle("Nihilistic Times", "Nihilistic Times: Thinking with Max Weber")).toBe(false);   // too short a main title
    expect(sameTitle("Conceptualizing the Visitor Experience", "Conceptualizing the Visitor Experience: A Review of Literature")).toBe(true);
    expect(sameTitle("Rational approximations of algebraic irrationals", "Errata: “Rational approximations of algebraic irrationals,” vol. 3")).toBe(false);
  });
});

describe("frontDoor", () => {
  const preview = (count: number, names: string[] = []) => ({ ok: true, count, canonical: undefined, top_rows: names.map((name) => ({ name })) });
  it("answers a confirmed title, else falls back to a search string, else the model", async () => {
    const titles = await frontDoor("Masked Autoencoders Are Scalable Vision Learners", async () => preview(2, ["Masked Autoencoders Are Scalable Vision Learners"]));
    expect(titles).toMatchObject({ path: "title", oql: 'get works where title has ("Masked Autoencoders Are Scalable Vision Learners")' });
    const common = await frontDoor("Letter to the Editor of the Journal", async () => preview(5000, ["Letter to the Editor of the Journal"]));
    expect(common).toEqual({ path: "model", tried: ["title"] });
    const quoted = await frontDoor('"Generative Adversarial Networks in Time Series"', async (q) => (q.includes(" title has ") ? preview(0) : preview(4)));
    expect(quoted).toMatchObject({ path: "search_string", oql: 'get works where title-abstract-keywords has ("Generative Adversarial Networks in Time Series")' });
    // asked for by name: any work whose title has it, reprints included; a miss goes to the model, never to a search
    const named = await frontDoor('Finde die Arbeit mit dem Titel "Zur Allgemeinen Relativitätstheorie"', async () => preview(29, ["Zur Allgemeinen Relativitätstheorie (Nachtrag)"]));
    expect(named).toMatchObject({ path: "title", oql: 'get works where title has ("Zur Allgemeinen Relativitätstheorie")' });
    expect(await frontDoor('Find the paper titled "No Such Paper At All Here"', async () => preview(0))).toEqual({ path: "model", tried: ["title"] });
    const refused = await frontDoor('"kelp" AND "climate"', async () => ({ ok: false }));
    expect(refused).toEqual({ path: "model", tried: ["search_string"] });
    expect(await frontDoor("which journals publish most on kelp", async () => preview(0))).toEqual({ path: "model", tried: ["title"] });
    expect(await frontDoor("kelp journals", async () => preview(1))).toEqual({ path: "model", tried: [] });
  });
});
