/**
 * Scores the deterministic front door's detectors (src/frontDoor.ts) against labelled search-box strings (oxjob #1494):
 * which strings run as a Boolean search, which get a confirmed title lookup (live API), by label.
 *   node dist/detect.mjs <strings.jsonl> [--show]    rows: {id, text, kind}; OPENALEX_API_KEY in the environment
 * --show prints the misses (raw strings: desk console only).
 */
import { runOql } from "../../src/chat";
import { booleanSearch, frontDoor } from "../../src/frontDoor";
import { OpenAlexClient } from "../../src/openalex";
import { pool, readJsonl } from "./util";

const rows = readJsonl(process.argv[2]);
const show = process.argv.includes("--show");
const oa = new OpenAlexClient({ apiKey: process.env.OPENALEX_API_KEY ?? "" });

async function main() {
  const out = await pool(rows, 6, async (r: any) => {
    const d = await frontDoor(r.text, (q) => runOql(oa, q));
    // the same decision handle() makes; "title-miss" / "boolean-fails" = tried, then left to the model
    const path = d.path === "search_string" ? "boolean" : d.path === "title" ? "title"
      : d.tried.includes("search_string") ? "boolean-fails" : d.tried.includes("title") ? "title-miss" : "model";
    return { ...r, path, oql: d.path === "model" ? booleanSearch(r.text)?.oql : d.oql, note: d.path === "model" ? null : d.note,
      checked: d.path === "model" ? null : `count ${d.preview.count}` };
  });
  const kinds = [...new Set(out.map((r) => r.kind))];
  const paths = ["boolean", "boolean-fails", "title", "title-miss", "model"];
  console.log(["kind", "n", ...paths].join("\t"));
  for (const k of kinds) {
    const rs = out.filter((r) => r.kind === k);
    console.log([k, rs.length, ...paths.map((p) => rs.filter((r) => r.path === p).length)].join("\t"));
  }
  if (process.argv.includes("--fired")) {   // every answer made without a model, to read one by one
    for (const r of out.filter((r) => r.path === "title" || r.path === "boolean")) console.log(`[${r.kind} -> ${r.path}] ${JSON.stringify(r.text).slice(0, 220)}\n   -> ${r.oql} | ${r.checked}`);
  }
  if (show) {
    const miss = (r: any) => (r.kind === "boolean" && r.path !== "boolean") || (r.kind !== "boolean" && r.path.startsWith("boolean"))
      || (r.kind === "title" && r.path !== "title") || (r.kind !== "title" && r.path === "title");
    for (const r of out.filter(miss)) console.log(`\n[${r.kind} -> ${r.path}] ${JSON.stringify(r.text).slice(0, 300)}\n   ${r.oql ?? ""} ${r.checked ?? ""}`);
    console.log("\n--- Boolean conversions (first 15)");
    for (const r of out.filter((r) => r.path === "boolean").slice(0, 15)) console.log(`${JSON.stringify(r.text).slice(0, 200)}\n   -> ${r.oql.slice(0, 260)} | ${r.checked} | ${r.note}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
