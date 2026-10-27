/**
 * resolve_references accuracy check (oxjob #1328). Runs the real tool on fixed reference sets and counts
 * right / wrong / missed against each reference's known work.
 *
 * In process (this checkout's code, production API):
 *   SMOKE_USER_API_KEY=<key> npx tsx --import ./scripts/md-loader.mjs scripts/refcheck/run.ts [set ...]
 * Live server (real OAuth, like smoke.ts):
 *   MCP_URL=https://mcp.openalex.org/mcp SMOKE_USER_API_KEY=<key> npx tsx scripts/refcheck/run.ts [set ...]
 * Sets: famous crossref heldout dois50 refs20 (default: all). OUT=<dir> writes one JSONL of answers per set.
 *
 * right   = a match (exact/likely/uncertain) on the reference's own work (or, for a fabricated one, match none)
 * wrong   = a match on any other work
 * missed  = match none for a real work
 */
import { readFileSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { oauthLogin } from "../oauth-login";

type Item = { ref: string; accept_ids?: string[]; accept_title?: string; expect?: "none" };
const dir = new URL(".", import.meta.url).pathname;
const load = (f: string) => JSON.parse(readFileSync(dir + f, "utf8"));
const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

// Crossref reference strings whose DOI's work holds a title the string contains.
const withTitle = (f: string) => load(f).filter((r: any) => r.has_title).map((r: any) => ({ ref: r.ref, accept_ids: [r.truth_id] }));
const SETS: Record<string, () => Item[]> = {
  famous: () => load("famous.json"),
  crossref: () => withTitle("crossref.json"),
  heldout: () => withTitle("heldout.json"),
  dois50: () => load("dois50.json").map(([id, doi]: string[]) => ({ ref: doi, accept_ids: [id] })),
  refs20: () => [
    ...load("refs20.json").map(([id, ref]: string[]) => ({ ref, accept_ids: [id] })),
    { ref: "Smith, J. (2021). Quantum entanglement of kelp forests and municipal bond yields: a randomized trial. Journal of Imaginary Results, 12(3), 45-67.", expect: "none" as const },
  ],
};

// In process, count the API calls the tool makes (the cost per reference).
let apiCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (u: any, init?: any) => { if (String(u).includes("api.openalex.org")) apiCalls++; return realFetch(u, init); }) as typeof fetch;

const key = process.env.SMOKE_USER_API_KEY;
if (!key) { console.error("SMOKE_USER_API_KEY is required"); process.exit(2); }
const url = process.env.MCP_URL;
const client = new Client({ name: "refcheck", version: "0.0.0" });
if (!url) {
  const { createServer } = await import("../../src/server");
  const { OpenAlexClient } = await import("../../src/openalex");
  const { UsersApiClient } = await import("../../src/users");
  const server = createServer({
    client: new OpenAlexClient({ apiKey: key }),
    users: new UsersApiClient({ apiKey: key, baseUrl: "https://user.openalex.org" }),
    features: { findExperts: false, keywordSearch: true, alertTools: false },
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  console.log("in process");
} else {
  const login = await oauthLogin({ mcpUrl: url, usersApiBase: process.env.USERS_API_BASE ?? "https://user.openalex.org", userApiKey: key });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${login.accessToken}` } } }));
  console.log("live", url);
}

async function resolve(refs: string[]): Promise<any[]> {
  for (let attempt = 0; ; attempt++) {
    const res: any = await client.callTool({ name: "resolve_references", arguments: { references: refs } });
    const text = res.content?.[0]?.text ?? "";
    try { return JSON.parse(text).results; } catch {
      if (attempt >= 2) throw new Error("bad tool result: " + text.slice(0, 300));
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SETS);
for (const name of wanted) {
  const items = SETS[name]();
  const rows: any[] = [];
  const t0 = Date.now();
  const calls0 = apiCalls;
  for (let i = 0; i < items.length; i += 25) {
    const batch = items.slice(i, i + 25);
    const results = await resolve(batch.map((b) => b.ref));
    batch.forEach((it, j) => {
      const r = results[j];
      const id = r.match === "none" ? null : r.work?.id ?? null;
      let verdict: "right" | "wrong" | "missed";
      if (it.expect === "none") verdict = r.match === "none" ? "right" : "wrong";
      else if (r.match === "none") verdict = "missed";
      // A book's records may add an edition note: "Statistical Power Analysis for the Behavioral Sciences (2nd ed.)".
      else if (it.accept_title) verdict = (norm(r.work?.title ?? "") + " ").startsWith(norm(it.accept_title) + " ") ? "right" : "wrong";
      else verdict = it.accept_ids!.includes(id) ? "right" : "wrong";
      rows.push({ ref: it.ref, accept: it.accept_ids ?? it.accept_title ?? "none", match: r.match, id, title: r.work?.title ?? null, verdict });
    });
  }
  const n = rows.length;
  const c = (v: string) => rows.filter((r) => r.verdict === v).length;
  const wrongExact = rows.filter((r) => r.verdict === "wrong" && r.match === "exact").length;
  const pct = (x: number) => ((100 * x) / n).toFixed(1) + "%";
  console.log(`${name.padEnd(8)} n=${n}  right ${c("right")} (${pct(c("right"))})  wrong ${c("wrong")} (${pct(c("wrong"))}, ${wrongExact} labelled exact)  missed ${c("missed")} (${pct(c("missed"))})  ${((Date.now() - t0) / 1000).toFixed(0)} s${url ? "" : `  ${((apiCalls - calls0) / n).toFixed(2)} API calls/ref`}`);
  if (process.env.OUT) writeFileSync(`${process.env.OUT}/${name}.jsonl`, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}
await client.close();
