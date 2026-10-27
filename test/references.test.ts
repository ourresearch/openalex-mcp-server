import { describe, it, expect } from "vitest";
import { matchFreeText, orFallbackWords } from "../src/references";
import type { OpenAlexClient } from "../src/openalex";

/** A fake client: answers each /works call by its filter, and records the filters asked for. */
function fakeClient(answer: (filter: string) => any[]) {
  const filters: string[] = [];
  const client = { get: async (_path: string, params: any) => { filters.push(params.filter); return { meta: {}, results: answer(params.filter) }; } };
  return { client: client as unknown as OpenAlexClient, filters };
}

const work = (id: string, title: string, year: number, extra: Record<string, any> = {}) => ({
  id: `https://openalex.org/${id}`, display_name: title, publication_year: year, type: "article",
  authorships: [{ author: { display_name: extra.author ?? "Nobody" } }], primary_location: { source: { display_name: extra.venue ?? null } },
  biblio: extra.biblio ?? {}, doi: extra.doi ?? `https://doi.org/10.1/${id}`, cited_by_count: extra.cites ?? 0, ...(extra.type ? { type: extra.type } : {}),
});

describe("matchFreeText", () => {
  it("stops after one search on an exact, corroborated title", async () => {
    const lecun = work("W2919115771", "Deep learning", 2015, { author: "Yann LeCun", biblio: { volume: "521", first_page: "436" } });
    const { client, filters } = fakeClient((f) => (f.startsWith("title.search:Deep learning") ? [lecun] : []));
    const m = await matchFreeText(client, "LeCun Y, Bengio Y, Hinton G. Deep learning. Nature. 2015;521(7553):436-444.", "id");
    expect(m.match).toBe("exact");
    expect(m.work.id).toBe(lecun.id);
    expect(filters).toEqual(["title.search:Deep learning"]);
  });

  it("falls back to an OR of at most six words when the all-words search misses (a typo)", async () => {
    const oa = work("W2741809807", "The state of OA: a large-scale analysis of the prevalence and impact of Open Access articles", 2018, { author: "Heather Piwowar" });
    const { client, filters } = fakeClient((f) => (f.includes(" OR ") ? [oa] : []));
    const m = await matchFreeText(client, "Piwowar H et al. The state of open access: a large scale analysis of the prevalance and impact of open access articles. PeerJ 2018.", "id");
    expect(m.work?.id).toBe(oa.id);
    expect(m.match).not.toBe("none");
    const or = filters.find((f) => f.includes(" OR "))!;
    expect((or.match(/ OR /g) ?? []).length).toBeLessThanOrEqual(5);
  });

  it("picks the co-published copy whose volume and pages the citation states", async () => {
    const t = "Preferred reporting items for systematic reviews and meta-analyses: the PRISMA statement";
    const bmj = work("W2156098321", t, 2009, { author: "David Moher", venue: "BMJ", biblio: { volume: "339", first_page: "b2535" }, cites: 83810 });
    const plos = work("W4294215472", t, 2009, { author: "David Moher", venue: "PLoS Medicine", biblio: { volume: "6", first_page: "e1000097" }, cites: 63978 });
    const { client } = fakeClient((f) => (f.includes("publication_year") ? [bmj, plos] : [bmj]));
    const m = await matchFreeText(client, `Moher D, Liberati A, Tetzlaff J, Altman DG; PRISMA Group. ${t}. PLoS Med. 2009;6(7):e1000097.`, "id");
    expect(m.work.id).toBe(plos.id);
  });

  it("answers with the book, not a review of it, when the citation names the publisher", async () => {
    const review = work("W2989411908", "The Nazi Connection: Eugenics, American Racism, and German National Socialism.", 1995, { author: "Stefan Kühl", type: "article" });
    const book = work("W4388057633", "The Nazi Connection", 1994, { author: "Stefan Kühl", type: "book", cites: 304 });
    const { client } = fakeClient((f) => (f.includes("publication_year") ? [book] : [review]));
    const m = await matchFreeText(client, "Kühl, S. (1994). The Nazi connection: Eugenics, American racism, and German national socialism. New York: Oxford University Press.", "id");
    expect(m.work.id).toBe(book.id);
  });

  it("never answers with a venue record or a one-word title met through a venue fragment", async () => {
    const venue = work("W2612690371", "Advances in Neural Information Processing Systems 29", 2016, { type: "book" });
    const surf = work("W2798891709", "SuRF", 2018);
    const { client } = fakeClient(() => [venue, surf]);
    const m1 = await matchFreeText(client, "Vaswani A, Shazeer N, Parmar N, et al. Attention is all you need. Advances in Neural Information Processing Systems. 2017;30.", "id");
    expect(m1.match).toBe("none");
    const m2 = await matchFreeText(client, "Ning, Q., Lan, L., Zhu, L.: Microstructure and mechanical properties of SiC-reinforced Inconel 718 composites. Surf. Coat. Technol., 463 (2023)", "id");
    expect(m2.match).toBe("none");
  });

  it("still says none for a fabricated reference", async () => {
    const { client } = fakeClient(() => [work("W1", "Urban heat islands and bird migration", 2015, { author: "Ann Other" })]);
    const m = await matchFreeText(client, "Smith J, Lee K. Quantum entanglement effects on songbird migration in urban heat islands. Nature. 2019;570:123-130.", "id");
    expect(m.match).toBe("none");
  });

  it("answers from the fallbacks when the first search fails", async () => {
    const hit = work("W2", "Basic local alignment search tool", 1990, { author: "Stephen Altschul" });
    const { client } = fakeClient((f) => { if (!f.includes(" OR ")) throw new Error("400"); return [hit]; });
    const m = await matchFreeText(client, "Altschul SF, Gish W, Miller W, Myers EW, Lipman DJ. Basic local alignment search tool. J Mol Biol. 1990;215(3):403-10.", "id");
    expect(m.work?.id).toBe(hit.id);
  });
});

describe("orFallbackWords", () => {
  it("keeps at most six specific words, longest first", () => {
    const w = orFallbackWords("Analysis of relative gene expression data using real-time quantitative PCR and the 2(-Delta Delta C(T)) Method");
    expect(w.length).toBeLessThanOrEqual(6);
    expect(w).toContain("quantitative");
    expect(w).not.toContain("analysis");
  });
});
