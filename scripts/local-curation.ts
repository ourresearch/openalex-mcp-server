/**
 * In-process exercise of the profile-curation tools on a real user's key (no OAuth, no Worker).
 * Usage: OPENALEX_API_KEY=<personal key> npx tsx scripts/local-curation.ts [--write]
 * Read-only by default; --write also submits a no-op curation (skipped server-side) and a bad cancel.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server";
import { OpenAlexClient } from "../src/openalex";
import { UsersApiClient } from "../src/users";

const key = process.env.OPENALEX_API_KEY;
if (!key) throw new Error("OPENALEX_API_KEY required");
const write = process.argv.includes("--write");
const usersBase = process.env.USERS_API_BASE ?? "https://user.openalex.org";

const server = createServer({
  client: new OpenAlexClient({ apiKey: key, keyLabel: "your personal OpenAlex key" }),
  users: new UsersApiClient({ apiKey: key, baseUrl: usersBase }),
  account: { userId: "local", keyKind: "personal", usersApiReady: true, clientName: "local-curation" },
});
const [ct, st] = InMemoryTransport.createLinkedPair();
await server.connect(st);
const client = new Client({ name: "local", version: "0" });
await client.connect(ct);

const call = async (name: string, args: Record<string, any>) => {
  const t0 = Date.now();
  const r: any = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? "";
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  console.log(`\n=== ${name} ${JSON.stringify(args)} (${Date.now() - t0} ms, ${text.length} chars)${r.isError ? " ERROR" : ""}`);
  return parsed;
};
const show = (o: any, n = 1400) => console.log(JSON.stringify(o, null, 1).slice(0, n));

const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));

const me = await call("get_my_account", {});
show(me);
const aid: string = me.claimed_author?.id ?? "A5023888391";

const audit = await call("search_works", { author_ids: [aid], for_author: aid, limit: 5, include_abstracts: false, sort: "publication_date" });
show({ profile: audit.profile, total: audit.total_results, first: audit.results?.[0] });

const refs = await call("resolve_references", { author_id: aid, references: ["10.7717/peerj.4375", "Priem J, Taraborelli D, Groth P, Neylon C (2010) Altmetrics: a manifesto", "10.1038/s41586-021-03819-2"] });
show(refs.results?.map((r: any) => ({ input: r.input.slice(0, 40), match: r.match, on_profile: r.on_profile, byline: r.authorship_match?.raw_author_name, tier: r.authorship_match?.match })));

const cand = await call("find_candidate_works", { author_id: aid, orcid: "0000-0001-6187-6610", limit: 5 });
show({
  name: cand.name_searched,
  name_matches: { ...cand.name_matches, works: cand.name_matches?.works?.slice(0, 2) },
  orcid: { ...cand.orcid_matches, works: cand.orcid_matches?.works?.slice(0, 2) },
  siblings: cand.sibling_profiles?.profiles?.slice(0, 3),
  notes: cand.notes,
}, 3500);

const mine = await call("list_my_curations", { limit: 5 });
show(mine, 900);

if (write) {
  const sub = await call("submit_curations", { items: [
    { action: "set_display_name", value: me.claimed_author?.name ?? "Jason Priem" },
    { action: "cancel", curation_id: "cur-doesnotexist" },
    { action: "add_work", work_id: "10.7717/peerj.4375", raw_author_name: "x" },
  ] });
  show(sub);
}
await client.close();
