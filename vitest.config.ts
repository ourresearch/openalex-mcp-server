import { defineConfig } from "vitest/config";

// The Worker bundles the docs as text (wrangler.jsonc `rules`: **/*.md as Text). Do the same in tests,
// so a test can import server.ts and drive the tools through an MCP client (oxjob #1509).
export default defineConfig({
  plugins: [
    {
      name: "markdown-as-text",
      transform(code, id) {
        if (id.endsWith(".md")) return { code: `export default ${JSON.stringify(code)};`, map: null };
      },
    },
  ],
});
