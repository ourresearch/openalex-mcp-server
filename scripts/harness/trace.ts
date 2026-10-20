/**
 * Trace one question through the agent (oxjob #1494): every model turn's text and tool calls, and every tool result,
 * to see why an answer took the turns it did. Bundle like run.ts, then:
 *   node dist/trace.mjs "<question>" [--effort high] [--current "<oql>"]
 */
import Anthropic from "@anthropic-ai/sdk";
import { runChat } from "../../src/chat";
import { OpenAlexClient } from "../../src/openalex";
import { anthropicKey, arg, openalexKey } from "./util";


async function main() {
  const q = process.argv[2];
  const t0 = Date.now();
  const openalex = new OpenAlexClient({ apiKey: openalexKey()! });
  const anthropic = new Anthropic({ apiKey: anthropicKey() });
  await runChat({ anthropic, openalex, effort: arg("--effort") }, {
    messages: [{ role: "user", content: q }], currentQuery: arg("--current") ?? null,
  }, (e) => {
    const s = ((Date.now() - t0) / 1000).toFixed(1);
    if (e.type === "done") {
      for (const m of e.messages) {
        const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content as any[]);
        for (const b of blocks) {
          if (b.type === "text") console.log(`[${m.role} text] ${b.text.slice(0, 600)}`);
          else if (b.type === "tool_use") console.log(`[tool_use ${b.name}] ${JSON.stringify(b.input).slice(0, 400)}`);
          else if (b.type === "tool_result") console.log(`[tool_result] ${String(b.content).slice(0, 700)}`);
          else if (b.type === "thinking") console.log(`[thinking] ${String(b.thinking ?? "").slice(0, 300)}`);
        }
      }
      console.log(`done ${s}s turns ${e.turns} $${e.cost_usd.toFixed(4)}`);
    } else if (e.type !== "answer") console.log(`${s}s ${e.type} ${JSON.stringify(e).slice(0, 200)}`);
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
