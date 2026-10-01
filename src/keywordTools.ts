/**
 * Keyword-aware search tools (oxjob #1469): find_keywords (description → candidate keywords with
 * how many works carry each) and keyword_search (facets of text OR keywords, ANDed, with counts per part).
 * Gated by the KEYWORD_SEARCH var until the keywords are fully in the works index (#1456).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { OpenAlexClient, OpenAlexError, type ListResponse } from "./openalex";
import { shortId } from "./ids";
import { compact, abstractFromInvertedIndex, truncate } from "./shape";
import { WORK_TYPES } from "./filters";
import { reproduceUrl } from "./oql";
import { buildKeywordSearch, keywordSlug } from "./keywordSearch";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export interface KeywordDeps {
  client: OpenAlexClient;
  run: (tool: string, body: () => Promise<ToolResult>) => () => Promise<ToolResult>;
  ok: (payload: Record<string, any>) => ToolResult;
  fail: (message: string) => ToolResult;
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const MAX_KEYWORDS = 30;
/** A facet that keeps at least this share of what the other facets match is not narrowing anything. */
const LOOSE_FACET = 0.85;

/** Run async jobs with bounded concurrency, keeping order. */
async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  }));
  return out;
}

export const KEYWORD_RECIPE = `Recipe for "do a thorough search", "find everything on X", "build a systematic search" (keyword-aware; use it whenever the user wants recall, not just a few good papers):
1. Split the topic into its facets, the parts that must all hold (e.g. "microplastics" and "human health"). For each facet write the phrase plus the synonyms, spellings and abbreviations a careful searcher would try: phrases that mean the facet, not single generic words (human, patients, blood) that appear in almost any abstract.
2. find_keywords(description=<the user's topic in a sentence>, phrases=<each facet's main phrase and a synonym or two>). It returns OpenAlex keywords with how many works carry each and their most-cited titles.
3. For each facet keep the keywords that mean that facet (read the top titles; drop broader or different-sense ones). Every facet needs its own keyword: a keyword for only one facet, OR'd in, pulls in that whole field. A facet with no fitting keyword stays text-only.
4. keyword_search(facets=[{label, text, keyword_ids}, …], plus filters such as open_access_only, from_year, types). Each facet matches on its text OR its keywords; facets are ANDed. Keywords widen the text search, never replace it (about 11% of works have no keywords).
5. Report the counts it returns: the title/abstract search alone, what the keywords add, the combined total, and per facet. Read both random samples (the whole search, and the keyword-only additions) and say roughly how many look on topic. If the whole search is loose, tighten the facets' text (phrases, not single generic words) and rerun; offer the user a broad and a strict version when the trade-off is real. For the additions: if many are off topic, see which keywords bring them in (added_per_keyword), drop or swap a keyword only when its additions are mostly off topic, and rerun. Never drop a facet's core keyword (the one named like the facet) over a few strays. Act on the warnings: a facet that keeps nearly everything the other facets match is too generic.
6. Hand back the combined OQL and its reproduce_url, then show results with search_works(oql=<combined>, sort=cited_by_count or relevance).`;

