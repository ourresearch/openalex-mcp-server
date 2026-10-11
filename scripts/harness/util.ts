/** Shared bits of the query writer's harness scripts (oxjob #1494). */
import { existsSync, readFileSync } from "node:fs";

export { pool } from "../../src/pool";

/** Rows of a JSONL file; [] when the file doesn't exist yet. */
export const readJsonl = (p: string): any[] =>
  existsSync(p) ? readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)) : [];

/** The Anthropic key, under either name desk uses. */
export const anthropicKey = () => process.env.ANTHROPIC_API_KEY ?? process.env.CLAUDE_API_KEY;
