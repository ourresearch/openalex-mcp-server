/**
 * Profile-curation tools (oxjob #1269): identity, claiming, candidate discovery, curations.
 * Claude is the curator; these tools supply evidence and a write channel and never decide
 * ownership on their own.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { OpenAlexClient, OpenAlexError, type ListResponse } from "./openalex";
import { UsersApiClient, UsersApiError, type MeRecord, type CurationPayload } from "./users";
import { shortId, normalizeWorkId } from "./ids";
import { shapeWork, shapeEntity, compact } from "./shape";
import { nameTokens, buildLadderFilterValue, findMatchedAuthorship, fullMatchCount, LADDER_STEPS } from "./names";
import { normalizeOrcid, fetchOrcidWorks, OrcidError } from "./orcid";
import { toPayload, shapeCurationRow, pickAuthorship, coauthorNames, CurationItemError, type CurationItem } from "./curation";

export type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export interface AccountContext {
  userId: string;
  email?: string;
  displayName?: string;
  keyKind: "personal" | "organization";
  organizationName?: string;
  clientName?: string;
  /** False when the grant predates personal_api_key and runs on an org key: users-api calls need a reconnect. */
  usersApiReady: boolean;
}

export interface CurationDeps {
  client: OpenAlexClient;
  users: UsersApiClient | null;
  account: AccountContext | null;
  run: (tool: string, body: () => Promise<ToolResult>) => () => Promise<ToolResult>;
  ok: (payload: Record<string, any>) => ToolResult;
  fail: (message: string) => ToolResult;
  listSelect: string[];
}

const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

export const LATENCY_NOTE = "Curations apply on the nightly data refresh and are live within about two days; track them with list_my_curations. Do not re-check in minutes and conclude they failed.";
const RECONNECT = "This connection cannot reach OpenAlex accounts: it was made before profile curation existed and runs on an organization key. Ask the user to reconnect the OpenAlex connector (disconnect and connect again), then retry.";
const ADD_CAP = 1000;
const MAX_ITEMS = 100;
const COUNT_THRESHOLD = 100;
const COMMON_NAME_THRESHOLD = 1000;

