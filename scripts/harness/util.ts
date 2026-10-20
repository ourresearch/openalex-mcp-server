/** Shared bits of the query writer's harness scripts (oxjob #1494). */
import { existsSync, readFileSync } from "node:fs";

export { pool } from "../../src/pool";

/** Rows of a JSONL file; [] when the file doesn't exist yet. */
export const readJsonl = (p: string): any[] =>
  existsSync(p) ? readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)) : [];

/** The Anthropic key, under either name desk uses. */
export const anthropicKey = () => process.env.ANTHROPIC_API_KEY ?? process.env.CLAUDE_API_KEY;
export const openalexKey = () => process.env.OPENALEX_API_KEY ?? process.env.OPENALEX_ORG_API_KEY;

/** A command-line value: `--name value`, else the fallback. */
export function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
