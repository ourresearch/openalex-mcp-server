/**
 * Harness runner for the query writer (oxjob #1494): sends each question row through the Worker's own handle(), so
 * a measured arm is exactly the code that ships. Rows come out in the shape of #1494's agent.py, so its score.py
 * judges them unchanged.
 *
 * Build (the guide is a .md import, so bundle it as text), then run with node:
 *   npx esbuild scripts/harness/run.ts --bundle --platform=node --format=esm --loader:.md=text \
 *     --outfile=dist/harness.mjs --banner:js="import{createRequire}from'module';const require=createRequire(import.meta.url);"
 *   ANTHROPIC_API_KEY=... OPENALEX_API_KEY=... [TYPESAFE_API_KEY=...] node dist/harness.mjs \
 *     --rows rows.jsonl --out runs.jsonl --arm base [--workers 8] [--limit N] [--version <git sha>]
 * Row in: {id, input, institution?: {id, name}, current_query?, history?: [{text, oql}]}. Row out: {id, arm, oql, sort, note, check, count,
 * preview, turns, seconds, cost_usd, error, status, route, answer, link, left_out, confidence, version, response}.
 * A rerun skips (id, arm) pairs already written, except transient failures (HTTP 5xx from the model).
 */
import { appendFileSync } from "node:fs";
import { runOql } from "../../src/chat";
import { frontDoor } from "../../src/frontDoor";
import { OpenAlexClient } from "../../src/openalex";
import { handle } from "../../src/queryText";
import { anthropicKey, pool, readJsonl } from "./util";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const ROWS = arg("--rows")!;
const OUT = arg("--out")!;
const ARM = arg("--arm", "base")!;
const WORKERS = Number(arg("--workers", "8"));
const LIMIT = Number(arg("--limit", "0"));
const VERSION = arg("--version", "unknown")!;
// --front-door-only: answer only the rows the deterministic pass takes (no model call at all); skip the rest
const FRONT_DOOR_ONLY = process.argv.includes("--front-door-only");

const env = {
  ENVIRONMENT: "harness",
  OPENALEX_API_BASE: process.env.OPENALEX_API_BASE ?? "https://api.openalex.org",
  ANTHROPIC_API_KEY: anthropicKey(),
  TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
  // an arm's effort: --effort high (else the env's CHAT_EFFORT, else the Worker's default)
  CHAT_EFFORT: arg("--effort", process.env.CHAT_EFFORT),
  CHAT_MODEL: arg("--model", process.env.CHAT_MODEL),
  FOLLOWUP_MODEL: arg("--followup-model", process.env.FOLLOWUP_MODEL),
  FOLLOWUP_EFFORT: arg("--followup-effort", process.env.FOLLOWUP_EFFORT),
};
const KEY = process.env.OPENALEX_API_KEY ?? process.env.OPENALEX_ORG_API_KEY;

async function one(r: any): Promise<any> {
  const t0 = Date.now();
  const body: any = { text: r.input };
  if (r.institution) body.institution = r.institution;
  if (r.current_query) body.current_query = r.current_query;
  if (r.history) body.history = r.history;
  const req = new Request("https://api.openalex.org/query/text", {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let status = 0;
  let d: any = {};
  let credits = 0;
  try {
    const res = await handle(req, env as any);
    status = res.status;
    credits = Number(res.headers.get("X-Credits-Cost") ?? 0);
    d = await res.json();
  } catch (e: any) {
    d = { error: `harness: ${e?.message ?? e}` };
  }
  const p = d.preview ?? {};
  const preview: any = {};
  for (const k of ["groups_count", "top_groups", "summary_all", "top_rows", "errors", "measures"]) if (p[k] != null) preview[k] = p[k];
  return {
    id: r.id, arm: ARM, model: d.meta?.model ?? null, effort: d.meta?.effort ?? null,
    oql: d.oql ?? null, sort: d.sort ?? null, note: d.note ?? null,
    check: status === 200 && d.oql ? "ok" : status === 200 && d.answer ? "help" : "no_submit",
    count: d.count ?? null, preview: d.oql ? preview : null,
    turns: d.meta?.turns ?? null, seconds: Math.round((Date.now() - t0) / 100) / 10,
    cost_usd: d.meta?.cost?.usd ?? credits / 10000, credits,
    error: status === 200 ? null : (d.error ?? `HTTP ${status}`),
    status, route: d.route ?? null, path: d.meta?.path ?? null, answer: d.answer ?? null, link: d.link ?? null,
    left_out: d.left_out ?? null, out_of_reach: d.out_of_reach ?? null, howto: d.howto ?? null,
    confidence: d.confidence ?? null, version: VERSION, meta: d.meta ?? null,
  };
}

async function main() {
  if (!ROWS || !OUT || !KEY || !env.ANTHROPIC_API_KEY) throw new Error("need --rows, --out, OPENALEX_API_KEY and ANTHROPIC_API_KEY");
  let rows = readJsonl(ROWS);
  if (LIMIT) rows = rows.slice(0, LIMIT);
  // done = any answer, or a failure a retry won't change; a model failure (502) or harness crash is retried
  const done = new Set(readJsonl(OUT).filter((x) => x.arm === ARM && x.status && x.status !== 502).map((x) => x.id));
  const todo = rows.filter((r) => !done.has(r.id));
  console.log(`${rows.length} rows; ${todo.length} to run; arm ${ARM}; version ${VERSION}`);
  let k = 0;
  const oa = new OpenAlexClient({ apiKey: KEY! });
  await pool(todo, WORKERS, async (r) => {
    if (FRONT_DOOR_ONLY && (await frontDoor(r.input, (q) => runOql(oa, q))).path === "model") return;
    const row = await one(r);
    appendFileSync(OUT, JSON.stringify(row) + "\n");
    k++;
    if (k % 20 === 0 || k === todo.length) {
      console.log(`  ${k}/${todo.length} last ${row.id} ${row.check} ${row.path ?? ""} $${Number(row.cost_usd ?? 0).toFixed(4)} ${row.seconds}s`);
    }
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