export function registerKeywordTools(server: McpServer, deps: KeywordDeps) {
  const { client, run, ok, fail } = deps;

  /** Works carrying one keyword (count + most-cited titles). One cheap list call. */
  const keywordProfile = async (slug: string) => {
    try {
      const d = await client.get<ListResponse>("/works", {
        filter: `keywords.id:${slug},is_retracted:false`,
        per_page: 3,
        sort: "cited_by_count:desc",
        select: "display_name,publication_year",
      });
      return { works: d.meta.count ?? 0, top_titles: d.results.map((w: any) => `${w.display_name ?? "(untitled)"}${w.publication_year ? ` (${w.publication_year})` : ""}`) };
    } catch (e: any) {
      if (e instanceof OpenAlexError && (e.status === 404 || e.status === 400)) return { works: 0, top_titles: [] as string[] };
      throw e;
    }
  };

  // -------------------------------------------------------------------------
  // find_keywords
  // -------------------------------------------------------------------------
  server.registerTool(
    "find_keywords",
    {
      title: "Find keywords",
      description:
        "Find the OpenAlex keywords for a topic, the first step of a thorough (high-recall) search. " +
        "OpenAlex tags works with keywords (e.g. microplastics, human-health, antimicrobial-resistance) that also catch works using other wordings, other languages, or no abstract at all. " +
        "Give the topic as a sentence (description) and, for better coverage, each facet's main phrase and synonyms (phrases). " +
        "Returns candidate keywords with a match score, how many works carry each, and their three most-cited titles, so you can keep the ones that mean each facet and drop the rest. " +
        "Then pass them to keyword_search. Costs about $0.01 (one /text/keywords call) plus a few cheap lookups.",
      inputSchema: {
        description: z.string().min(1).max(2000).describe("The topic in a sentence or short paragraph, e.g. \"how microplastics affect human health\". At least 20 characters to be matched as text."),
        phrases: z.array(z.string().min(2).max(100)).max(12).optional().describe("Short names to look up among keyword names: each facet's main phrase and a synonym or two, e.g. [\"microplastics\", \"nanoplastics\", \"human health\"]."),
        per_phrase: z.number().int().min(1).max(10).optional().describe("Keyword-name matches kept per phrase. Default 5."),
      },
      annotations: { title: "Find keywords", ...READ_ONLY },
    },
    async (args) =>
      run("find_keywords", async () => {
        const desc = args.description.trim();
        const perPhrase = args.per_phrase ?? 5;
        const notes: string[] = [];
        let fromText: Array<{ id: string; name: string; score: number }> = [];
        if (desc.length >= 20) {
          const d = await client.get<any>("/text/keywords", { title: desc });
          fromText = (d.keywords ?? []).map((k: any) => ({ id: keywordSlug(String(k.id)), name: k.display_name, score: Number(Number(k.score).toFixed(3)) }));
        } else {
          notes.push("description is under 20 characters, so it was not matched as text; only the phrases were looked up.");
        }
        const phrases = [...new Set((args.phrases ?? []).map((p) => p.trim()).filter(Boolean))];
        const byPhrase = await pool(phrases, 6, async (p) => {
          const d = await client.get<ListResponse>("/keywords", { search: p.replace(/,/g, " "), per_page: perPhrase, select: "id,display_name" });
          return { phrase: p, ids: d.results.map((k: any) => ({ id: keywordSlug(String(k.id)), name: k.display_name as string })) };
        });
        const names = new Map<string, string>();
        for (const k of fromText) names.set(k.id, k.name);
        for (const b of byPhrase) for (const k of b.ids) if (!names.has(k.id)) names.set(k.id, k.name);
        const ids = [...names.keys()].slice(0, MAX_KEYWORDS);
        if (names.size > MAX_KEYWORDS) notes.push(`Only the first ${MAX_KEYWORDS} keywords were profiled; use fewer phrases or a lower per_phrase.`);
        const profiles = new Map<string, Awaited<ReturnType<typeof keywordProfile>>>();
        await pool(ids, 8, async (id) => { profiles.set(id, await keywordProfile(id)); });
        const card = (id: string, extra: Record<string, any> = {}) => {
          const p = profiles.get(id);
          return compact({ id, name: names.get(id), ...extra, works: p?.works, top_titles: p?.top_titles });
        };
        if (!fromText.length && !byPhrase.some((b) => b.ids.length)) notes.push("No keywords matched. Search on text alone, or try other phrases.");
        return ok(compact({
          from_description: fromText.length ? fromText.filter((k) => profiles.has(k.id)).map((k) => card(k.id, { score: k.score })) : undefined,
          from_phrases: byPhrase.length ? byPhrase.map((b) => ({ phrase: b.phrase, keywords: b.ids.filter((k) => profiles.has(k.id)).map((k) => card(k.id)) })) : undefined,
          works_note: "works = how many works carry the keyword now (what a keyword clause matches), excluding retracted works.",
          next: "Keep, per facet, the keywords that mean that facet; then call keyword_search with each facet's text and keyword_ids.",
          notes: notes.length ? notes : undefined,
        }));
      })()
  );

  // -------------------------------------------------------------------------
  // keyword_search
  // -------------------------------------------------------------------------
  const facetSchema = z.object({
    label: z.string().max(100).optional().describe("Short name for the facet, e.g. \"microplastics\"."),
    text: z.string().max(2000).optional().describe("Title/abstract search for the facet: OQL text inside `title/abstract has (…)`. Synonyms joined with or, \"quoted phrases\", wildcards only inside quotes, e.g. microplastic or microplastics or \"nanoplastic*\"."),
    keyword_ids: z.array(z.string().max(200)).max(15).optional().describe("Keyword ids from find_keywords that mean this facet, e.g. [\"microplastics\"]. Any of them matches."),
  });

  server.registerTool(
    "keyword_search",
    {
      title: "Keyword-aware search",
      description:
        "Build and measure a thorough search: each facet matches on its title/abstract text OR its keywords, and all facets must match. " +
        "Returns the combined OQL with a reproduce_url, and counts for every part: the text-only search, what the keywords add, the combined total, and each facet's text, keyword and keyword-only counts, " +
        "plus random samples of the whole search and of the works found only through keywords, so you can check precision. " +
        "Filters (open access, years, types, language, any OQL condition) apply to every count. " +
        "Use after find_keywords; then list the results with search_works(oql=<combined oql>). " +
        "Every facet should have text; give a facet keyword_ids only when a keyword really means it.",
      inputSchema: {
        facets: z.array(facetSchema).min(1).max(6).describe("The parts of the topic that must all hold, each with its text and keywords."),
        from_year: z.number().int().min(1000).max(2100).optional().describe("Earliest publication year, inclusive."),
        to_year: z.number().int().min(1000).max(2100).optional().describe("Latest publication year, inclusive."),
        types: z.array(z.enum(WORK_TYPES)).optional().describe("Only these work types (OR), e.g. [\"article\",\"review\"]."),
        open_access_only: z.boolean().optional().describe("Only works with a free-to-read copy."),
        language: z.string().length(2).optional().describe("ISO-639-1 language code, e.g. \"en\". Note that keywords are what find works in other languages."),
        extra_oql: z.string().max(2000).optional().describe("Any further OQL condition ANDed onto every count, e.g. country is (BR) or \"cited by count >= (10)\"."),
        include_retracted: z.boolean().optional().describe("Include retracted works. Default false."),
        sample_size: z.number().int().min(0).max(25).optional().describe("Random works to show from the keyword-only additions (up to 8 are also drawn from the whole search). Default 8."),
      },
      annotations: { title: "Keyword-aware search", ...READ_ONLY },
    },
    async (args) =>
      run("keyword_search", async () => {
        let built: ReturnType<typeof buildKeywordSearch>;
        try {
          built = buildKeywordSearch(args.facets, args);
        } catch (e: any) {
          return fail(e?.message ?? String(e));
        }
        const count = async (oql: string | null): Promise<number | null> => {
          if (!oql) return null;
          const d = await client.post<ListResponse>({ oql, per_page: 1, select: "id" });
          return d.meta.count ?? 0;
        };
        const { queries, perFacet } = built;
        // Keyword ids that don't exist match nothing, silently; catch them before counting.
        const allKw = [...new Set(built.facets.flatMap((f) => f.keywords))];
        const known = new Set<string>();
        for (let i = 0; i < allKw.length; i += 50) {
          const d = await client.get<ListResponse>("/keywords", { filter: `id:${allKw.slice(i, i + 50).join("|")}`, per_page: 50, select: "id" });
          for (const k of d.results) known.add(keywordSlug(String((k as any).id)));
        }
        const unknown = allKw.filter((k) => !known.has(k));
        if (unknown.length) return fail(`Not OpenAlex keyword ids: ${unknown.join(", ")}. Use ids that find_keywords returned (it lists real ids only), or drop them.`);
        // The combined query first: an OQL error surfaces once, with its fix-it, before the fan-out.
        const combined = await count(queries.combined);
        const [textOnly, added] = await Promise.all([count(queries.text_only), count(queries.added_by_keywords)]);
        const facetCounts = await pool(perFacet, 3, async (p) => {
          const [t, k, knt, others] = await Promise.all([count(p.text), count(p.keyword), count(p.keyword_not_text), count(p.others)]);
          return {
            facet: p.label, text: t, keyword: k, keyword_not_text: knt, either: t !== null && knt !== null ? t + knt : null,
            // Share of what the other facets match that this facet keeps: near 100% means it narrows nothing.
            keeps_of_others: others && combined !== null ? `${Math.round((100 * combined) / others)}%` : null,
            keeps: others && combined !== null ? combined / others : null,
          };
        });
        // What each keyword brings in: additions carrying it (a work can carry several, so these overlap).
        const perKeyword = added ? await pool(allKw, 6, async (k) => ({ keyword: k, added: await count(built.addedWith(k)) })) : [];
        const warnings = [...built.warnings];
        for (const f of facetCounts) {
          if ((f.keeps ?? 0) >= LOOSE_FACET) warnings.push(`"${f.facet}" keeps ${f.keeps_of_others} of the works the other facets match, so it hardly narrows the search. Its text is probably too generic (single words like human, patients, blood, stress): use phrases that mean the facet.`);
        }
        const n = args.sample_size ?? 8;
        const randomWorks = async (oql: string, size: number) => {
          const d = await client.post<ListResponse>({
            oql: `${oql} sample ${size}`,
            per_page: size,
            select: "id,display_name,publication_year,language,primary_topic,abstract_inverted_index",
          });
          return d.results.map((w: any) => {
            const abs = abstractFromInvertedIndex(w.abstract_inverted_index);
            return compact({
              id: shortId(w.id), title: w.display_name ?? null, year: w.publication_year ?? null,
              language: w.language && w.language !== "en" ? w.language : null,
              topic: w.primary_topic?.display_name ?? null,
              abstract: abs ? truncate(abs, 220) : "(no abstract)",
            });
          });
        };
        // Two random draws: what the keywords add, and the whole search (judged in #1469, the text side was
        // the weaker one when facets used generic words, so the caller needs to see both).
        const [sample, overall] = await Promise.all([
          n > 0 && queries.added_by_keywords && added ? randomWorks(queries.added_by_keywords, n) : Promise.resolve(undefined),
          n > 0 && combined ? randomWorks(queries.combined, Math.min(n, 8)) : Promise.resolve(undefined),
        ]);
        const share = textOnly && added !== null ? `${added >= 0 ? "+" : ""}${Math.round((100 * added) / textOnly)}%` : null;
        return ok(compact({
          oql: queries.combined,
          reproduce_url: reproduceUrl(queries.combined),
          counts: compact({
            combined,
            text_only: textOnly,
            added_by_keywords: added,
            keywords_add: share,
          }),
          per_facet: facetCounts.map(({ keeps, ...f }) => compact(f)),
          added_per_keyword: perKeyword.length ? perKeyword.sort((a, b) => (b.added ?? 0) - (a.added ?? 0)) : undefined,
          added_sample: sample,
          added_sample_basis: sample ? `random ${sample.length} of the ${added} works found only through keywords` : undefined,
          overall_sample: overall,
          overall_sample_basis: overall ? `random ${overall.length} of all ${combined} works; if many are off topic, tighten the facets' text` : undefined,
          queries: compact({ text_only: queries.text_only, added_by_keywords: queries.added_by_keywords }),
          warnings: warnings.length ? warnings : undefined,
          next: "Show results with search_works(oql=<oql>), and give the user the oql and reproduce_url.",
        }));
      })()
  );
}