/** users-api stores author ids as https://openalex.org/authors/a123 as well as the bare form. */
const authorShort = (id: string | null | undefined): string | null => {
  const s = shortId(String(id ?? "").replace(/^(https?:\/\/openalex\.org\/)?authors\//i, ""));
  return s && /^A\d+$/.test(s) ? s : null;
};

const stripOrcid = (s: any) => (s ? String(s).replace(/^https?:\/\/orcid\.org\//i, "") : null);

/** Compact author profile used by get_my_account and find_candidate_works. */
function authorSummary(e: any) {
  const years = (e.counts_by_year ?? []).map((c: any) => c.year).filter((y: any) => Number.isFinite(y));
  return compact({
    id: shortId(e.id),
    name: e.display_name ?? null,
    alternate_names: (e.display_name_alternatives ?? []).slice(0, 15),
    orcid: stripOrcid(e.orcid),
    works_count: e.works_count ?? null,
    cited_by_count: e.cited_by_count ?? null,
    h_index: e.summary_stats?.h_index ?? null,
    current_institutions: (e.last_known_institutions ?? []).map((i: any) => i?.display_name).filter(Boolean),
    affiliations: (e.affiliations ?? []).slice(0, 10).map((a: any) =>
      compact({
        institution: a?.institution?.display_name,
        id: shortId(a?.institution?.id),
        country: a?.institution?.country_code,
        years: Array.isArray(a?.years) && a.years.length ? `${Math.min(...a.years)}-${Math.max(...a.years)}` : null,
      })
    ),
    topics: (e.topics ?? []).slice(0, 8).map((t: any) => compact({ id: shortId(t?.id), name: t?.display_name, works: t?.count })),
    recent_years: years.length ? `${Math.min(...years)}-${Math.max(...years)}` : null,
    openalex_url: e.id ? `https://openalex.org/${shortId(e.id)}` : null,
  });
}

function shapeClaim(c: MeRecord["claim"]) {
  if (!c) return null;
  return compact({
    author_id: authorShort(c.author_id) ?? c.author_id,
    decision: c.decision,
    auto_approved: c.auto_approved,
    submitted_at: c.submitted_at ? String(c.submitted_at).slice(0, 19) : null,
    decided_at: c.decided_at ? String(c.decided_at).slice(0, 19) : null,
    decision_note: c.decision_note,
  });
}

export function registerCurationTools(server: McpServer, deps: CurationDeps) {
  const { client, run, ok, fail, listSelect } = deps;

  const users = (): UsersApiClient => {
    if (!deps.users || !deps.account?.usersApiReady) throw new UsersApiError(RECONNECT, 0);
    return deps.users;
  };

  const fetchAuthor = (aid: string) => client.get(`/authors/${aid}`);

  /** The account's approved claimed author, or an explanation of why there is none. */
  const claimedAuthor = async (me: MeRecord): Promise<{ aid: string } | { error: string }> => {
    const aid = me.author_id ? authorShort(me.author_id) : null;
    if (aid && me.claim?.approved_at) return { aid };
    if (me.claim && me.claim.decision === "pending") return { error: `Your claim on ${authorShort(me.claim.author_id)} is still under review; curation opens once it is approved.` };
    if (me.claim && me.claim.decision === "rejected") return { error: `Your claim on ${authorShort(me.claim.author_id)} was declined${me.claim.decision_note ? ` (${me.claim.decision_note})` : ""}. Contact support@openalex.org to appeal.` };
    if (aid) return { aid };
    return { error: "This account has not claimed an author profile yet. Use claim_author_profile first." };
  };

  // -------------------------------------------------------------------------
  // get_my_account
  // -------------------------------------------------------------------------
  server.registerTool(
    "get_my_account",
    {
      title: "Get my OpenAlex account",
      description:
        "Who is connected: name, email addresses (and which are verified), which API key this connection spends (personal or organization), " +
        "the author profile this account has claimed (with a compact summary: names, institutions, topics, works count), the claim's status, and claim_eligibility: " +
        "\"instant\" means a claim from this account is approved immediately (a verified academic, institutional or government email), \"review\" means it queues for moderation and needs evidence. " +
        "Call this first for anything about the user's own profile.",
      inputSchema: {},
      annotations: { title: "Get my OpenAlex account", ...READ },
    },
    async () =>
      run("get_my_account", async () => {
        const me = await users().me();
        const aid = me.author_id ? authorShort(me.author_id) : null;
        let claimed: any = null;
        if (aid) {
          try {
            claimed = authorSummary(await fetchAuthor(aid));
          } catch (e: any) {
            claimed = { id: aid, note: e instanceof OpenAlexError && e.status === 404 ? "This profile no longer exists in OpenAlex (it may have been merged away)." : `Profile lookup failed: ${e?.message ?? e}` };
          }
        }
        const emails = (me.emails ?? []).map((x) => compact({ email: x.email, verified: x.verified ?? x.is_verified ?? (x.verified_at ? true : undefined), primary: x.is_primary || undefined }));
        if (!emails.some((x) => x.email === me.email)) emails.unshift({ email: me.email, verified: true, primary: true });
        return ok(compact({
          user: compact({ display_name: me.display_name, emails }),
          key: compact({ kind: deps.account?.keyKind ?? "personal", organization: deps.account?.organizationName ?? me.organization_name ?? null, role: me.organization_role ?? null }),
          claimed_author: claimed,
          claim: shapeClaim(me.claim),
          claim_eligibility: me.claim_eligibility ?? "unknown",
          next_step: claimed
            ? "Profile claimed: audit it with search_works(author_ids=[id], for_author=id) and find_candidate_works."
            : me.claim?.decision === "pending"
              ? "Claim under review; curation opens once approved."
              : me.claim_eligibility === "review"
                ? "No claimed profile. Find it with search_entities (authors), confirm with the user, collect evidence (a link to a page or paper showing both the profile name and the account email), then claim_author_profile."
                : "No claimed profile. Find it with search_entities (authors), confirm with the user, then claim_author_profile.",
        }));
      })()
  );

  // -------------------------------------------------------------------------
  // claim_author_profile
  // -------------------------------------------------------------------------
  server.registerTool(
    "claim_author_profile",
    {
      title: "Claim an author profile",
      description:
        "Claim an OpenAlex author profile for the connected account so it can be curated. One claim per account, and it cannot be moved to another profile later, so confirm the profile with the user first " +
        "(show its name, institutions, works count and a few titles from search_works). Accounts with a verified academic/institutional/government email are approved instantly (get_my_account reports claim_eligibility); " +
        "otherwise the claim queues for review and evidence is required: ask the user for a link to a web page or paper that shows both the name on the profile and their account email (a departmental page, lab site, or author list). " +
        "Claims can be reviewed at any time and a fraudulent claim is revoked with its edits reverted.",
      inputSchema: {
        author_id: z.string().min(2).max(300).describe("OpenAlex author ID, e.g. A5023888391."),
        evidence: z.string().max(2000).optional().describe("Evidence that the user is this author (a URL plus a sentence). Required when claim_eligibility is \"review\"; optional when \"instant\"."),
      },
      annotations: { title: "Claim an author profile", ...WRITE, idempotentHint: false },
    },
    async ({ author_id, evidence }) =>
      run("claim_author_profile", async () => {
        const aid = authorShort(author_id);
        if (!aid) return fail(`author_id must be an OpenAlex author ID like A5023888391, got "${author_id}".`);
        const api = users();
        const me = await api.me();
        if (me.claim) {
          const cid = authorShort(me.claim.author_id);
          if (cid === aid && (me.claim.decision === "approved" || me.author_id)) return ok({ already_claimed: true, author_id: aid, message: "This account already owns that profile. Go ahead and curate it." });
          return fail(`This account already has a claim on ${cid} (status: ${me.claim.decision}). One claim per account; contact support@openalex.org to change it.`);
        }
        const status = await api.claimStatus(aid);
        if (status.claimed) return fail(`${aid} is already claimed by another account. If it is the user's profile, they should contact support@openalex.org.`);
        if (status.pending) return fail(`${aid} already has a claim under review by someone. If it is the user's profile, they should contact support@openalex.org.`);
        const eligibility = me.claim_eligibility ?? "unknown";
        const text = (evidence ?? "").trim();
        if (eligibility === "review" && text.length < 10) {
          return fail("This account's email is not on a trusted academic domain, so the claim will be reviewed and needs evidence. Ask the user for a link to a page or paper that shows both the profile name and their account email, then call again with evidence.");
        }
        const sent = text || `Claimed through the OpenAlex connector${deps.account?.clientName ? ` (${deps.account.clientName})` : ""}; account email on a trusted domain.`;
        const r = await api.claimAuthor(me.id, aid, sent);
        return ok(compact({
          auto_approved: r.auto_approved,
          claim_id: r.claim_id,
          author_id: aid,
          message: r.message,
          next_step: r.auto_approved
            ? "Approved. The account now owns this profile: audit it with search_works(author_ids=[id], for_author=id) and find_candidate_works, then submit_curations."
            : "Queued for review (usually a few days). Curation tools will work once it is approved; the user can check back with get_my_account.",
        }));
      })()
  );

  // -------------------------------------------------------------------------
  // find_candidate_works
  // -------------------------------------------------------------------------
  server.registerTool(
    "find_candidate_works",
    {
      title: "Find works that may belong to an author",
      description:
        "Works that are probably this author's but are not on their profile, from up to three sources: " +
        "(1) name: the website's name ladder over raw bylines (as typed, reversed, initials, then looser word order) with a surname-plus-given-name gate, ranked by how much of the name the byline matches; " +
        "(2) orcid: works carrying the ORCID in OpenAlex plus works listed on the public ORCID record (readable without login unless the author made them private); " +
        "(3) siblings: other author profiles with the same name, with overlap signals, which may be duplicates of this person. " +
        "Every work reports this_authorship (the byline that would be attached, with affiliations and coauthors) so the user can be asked about anything unclear. " +
        "Pass alternate names (from get_my_account, the profile, or a CV) one call at a time; for common names add institution, topic or year filters.",
      inputSchema: {
        author_id: z.string().min(2).max(300).describe("The profile being curated (A…). Works already on it are excluded."),
        name: z.string().max(200).optional().describe("Name to search bylines for. Default: the profile's display name. Try each alternate name the person publishes under."),
        orcid: z.string().max(60).optional().describe("The author's ORCID, if they gave one."),
        sources: z.array(z.enum(["name", "orcid", "siblings"])).optional().describe("Which sources to run. Default: all that apply."),
        limit: z.number().int().min(1).max(50).optional().describe("Max works per source. Default 25."),
        institution_ids: z.array(z.string()).optional().describe("Narrow the name search to works with an author at these institutions (I…)."),
        topic_ids: z.array(z.string()).optional().describe("Narrow the name search to these topics (T…)."),
        from_year: z.number().int().min(1000).max(2100).optional(),
        to_year: z.number().int().min(1000).max(2100).optional(),
      },
      annotations: { title: "Find candidate works", ...READ },
    },
    async (args) =>
      run("find_candidate_works", async () => {
        const aid = authorShort(args.author_id);
        if (!aid) return fail(`author_id must be an OpenAlex author ID like A5023888391, got "${args.author_id}".`);
        const limit = args.limit ?? 25;
        const wanted = new Set(args.sources ?? ["name", "orcid", "siblings"]);
        const profile = await fetchAuthor(aid);
        const name = (args.name ?? profile.display_name ?? "").trim();
        const notes: string[] = [];
        const out: Record<string, any> = { author_id: aid, name_searched: name || null };
        const exclude = `authorships.author.id:!${aid}`;
        const extra: string[] = [];
        if (args.institution_ids?.length) extra.push(`authorships.institutions.lineage:${args.institution_ids.map((x) => shortId(x)).filter(Boolean).join("|")}`);
        if (args.topic_ids?.length) extra.push(`topics.id:${args.topic_ids.map((x) => shortId(x)).filter(Boolean).join("|")}`);
        if (args.from_year) extra.push(`from_publication_date:${args.from_year}-01-01`);
        if (args.to_year) extra.push(`to_publication_date:${args.to_year}-12-31`);
        const select = listSelect.join(",");
        const shapeCandidate = (w: any, source: string) => {
          const pick = pickAuthorship(w.authorships ?? [], null, name || null);
          const ta = pick.this_authorship;
          return compact({
            ...shapeWork(w, { maxAuthors: 0 }),
            authors: undefined,
            source,
            this_authorship: ta,
            ambiguous_bylines: pick.ambiguous_bylines,
            coauthors: coauthorNames(w.authorships ?? [], ta?.position ?? null),
          });
        };

        // ---- name ladder ----
        if (wanted.has("name") && name) {
          const tokens = nameTokens(name);
          let last: string | null = null;
          let step1Count = -1;
          let rows: any[] = [];
          let total = 0;
          let rungUsed = 0;
          for (let step = 1; step <= LADDER_STEPS; step++) {
            const v = buildLadderFilterValue(tokens, step);
            if (!v || v === last) continue;
            last = v;
            const data = await client.get<ListResponse>("/works", {
              filter: [`raw_author_name.search:${v}`, "type:!paratext", exclude, ...extra].join(","),
              per_page: 50,
              select,
            });
            total = data.meta.count ?? 0;
            if (step1Count < 0) step1Count = total;
            rows = data.results;
            rungUsed = step;
            if (total >= COUNT_THRESHOLD) break;
          }
          const gated = rows.filter((w) => findMatchedAuthorship(w.authorships ?? [], name) >= 0);
          gated.sort((a, b) => {
            const fa = Math.max(0, ...(a.authorships ?? []).map((x: any) => fullMatchCount(x, tokens)));
            const fb = Math.max(0, ...(b.authorships ?? []).map((x: any) => fullMatchCount(x, tokens)));
            return fb - fa || (b.cited_by_count ?? 0) - (a.cited_by_count ?? 0);
          });
          out.name_matches = compact({
            total_raw_hits: total,
            ladder_rung: rungUsed,
            common_name: step1Count > COMMON_NAME_THRESHOLD ? true : undefined,
            returned: Math.min(gated.length, limit),
            works: gated.slice(0, limit).map((w) => shapeCandidate(w, "name")),
          });
          if (step1Count > COMMON_NAME_THRESHOLD) notes.push(`"${name}" is a very common byline (${step1Count.toLocaleString("en-US")} raw hits); narrow with institution_ids, topic_ids or years, or search alternate names.`);
          if (total > 50) notes.push(`Name search returned ${total} raw hits; only the first 50 were gated and ranked. Narrow the search to see the rest.`);
        }

        // ---- ORCID ----
        if (wanted.has("orcid") && args.orcid) {
          const orcid = normalizeOrcid(args.orcid);
          if (!orcid) {
            notes.push(`"${args.orcid}" is not a valid ORCID; the ORCID source was skipped.`);
          } else {
            const seen = new Set<string>();
            const works: any[] = [];
            for (const f of [`authorships.raw_orcid:${orcid}`, `authorships.author.orcid:${orcid}`]) {
              const data = await client.get<ListResponse>("/works", { filter: [f, exclude].join(","), per_page: limit, select, sort: "cited_by_count:desc" });
              for (const w of data.results) {
                const id = shortId(w.id)!;
                if (seen.has(id)) continue;
                seen.add(id);
                works.push(shapeCandidate(w, f.startsWith("authorships.raw_orcid") ? "orcid_on_work" : "orcid_on_other_profile"));
              }
            }
            let registry: any = null;
            try {
              const rec = await fetchOrcidWorks(orcid);
              const withDoi = rec.filter((r) => r.doi);
              const dois = [...new Set(withDoi.map((r) => r.doi!))];
              const matched: any[] = [];
              const onProfile: string[] = [];
              for (let i = 0; i < dois.length; i += 50) {
                const batch = dois.slice(i, i + 50);
                const data = await client.get<ListResponse>("/works", { filter: `doi:${batch.join("|")}`, per_page: 50, select });
                for (const w of data.results) {
                  const onIt = (w.authorships ?? []).some((a: any) => shortId(a?.author?.id) === aid);
                  if (onIt) { onProfile.push(shortId(w.id)!); continue; }
                  const id = shortId(w.id)!;
                  if (seen.has(id)) continue;
                  seen.add(id);
                  matched.push(shapeCandidate(w, "orcid_record"));
                }
              }
              registry = compact({
                works_on_record: rec.length,
                with_doi: withDoi.length,
                already_on_profile: onProfile.length,
                not_in_openalex: dois.length - onProfile.length - matched.length,
                without_doi_titles: rec.filter((r) => !r.doi && r.title).slice(0, 25).map((r) => compact({ title: r.title, year: r.year })),
              });
              works.push(...matched.slice(0, limit));
              if (rec.length === 0) notes.push(`The public ORCID record ${orcid} lists no works. ORCID records are public by default, so either it is empty or the author set their works to private; ask them to check their ORCID visibility or supply a CV instead.`);
              if (registry.without_doi_titles?.length) notes.push("Some ORCID-record works have no DOI; resolve their titles with resolve_references(author_id=…).");
            } catch (e: any) {
              notes.push(e instanceof OrcidError ? `ORCID registry: ${e.message}` : `ORCID registry lookup failed: ${e?.message ?? e}`);
            }
            out.orcid_matches = compact({ orcid, profile_orcid: stripOrcid(profile.orcid), returned: works.length, orcid_record: registry, works });
          }
        } else if (wanted.has("orcid") && !args.orcid && profile.orcid) {
          notes.push(`The profile already carries ORCID ${stripOrcid(profile.orcid)}; pass it as orcid to search by it.`);
        }

        // ---- sibling profiles ----
        if (wanted.has("siblings") && name) {
          const data = await client.get<ListResponse>("/authors", { filter: `display_name.search:${name.replace(/,/g, " ")}`, per_page: 15, sort: "works_count:desc" });
          const myInst = new Set((profile.affiliations ?? []).map((a: any) => shortId(a?.institution?.id)).filter(Boolean));
          const myTopics = new Set((profile.topics ?? []).map((t: any) => shortId(t?.id)).filter(Boolean));
          const siblings = data.results
            .filter((e) => shortId(e.id) !== aid)
            .map((e) => {
              const inst = (e.affiliations ?? []).map((a: any) => a?.institution).filter(Boolean);
              const sharedInst = inst.filter((i: any) => myInst.has(shortId(i?.id) ?? "")).map((i: any) => i.display_name);
              const sharedTopics = (e.topics ?? []).filter((t: any) => myTopics.has(shortId(t?.id) ?? "")).map((t: any) => t.display_name);
              return compact({
                ...shapeEntity("authors", e, false),
                shared_institutions: sharedInst,
                shared_topics: sharedTopics.slice(0, 5),
                shared_topic_count: sharedTopics.length,
              });
            })
            .slice(0, 10);
          out.sibling_profiles = { returned: siblings.length, profiles: siblings };
          if (siblings.length) notes.push("A sibling with shared institutions or topics may be a duplicate of this person: review its works with search_works(author_ids=[sibling], for_author=<this author>) and add the ones that are theirs; the emptied profile goes inert.");
        }

        out.notes = notes;
        out.how_to_add = "For each work that is the user's, submit_curations add_work with the work id and this_authorship.raw_author_name. Ask the user about works whose topic, coauthors or institution do not fit the profile.";
        return ok(out);
      })()
  );

  // -------------------------------------------------------------------------
  // submit_curations
  // -------------------------------------------------------------------------
  const itemSchema = z.discriminatedUnion("action", [
    z.object({ action: z.literal("add_work"), work_id: z.string().min(2).max(300), raw_author_name: z.string().min(1).max(300).describe("The byline exactly as OpenAlex returns it (this_authorship.raw_author_name).") }),
    z.object({ action: z.literal("remove_work"), work_id: z.string().min(2).max(300) }),
    z.object({ action: z.literal("set_display_name"), value: z.string().min(1).max(300) }),
    z.object({ action: z.literal("set_full_name"), value: z.string().min(1).max(300).describe("Must be one of the author's existing raw bylines; it becomes the matching name for future works.") }),
    z.object({ action: z.literal("set_orcid"), value: z.string().min(9).max(60) }),
    z.object({ action: z.literal("remove_orcid"), value: z.string().min(9).max(60).describe("The ORCID being detached.") }),
    z.object({ action: z.literal("cancel"), curation_id: z.string().min(3).max(60).describe("A pending curation id from list_my_curations.") }),
  ]);

  server.registerTool(
    "submit_curations",
    {
      title: "Submit profile corrections",
      description:
        "Submit corrections to the user's claimed author profile as OpenAlex curations, up to 100 per call: add_work (attach a byline on a work to the profile), remove_work (detach the profile from a work), " +
        "set_display_name, set_full_name (the name used to match future works), set_orcid, remove_orcid, and cancel (withdraw a pending curation). " +
        "Every correction is reversible by the opposite action and each item succeeds or fails on its own. " +
        "Only submit what the user has agreed to: propose removes and adds with the evidence first, ask about anything that does not clearly fit. " +
        "Adds are capped at 1,000 per rolling 24 hours. " + LATENCY_NOTE,
      inputSchema: {
        items: z.array(itemSchema).min(1).max(MAX_ITEMS),
        author_id: z.string().min(2).max(300).optional().describe("The claimed profile (A…). Default: the account's claimed author."),
      },
      annotations: { title: "Submit profile corrections", ...WRITE, idempotentHint: true },
    },
    async ({ items, author_id }) =>
      run("submit_curations", async () => {
        const api = users();
        const me = await api.me();
        const claimed = await claimedAuthor(me);
        if ("error" in claimed) return fail(claimed.error);
        const aid = author_id ? authorShort(author_id) : claimed.aid;
        if (!aid) return fail(`author_id must be an OpenAlex author ID like A5023888391, got "${author_id}".`);
        if (aid !== claimed.aid) return fail(`This account owns ${claimed.aid}, not ${aid}. Curations can only target the claimed profile.`);

        const results: any[] = [];
        const payloads: Array<{ index: number; payload: CurationPayload }> = [];
        // DOIs are accepted for work_id; resolve them to W ids first (free single-record lookups).
        const resolveWork = async (id: string): Promise<string> => {
          const s = shortId(id);
          if (s && /^W\d+$/.test(s)) return s;
          const w = await client.get("/works/" + encodeURIComponent(normalizeWorkId(id)).replace(/%2F/g, "/"), { select: "id" });
          return shortId(w.id)!;
        };
        for (let i = 0; i < items.length; i++) {
          const item = items[i] as CurationItem;
          if (item.action === "cancel") {
            try {
              const r = await api.deleteCuration(item.curation_id);
              results.push({ index: i, action: "cancel", curation_id: item.curation_id, status: "cancelled", deleted: r.deleted });
            } catch (e: any) {
              results.push({ index: i, action: "cancel", curation_id: item.curation_id, status: "error", error: e?.message ?? String(e) });
            }
            continue;
          }
          try {
            const resolved = "work_id" in item ? { ...item, work_id: await resolveWork(item.work_id) } : item;
            payloads.push({ index: i, payload: toPayload(resolved as any, aid) });
          } catch (e: any) {
            const msg = e instanceof OpenAlexError && e.status === 404 ? `No OpenAlex work matches "${(item as any).work_id}".` : e instanceof CurationItemError ? e.message : e?.message ?? String(e);
            results.push({ index: i, action: item.action, work_id: (item as any).work_id, status: "error", error: msg });
          }
        }
        if (payloads.length) {
          const adds = payloads.filter((p) => p.payload.entity === "works" && p.payload.action === "replace").length;
          let batch;
          try {
            batch = await api.createCurations(payloads.map((p) => p.payload));
          } catch (e: any) {
            if (e instanceof UsersApiError && e.status === 429) return fail(`${e.message} (${adds} adds in this batch; the cap is ${ADD_CAP} per rolling 24 hours.)`);
            if (e instanceof UsersApiError && e.status === 403) return fail(`OpenAlex accounts refused the batch: ${e.message}`);
            throw e;
          }
          // A single-object POST returns a bare row; the array form returns {summary, results}.
          const rows: any[] = Array.isArray(batch?.results) ? batch.results : [{ index: 0, status: 201, curation: batch }];
          for (const r of rows) {
            const p = payloads[r.index ?? 0];
            const item = items[p?.index ?? 0] as any;
            const base: any = { index: p?.index, action: item?.action, work_id: item?.work_id ? shortId(item.work_id) : undefined };
            if (r.curation) results.push(compact({ ...base, status: "submitted", curation_id: r.curation.id, describe: shapeCurationRow(r.curation).describe, curation_status: r.curation.status }));
            else if (r.skipped) results.push(compact({ ...base, status: "skipped", reason: r.reason ?? "already in the desired state" }));
            else results.push(compact({ ...base, status: "error", error: r.error ?? `HTTP ${r.status}` }));
          }
        }
        results.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
        const summary = { submitted: 0, skipped: 0, cancelled: 0, errors: 0 } as Record<string, number>;
        for (const r of results) summary[r.status === "submitted" ? "submitted" : r.status === "skipped" ? "skipped" : r.status === "cancelled" ? "cancelled" : "errors"]++;
        return ok({ author_id: aid, summary, results, note: LATENCY_NOTE });
      })()
  );

  // -------------------------------------------------------------------------
  // list_my_curations
  // -------------------------------------------------------------------------
  server.registerTool(
    "list_my_curations",
    {
      title: "List my curations",
      description:
        "The corrections this account has submitted and their status: pending (waiting for the nightly refresh), applied (live), or timed_out (not seen live after a week; rechecked daily). " +
        "Each row carries a plain-language description. Use it to report progress or to find a curation_id to cancel.",
      inputSchema: {
        status: z.array(z.enum(["pending", "applied", "timed_out"])).optional().describe("Only these statuses. Default: all."),
        entity: z.enum(["works", "authors"]).optional().describe("works = add/remove work curations; authors = name and ORCID changes."),
        limit: z.number().int().min(1).max(100).optional().describe("Rows per page. Default 25."),
        page: z.number().int().min(1).max(1000).optional(),
      },
      annotations: { title: "List my curations", ...READ },
    },
    async (args) =>
      run("list_my_curations", async () => {
        const api = users();
        // Site-wide admins see every curation on this route; pin it to the connected user.
        const me = await api.me();
        const data = await api.listCurations({
          user_id: me.id,
          status: args.status?.length ? args.status.join(",") : undefined,
          entity: args.entity,
          per_page: args.limit ?? 25,
          page: args.page ?? 1,
        });
        const rows = data.results.map(shapeCurationRow);
        const counts = { pending: 0, applied: 0, timed_out: 0 } as Record<string, number>;
        for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
        return ok(compact({
          total: data.meta.total_count,
          page: data.meta.page,
          total_pages: data.meta.total_pages,
          on_this_page: counts,
          results: rows,
          note: rows.some((r) => r.status === "pending") ? LATENCY_NOTE : undefined,
        }));
      })()
  );
}
