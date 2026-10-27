import { describe, it, expect } from "vitest";
import { titleCoverage, queryCoverage, extractYear, extractDoi, guessSurnames, titleHypotheses, venueness, venueCoverage, mainTitle } from "../src/text";

const guessTitle = (citation: string) => titleHypotheses(citation)[0]!;

// Citation styles the old guesser got wrong (oxjob #1328): the expected title is the first guess.
const STYLES: Array<[string, string]> = [
  ["LeCun Y, Bengio Y, Hinton G. Deep learning. Nature. 2015;521(7553):436-444.", "Deep learning"],
  ["Hanahan D, Weinberg RA. The hallmarks of cancer. Cell. 2000;100(1):57-70.", "The hallmarks of cancer"],
  ["He K, Zhang X, Ren S, Sun J. Deep residual learning for image recognition. In: Proceedings of the IEEE Conference on Computer Vision and Pattern Recognition (CVPR); 2016. p. 770-778.", "Deep residual learning for image recognition"],
  ["Kingma DP, Ba J. Adam: A method for stochastic optimization. arXiv preprint arXiv:1412.6980. 2014.", "Adam: A method for stochastic optimization"],
  ["Vaswani A, Shazeer N, Parmar N, et al. Attention is all you need. Advances in Neural Information Processing Systems. 2017;30.", "Attention is all you need"],
  ["Bourdieu P. Distinction: A Social Critique of the Judgement of Taste. Cambridge, MA: Harvard University Press; 1984.", "Distinction: A Social Critique of the Judgement of Taste"],
  ["Page MJ, McKenzie JE, Bossuyt PM, et al. The PRISMA 2020 statement: an updated guideline for reporting systematic reviews. BMJ. 2021;372:n71.", "The PRISMA 2020 statement: an updated guideline for reporting systematic reviews"],
  ["W. Zhou, D. Liu, W. Fu, H. Wang, X. Song, S. Hu and H. Niu, Insight into the Wetting Behavior of AgCu-xTi on ZrO2: Spreading and Microstructural Evolution, J. Am. Ceram. Soc., 2022, 105(10), p 6076–6085.", "Insight into the Wetting Behavior of AgCu-xTi on ZrO2: Spreading and Microstructural Evolution"],
  ["Cao, J., Yang, J.: Mechanical behavior and low-cycle fatigue performance of a carburized steel for GTF engines. Processes 11(4), 1275 (2023)", "Mechanical behavior and low-cycle fatigue performance of a carburized steel for GTF engines"],
  ["Towl, G.J. and Walker, T. (2019) Tackling Sexual Violence at Universities: An International Perspective, London: Routledge.", "Tackling Sexual Violence at Universities: An International Perspective"],
  ["Torres-Guerrero E, Isa-Isa R, Isa M, Arenas R. Chromoblastomycosis. Clin Dermatol. 2012;30(4):403–8.", "Chromoblastomycosis"],
  ["Perez L R R, Caierão J, Antunes A L S, d'Azevedo P A, Use of the D test method to detect inducible clindamycin resistance in coagulase negative staphylococci (CoNS).Braz J Infect Dis 2007;11(2):186-8", "Use of the D test method to detect inducible clindamycin resistance in coagulase negative staphylococci (CoNS)"],
];

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
  it("reads surnames from the byline only, when given the title", () => {
    const c = "Hanahan D, Weinberg RA. The hallmarks of cancer. Cell. 2000;100(1):57-70.";
    expect(guessSurnames(c, "The hallmarks of cancer")).toEqual(["hanahan", "weinberg"]);
  });
  it.each(STYLES)("finds the title in %s", (citation, title) => {
    expect(titleHypotheses(citation)[0]).toBe(title);
  });
  it("keeps the venue as a later guess, never the first", () => {
    const h = titleHypotheses("Livak KJ, Schmittgen TD. Analysis of relative gene expression data using real-time quantitative PCR and the 2(-Delta Delta C(T)) Method. Methods. 2001;25(4):402-8.");
    expect(h[0]).toMatch(/^Analysis of relative gene expression/);
  });
  it("tells venues and places from titles", () => {
    for (const v of ["In: Proceedings of the IEEE Conference on Computer Vision", "Cambridge, MA: Harvard University Press", "J Biol Chem", "Advances in Neural Information Processing Systems", "Paris, France", "arXiv preprint", "In LPNMR"]) expect(venueness(v)).toBeGreaterThanOrEqual(0.8);
    for (const t of ["Hallmarks of cancer: the next generation", "Deep learning", "Advances in the treatment of melanoma", "Adam: A method for stochastic optimization", "In vivo transcutaneous penetration of nicotinates and sensitive skin", "In Defense of Food: An Eater's Manifesto"]) expect(venueness(t)).toBeLessThan(0.8);
  });
  it("reads abbreviated venues in the citation", () => {
    const c = "Moher D. Preferred reporting items: the PRISMA statement. PLoS Med. 2009;6(7):e1000097.";
    expect(venueCoverage(c, "PLoS Medicine", "Preferred reporting items: the PRISMA statement")).toBe(1);
    expect(venueCoverage(c, "Annals of Internal Medicine", "Preferred reporting items: the PRISMA statement")).toBeLessThan(0.5);
    expect(venueCoverage("Zhou W. Insight. J. Am. Ceram. Soc., 2022", "Journal of the American Ceramic Society")).toBe(1);
  });
  it("splits a main title off its subtitle", () => {
    expect(mainTitle("Evolutionary Ecology of Birds: Life Histories, Mating Systems, and Extinction")).toBe("Evolutionary Ecology of Birds");
    expect(mainTitle("Potentialities: Collected Essays in Philosophy")).toBe("Potentialities");
    expect(mainTitle("Adam: A method for stochastic optimization")).toBeNull();
    expect(mainTitle("Deep learning")).toBeNull();
  });
});
