/**
 * How often an arm's answers search with words the person never typed (oxjob #1494), by the same check the Worker
 * runs (src/searchWords.ts). Bundle like run.ts, then:
 *   node dist/wordcheck.mjs <rows.jsonl> <runs.jsonl> [<runs.jsonl> ...]
 * Prints per runs file: answers, answers with a text search, share of those with new words, the commonest new words.
 */
import { readFileSync } from "node:fs";
import { newWords, searchStrings } from "../../src/searchWords";

const readJsonl = (p: string) => readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const [rowsPath, ...runPaths] = process.argv.slice(2);
const input = new Map(readJsonl(rowsPath).map((r: any) => [r.id, r.input ?? r.text]));
for (const p of runPaths) {
  const last = new Map<string, any>();
  for (const r of readJsonl(p)) last.set(`${r.id}|${r.arm}`, r);
  const byArm = new Map<string, any[]>();
  for (const r of last.values()) byArm.set(r.arm, [...(byArm.get(r.arm) ?? []), r]);
  for (const [arm, runs] of byArm) {
    const answered = runs.filter((r) => r.oql && input.has(r.id));
    const searched = answered.filter((r) => searchStrings(r.oql).length);
    const added = searched.map((r) => ({ id: r.id, words: newWords(r.oql, [input.get(r.id)]) })).filter((x) => x.words.length);
    const counts = new Map<string, number>();
    for (const a of added) for (const w of a.words) counts.set(w, (counts.get(w) ?? 0) + 1);
    const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([w, n]) => `${w} ${n}`).join(", ");
    const pct = searched.length ? ((100 * added.length) / searched.length).toFixed(1) : "-";
    console.log(`${p.split("/").pop()} [${arm}]: ${answered.length} answers, ${searched.length} with a text search, ${added.length} with new words (${pct}%). Top: ${top}`);
  }
}
