import { describe, it, expect } from "vitest";
import { titleCoverage, queryCoverage, extractYear, extractDoi, guessTitle, guessSurnames } from "../src/text";

describe("text helpers", () => {
  it("extracts DOIs and years", () => {
    expect(extractDoi("see https://doi.org/10.7717/peerj.4375.")).toBe("10.7717/peerj.4375");
    expect(extractDoi("no doi here")).toBeNull();
    expect(extractYear("Piwowar H, et al. (2018). The state of OA. PeerJ 6:e4375")).toBe(2018);
  });
  it("guesses the title from an APA-ish citation", () => {
    const t = guessTitle("Piwowar, H., Priem, J., Larivière, V., Alperin, J. P. (2018). The state of OA: a large-scale analysis of the prevalence and impact of Open Access articles. PeerJ, 6, e4375.");
    expect(t.toLowerCase()).toContain("state of oa");
    expect(t.toLowerCase()).not.toContain("piwowar");
  });
  it("prefers quoted titles", () => {
    expect(guessTitle('Smith J. "A very specific title about kelp forests" Nature 2020')).toBe("A very specific title about kelp forests");
  });
  it("scores title coverage", () => {
    expect(titleCoverage("The state of OA: a large-scale analysis of the prevalence and impact of Open Access articles", "The state of OA: a large-scale analysis of the prevalence and impact of Open Access articles")).toBe(1);
    expect(titleCoverage("CRISPR off-target effects", "Engineering precision nanoparticles for drug delivery")).toBe(0);
  });
  it("short citations: guessed title fully inside candidate, surnames found", () => {
    const cit = "Piwowar et al. (2018) The state of OA. PeerJ";
    const guess = guessTitle(cit);
    expect(guess.toLowerCase()).toBe("the state of oa");
    expect(queryCoverage(guess, "The state of OA: a large-scale analysis of the prevalence and impact of Open Access articles")).toBe(1);
    expect(guessSurnames(cit)).toEqual(["piwowar"]);
    expect(guessSurnames("Lazzarotto CR, Malinin NL, Li Y, et al. CHANGE-seq reveals. Nat Biotechnol. 2020")).toContain("lazzarotto");
  });
});
