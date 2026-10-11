/**
 * Router check (oxjob #1494): routes each row with src/router.ts and reports help-desk recall and data precision by
 * source.   node dist/routeeval.mjs <router_eval.jsonl> <out.jsonl> <model> [tune|test|all] [workers]
 * Rows: {id, text, expect: help_desk|data, src, half}. A rerun skips ids already in <out> for that model.
 */
import Anthropic from "@anthropic-ai/sdk";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { routeQuestion } from "../../src/router";

const [rowsPath, outPath, model, half = "tune", workers = "16"] = process.argv.slice(2);
const readJsonl = (p: string) => (existsSync(p) ? readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)) : []);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? process.env.CLAUDE_API_KEY, maxRetries: 6 });

async function main() {
  const rows = readJsonl(rowsPath).filter((r: any) => half === "all" || r.half === half);
  const done = new Set(readJsonl(outPath).filter((r: any) => r.model === model && !r.error).map((r: any) => r.id));
  const todo = rows.filter((r: any) => !done.has(r.id));
  console.log(`${rows.length} rows (${half}); ${todo.length} to route with ${model}`);
  let next = 0;
  async function worker() {
    while (next < todo.length) {
      const r = todo[next++];
      const t0 = Date.now();
      const [m, effort] = model.split("@");   // e.g. claude-opus-5-5@low
      const res = await routeQuestion(anthropic as any, r.text, null, m, effort ?? "high");
      appendFileSync(outPath, JSON.stringify({ id: r.id, src: r.src, half: r.half, expect: r.expect, model, route: res.route,
        cost_usd: res.costUsd, ms: Date.now() - t0, error: res.error ?? null }) + "\n");
    }
  }
  await Promise.all(Array.from({ length: Number(workers) }, worker));
  const last = new Map<string, any>();
  for (const r of readJsonl(outPath).filter((r: any) => r.model === model && (half === "all" || r.half === half))) last.set(r.id, r);
  const all = [...last.values()];
  const bySrc = new Map<string, any[]>();
  for (const r of all) bySrc.set(r.src, [...(bySrc.get(r.src) ?? []), r]);
  for (const [src, rs] of bySrc) {
    const right = rs.filter((r) => r.route === r.expect).length;
    console.log(`${model} ${half} ${src}: ${right}/${rs.length} routed as expected (${((100 * right) / rs.length).toFixed(1)}%), errors ${rs.filter((r) => r.error).length}`);
  }
  const cost = all.reduce((s, r) => s + r.cost_usd, 0);
  const ms = all.map((r) => r.ms).sort((a, b) => a - b);
  console.log(`${model} ${half}: $${(cost / all.length).toFixed(5)} a question, median ${ms[Math.floor(ms.length / 2)]} ms`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
