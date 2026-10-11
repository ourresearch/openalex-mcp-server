/** Debug title lookups (oxjob #1494): for each string, the candidate, the phrase query's count and top titles. */
import { readFileSync } from "node:fs";
import { runOql } from "../../src/chat";
import { sameTitle, titleCandidate } from "../../src/frontDoor";
import { OpenAlexClient } from "../../src/openalex";

const rows = readFileSync(process.argv[2], "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l))
  .filter((r) => r.kind === (process.argv[3] ?? "title")).slice(0, Number(process.argv[4] ?? 25));
const oa = new OpenAlexClient({ apiKey: process.env.OPENALEX_API_KEY ?? "" });
for (const r of rows) {
  const t = titleCandidate(r.text);
  if (!t) { console.log(`- no candidate: ${JSON.stringify(r.text).slice(0, 120)}`); continue; }
  const p = await runOql(oa, `get works where title has ("${t.replace(/"/g, "")}")`);
  const hit = (p.top_rows ?? []).some((x) => sameTitle(t, x.name));
  console.log(`${hit ? "HIT " : "miss"} n=${p.count} ok=${p.ok} ${JSON.stringify(t).slice(0, 110)}`);
  if (!hit) for (const x of (p.top_rows ?? []).slice(0, 2)) console.log(`      ${JSON.stringify(x.name).slice(0, 110)}`);
  if (!p.ok) console.log(`      err ${JSON.stringify(p.errors).slice(0, 200)}`);
}
