import { describe, it, expect } from "vitest";
import {
  nameTokens, nameTokenVariants, buildLadderFilterValue, givenMatch, authorshipMatches,
  findMatchedAuthorship, fullMatchCount, findMatchedAuthorshipCascade, authorshipIndexForAuthor,
} from "../src/names";

const A = (name: string, id?: string) => ({ raw_author_name: name, author: { display_name: name, id: id ? `https://openalex.org/${id}` : null } });

describe("nameTokens", () => {
  it("lowercases, strips punctuation, folds accents, flips commas", () => {
    expect(nameTokens("Jason Priem")).toEqual(["jason", "priem"]);
    expect(nameTokens("J. Priem")).toEqual(["j", "priem"]);
    expect(nameTokens("Vincent Larivière")).toEqual(["vincent", "lariviere"]);
    expect(nameTokens("Priem, Jason")).toEqual(["jason", "priem"]);
    expect(nameTokens("Heidmann, M. F.")).toEqual(["m", "f", "heidmann"]);
    expect(nameTokens("")).toEqual([]);
    expect(nameTokens(null)).toEqual([]);
  });
  it("offers both comma readings", () => {
    expect(nameTokenVariants("Laureline, Lemoine,")).toEqual([["lemoine", "laureline"], ["laureline", "lemoine"]]);
    expect(nameTokenVariants("Jason Priem")).toEqual([["jason", "priem"]]);
  });
});

describe("ladder", () => {
  const t = nameTokens("Jason R Priem");
  it("widens rung by rung", () => {
    expect(buildLadderFilterValue(t, 1)).toBe('"jason r priem"');
    expect(buildLadderFilterValue(t, 2)).toBe('"jason r priem" OR "priem jason r" OR "jason priem" OR "priem jason"');
    expect(buildLadderFilterValue(t, 3)).toBe('"jason r priem" OR "priem jason r" OR "jason priem" OR "priem jason" OR "j priem" OR "priem j"');
    expect(buildLadderFilterValue(t, 4)).toContain('"j priem"~1');
    expect(buildLadderFilterValue(t, 5)).toContain('"priem jason r"~2');
  });
  it("two-token names skip the drop-middles forms; initials skip the initial form", () => {
    expect(buildLadderFilterValue(nameTokens("Jason Priem"), 2)).toBe('"jason priem" OR "priem jason"');
    expect(buildLadderFilterValue(nameTokens("J Priem"), 3)).toBe('"j priem" OR "priem j"');
    expect(buildLadderFilterValue([], 1)).toBeNull();
  });
});

describe("strict gate", () => {
  it("surname exact, given equal or initial", () => {
    expect(givenMatch("j", "jason")).toBe(true);
    expect(givenMatch("jason", "james")).toBe(false);
    const q = nameTokens("J Smith");
    expect(authorshipMatches(A("John Smith"), q)).toBe(true);
    expect(authorshipMatches(A("James Smith"), q)).toBe(true);
    expect(authorshipMatches(A("Sidney Smith"), nameTokens("John Smith"))).toBe(false);
    expect(authorshipMatches(A("Smith, J."), nameTokens("John Smith"))).toBe(true);
    expect(authorshipMatches(A("John Smithson"), q)).toBe(false);
  });
  it("finds the first matching byline and counts verbatim tokens", () => {
    const auths = [A("Heather Piwowar"), A("Jason Priem"), A("Richard J Priem")];
    expect(findMatchedAuthorship(auths, "J Priem")).toBe(1);
    expect(findMatchedAuthorship(auths, "Sidney Priem")).toBe(-1);
    expect(fullMatchCount(A("Jason R Priem"), nameTokens("Jason Priem"))).toBe(2);
    expect(fullMatchCount(A("J Priem"), nameTokens("Jason Priem"))).toBe(1);
  });
});

describe("cascade", () => {
  it("strict first, then comma variants, initials, overlap; refuses ambiguity", () => {
    expect(findMatchedAuthorshipCascade([A("Jason Priem"), A("Heather Piwowar")], "Priem, Jason")).toMatchObject({ idx: 0, tier: 1 });
    expect(findMatchedAuthorshipCascade([A("Laureline, Lemoine,"), A("Bob Jones")], "Laureline Lemoine")).toMatchObject({ idx: 0, tier: 2 });
    expect(findMatchedAuthorshipCascade([A("Priem J R"), A("Bob Jones")], "Jason Priem")).toMatchObject({ idx: 0, tier: 3 });
    expect(findMatchedAuthorshipCascade([A("Jason"), A("Bob Jones")], "Jason Priem")).toMatchObject({ idx: 0, tier: 4 });
    expect(findMatchedAuthorshipCascade([A("Jason Smith"), A("Jason Jones")], "Jason Priem")).toMatchObject({ idx: -1, tier: "ambiguous", candidateIdxs: [0, 1] });
    expect(findMatchedAuthorshipCascade([A("Bob Jones")], "Jason Priem")).toMatchObject({ idx: -1, tier: "none" });
    expect(findMatchedAuthorshipCascade([], "Jason Priem").tier).toBe("none");
  });
});

describe("authorshipIndexForAuthor", () => {
  it("matches the author id in either URL or short form", () => {
    const auths = [A("Heather Piwowar", "A123"), A("Jason Priem", "A5023888391")];
    expect(authorshipIndexForAuthor(auths, "a5023888391")).toBe(1);
    expect(authorshipIndexForAuthor(auths, "A999")).toBe(-1);
  });
});
