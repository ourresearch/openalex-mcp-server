#!/usr/bin/env node
/**
 * Pull the canonical OpenAlex docs the server ships to clients.
 * The help site serves every page as markdown; these copies are bundled into the Worker
 * so the server never carries hand-written documentation.
 *   node scripts/sync-docs.mjs          # refresh src/docs/
 *   node scripts/sync-docs.mjs --check  # exit 1 if the bundled copies differ from the live pages
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

const DOCS = {
  oql: "https://help.openalex.org/access/oql.md",
  oql_spec: "https://help.openalex.org/access/oql-spec.md",
  api_quick_reference: "https://help.openalex.org/api/llm-quick-reference.md",
  fixing_authors: "https://help.openalex.org/access/fixing-errors/authors.md",
  author_curation: "https://help.openalex.org/api/author-curation.md",
};

const check = process.argv.includes("--check");
const manifestPath = "src/docs/manifest.json";
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {};
let drift = 0;

const stripFrontmatter = (md) => md.replace(/^---\n[\s\S]*?\n---\n/, "").replace(/<!--[\s\S]*?-->\n*/g, "").replace(/\n{3,}/g, "\n\n").trim() + "\n";

for (const [key, url] of Object.entries(DOCS)) {
  const res = await fetch(url, { headers: { "User-Agent": "openalex-mcp-server sync-docs" } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const body = stripFrontmatter(await res.text());
  const sha = createHash("sha256").update(body).digest("hex").slice(0, 16);
  const file = `src/docs/${key}.md`;
  const current = existsSync(file) ? readFileSync(file, "utf8") : null;
  if (current === body) {
    console.log(`  = ${key} unchanged (${body.length} bytes)`);
    continue;
  }
  drift++;
  if (check) {
    console.log(`  ! ${key} differs from ${url}`);
    continue;
  }
  writeFileSync(file, body);
  manifest[key] = { url: url.replace(/\.md$/, "/"), sha, fetched_at: new Date().toISOString().slice(0, 10), bytes: body.length };
  console.log(`  + ${key} updated (${body.length} bytes)`);
}
if (!check) writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
if (check && drift) {
  console.error(`${drift} bundled doc(s) are stale; run: npm run sync-docs`);
  process.exit(1);
}
