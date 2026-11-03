import { describe, it, expect, vi, beforeEach } from "vitest";
import requests1318 from "./fixtures/samework-requests-1318.json";
import { matchFreeText } from "../src/references";
import { jevJudge, buildRequest, resetJevPause, JEV_URL } from "../src/sameWork";
import type { OpenAlexClient } from "../src/openalex";

const work = (id: string, title: string, year: number, extra: Record<string, any> = {}) => ({
  id: `https://openalex.org/${id}`, display_name: title, publication_year: year, type: extra.type ?? "article",
  authorships: [{ author: { display_name: extra.author ?? "Nobody" } }], primary_location: { source: { display_name: extra.venue ?? null } },
  biblio: {}, doi: "doi" in extra ? extra.doi : `https://doi.org/10.1/${id}`, cited_by_count: extra.cites ?? 0,
});
const clientOf = (results: any[]) => ({ get: async () => ({ meta: {}, results }) }) as unknown as OpenAlexClient;
const answer = (probs: Record<string, number>) => new Response(JSON.stringify({ answers: { cited_work: { probabilities: probs } } }), { status: 200 });
/** The real judge, answering from a fixed probability map. */
const judgeOf = (probs: Record<string, number>) => jevJudge("k", (async () => answer(probs)) as any);

const ref = "Priem J, Hemminger BM. Scientometrics 2.0: New metrics of scholarly impact on the social Web. First Monday. 2010;15(7).";
const sci = work("W2122130843", "Scientometrics 2.0: New metrics of scholarly impact on the social Web", 2010, { author: "Jason Priem" });

beforeEach(() => resetJevPause());

describe("the request oxjob #1318 measured", () => {
  // Five requests #1318 sent when it measured this question (97.6% precise, 93.9% recall at p >= 0.7); the CV parser
  // tests the same five. Any change to the instruction, the options, the card fields or their order fails here:
  // re-measure before changing them.
  const fixture: any[] = requests1318;
  const asWork = (c: any) => ({
    id: c.id, display_name: c.title, publication_year: c.year, type: c.type,
    authorships: Array.from({ length: c.n_authors }, (_, i) => ({ author: { display_name: c.authors[i] ?? "x" } })),
    primary_location: { source: c.venue == null ? null : { display_name: c.venue } },
  });
  it.each(fixture.map((f) => [f.id, f]))("rebuilds %s byte for byte", (_id, f) => {
    expect(JSON.stringify(buildRequest(f.citation, f.request.state.citation_year, f.candidates.map(asWork)))).toBe(JSON.stringify(f.request));
  });
});

describe("matchFreeText with a same-work judge (oxjob #1330)", () => {
  it("labels by Jev's probability: >= 0.9 exact, >= 0.7 likely, >= 0.5 uncertain, else none", async () => {
    for (const [p, label] of [[0.95, "exact"], [0.8, "likely"], [0.6, "uncertain"], [0.45, "none"]] as const) {
      const m = await matchFreeText(clientOf([sci]), ref, "id", judgeOf({ c1: p, none: (1 - p) / 2, unknown: (1 - p) / 2 - 0.01 }));
      expect(m.match).toBe(label);
      expect(m).toMatchObject({ matcher: "jev", match_p: p });
      expect(m.work?.id ?? null).toBe(label === "none" ? null : sci.id);
    }
  });

  it("lets Jev's 'none' overrule an exact title score", async () => {
    const m = await matchFreeText(clientOf([sci]), ref, "id", judgeOf({ c1: 0.3, none: 0.7 }));
    expect(m).toMatchObject({ match: "none", work: null, match_p: 0.3 });
  });

  it("falls back to the title score when Jev can't answer", async () => {
    const m = await matchFreeText(clientOf([sci]), ref, "id", jevJudge("k", (async () => new Response("down", { status: 503 })) as any));
    expect(m).toMatchObject({ match: "exact", matcher: "heuristic" });
    expect(m.match_p).toBeUndefined();
  });

  it("still moves to the cited work's own record after Jev picks a weaker copy", async () => {
    // Jev picks the DOI-less repository copy (ranked first); canonical() answers with the publisher's record.
    const copy = work("W9", sci.display_name, 2010, { author: "Jason Priem", doi: null });
    const m = await matchFreeText(clientOf([copy, sci]), ref, "id", async (_c, _y, works) => ({ picked: true, best: works.indexOf(copy), p: 0.95 }));
    expect(m.work?.id).toBe(sci.id);
  });
});

describe("jevJudge", () => {
  it("sends the request to Jev and reads the best candidate even when 'none' wins", async () => {
    const f = vi.fn(async () => answer({ c1: 0.2, c2: 0.3, none: 0.5 }));
    expect(await jevJudge("k", f as any)("cite 2010", 2010, [sci, sci])).toEqual({ picked: false, best: 1, p: 0.3 });
    const [url, init] = (f.mock.calls[0] as any[]) ?? [];
    expect(url).toBe(JEV_URL);
    expect(init.body).toBe(JSON.stringify(buildRequest("cite 2010", 2010, [sci, sci])));
  });

  it("returns null on an error and skips Jev for a while after, across judges", async () => {
    const f = vi.fn(async () => new Response("down", { status: 503 }));
    expect(await jevJudge("k", f as any)("x", null, [sci])).toBeNull();
    expect(await jevJudge("k", f as any)("x", null, [sci])).toBeNull();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("shows at most five candidates", async () => {
    const f = vi.fn(async () => answer({ c1: 1 }));
    await jevJudge("k", f as any)("x", null, Array.from({ length: 8 }, () => sci));
    expect(JSON.parse((f.mock.calls[0] as any[])[1].body).state.candidates).toHaveLength(5);
  });
});
