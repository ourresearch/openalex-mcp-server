import { describe, it, expect, vi, afterEach } from "vitest";
import { OpenAlexClient, OpenAlexError, budgetNote } from "../src/openalex";

const jsonResponse = (status: number, body: any, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

afterEach(() => vi.unstubAllGlobals());

describe("budgetNote", () => {
  it("is silent with plenty left", () => {
    expect(budgetNote({ remaining: 90_000, limit: 100_000 }, "your personal OpenAlex key")).toBeNull();
    expect(budgetNote({}, "x")).toBeNull();
  });
  it("warns under 20% or under 2,000 credits, naming the key", () => {
    const n = budgetNote({ remaining: 1500, limit: 10_000, resetSeconds: 7200 }, "your personal OpenAlex key")!;
    expect(n).toContain("1,500 of 10,000 credits");
    expect(n).toContain("$0.15");
    expect(n).toContain("your personal OpenAlex key");
    expect(n).toContain("2 hours");
    expect(budgetNote({ remaining: 150_000, limit: 1_000_000 }, "the Univ organization key")).toContain("the Univ organization key");
  });
});

describe("OpenAlexClient", () => {
  it("records budget headers and credits", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(200, { ok: 1 }, { "x-ratelimit-remaining": "900", "x-ratelimit-limit": "10000", "x-ratelimit-reset": "100", "x-ratelimit-credits-used": "3" })));
    const c = new OpenAlexClient({ apiKey: "k", keyLabel: "your personal OpenAlex key" });
    await c.get("/works");
    expect(c.creditsUsed).toBe(3);
    expect(c.lastBudget).toEqual({ remaining: 900, limit: 10000, resetSeconds: 100 });
    expect(c.budgetNote()).toContain("900 of 10,000");
  });

  it("fires onUnauthorized once on 401 and names the key", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(401, { message: "bad key" })));
    const onUnauthorized = vi.fn();
    const c = new OpenAlexClient({ apiKey: "k", keyLabel: "the Univ organization key", onUnauthorized });
    await expect(c.get("/works")).rejects.toMatchObject({ status: 401 });
    await expect(c.get("/works")).rejects.toThrow(/rejected the Univ organization key/);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("explains a daily-budget 429 with the key label and the pricing link", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(429, { message: "budget" }, { "retry-after": "7200" })));
    const c = new OpenAlexClient({ apiKey: "k", keyLabel: "your personal OpenAlex key" });
    const err = await c.get("/works").catch((e) => e);
    expect(err).toBeInstanceOf(OpenAlexError);
    expect(err.message).toMatch(/^Your personal OpenAlex key has used up its daily OpenAlex budget\./);
    expect(err.message).toContain("2 hours");
    expect(err.message).toContain("https://openalex.org/pricing");
  });
});
