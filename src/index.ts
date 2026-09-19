/**
 * Cloudflare Worker entry: serves the OpenAlex MCP server over Streamable HTTP at /mcp.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server";
import { OpenAlexClient } from "./openalex";

export interface Env {
  ENVIRONMENT: string;
  OPENALEX_API_BASE: string;
  OPENALEX_API_KEY?: string;
  ANALYTICS?: AnalyticsEngineDataset;
}

const DOCS_URL = "https://help.openalex.org/api/mcp/";

const app = new Hono<{ Bindings: Env }>();

app.use(
  "/mcp/*",
  cors({
    origin: "*",
    allowHeaders: ["Content-Type", "Authorization", "Accept", "Mcp-Session-Id", "Mcp-Protocol-Version", "Last-Event-ID"],
    exposeHeaders: ["Mcp-Session-Id", "Mcp-Protocol-Version"],
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
  })
);
app.use("/mcp", cors({ origin: "*", allowHeaders: ["Content-Type", "Authorization", "Accept", "Mcp-Session-Id", "Mcp-Protocol-Version", "Last-Event-ID"], exposeHeaders: ["Mcp-Session-Id"], allowMethods: ["GET", "POST", "DELETE", "OPTIONS"] }));

app.get("/", (c) =>
  c.json({
    name: SERVER_NAME,
    version: SERVER_VERSION,
    description: "Official OpenAlex MCP server. Connect an MCP client (e.g. Claude) to the /mcp endpoint.",
    mcp_endpoint: new URL("/mcp", c.req.url).toString(),
    transport: "streamable-http",
    docs: DOCS_URL,
    source: "https://github.com/ourresearch/openalex-mcp-server",
    support: "support@openalex.org",
  })
);

app.get("/health", async (c) => {
  return c.json({ ok: true, env: c.env.ENVIRONMENT, has_server_key: Boolean(c.env.OPENALEX_API_KEY) });
});

/** Resolve which OpenAlex key to use: a client-supplied bearer key wins, else the server's own. */
function resolveKey(req: Request, env: Env): { apiKey: string; byok: boolean } | null {
  const auth = req.headers.get("authorization") ?? "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const supplied = m?.[1]?.trim();
  if (supplied) return { apiKey: supplied, byok: true };
  const xkey = req.headers.get("x-api-key")?.trim();
  if (xkey) return { apiKey: xkey, byok: true };
  if (env.OPENALEX_API_KEY) return { apiKey: env.OPENALEX_API_KEY, byok: false };
  return null;
}

async function handleMcp(c: any) {
  const env = c.env as Env;
  const key = resolveKey(c.req.raw, env);
  if (!key) {
    return c.json(
      { error: "This server has no OpenAlex API key configured. Send one as `Authorization: Bearer <key>` (get a free key at https://openalex.org/settings/api)." },
      503
    );
  }
  const client = new OpenAlexClient({ apiKey: key.apiKey, byok: key.byok, baseUrl: env.OPENALEX_API_BASE });
  const server = createServer({
    client,
    onToolCall: (info) => {
      try {
        env.ANALYTICS?.writeDataPoint({
          indexes: [info.tool],
          blobs: [info.tool, info.ok ? "ok" : "error", key.byok ? "byok" : "server-key", env.ENVIRONMENT],
          doubles: [info.ms, info.credits, info.status ?? 0],
        });
      } catch {
        /* metrics are best-effort */
      }
    },
  });
  // Stateless: no session IDs, every request is independent. Plain JSON responses keep
  // things simple for clients that don't need streaming.
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    return await transport.handleRequest(c.req.raw);
  } finally {
    c.executionCtx?.waitUntil?.(transport.close().then(() => server.close()).catch(() => {}));
  }
}

app.all("/mcp", handleMcp);
app.all("/mcp/*", handleMcp);

app.notFound((c) => c.json({ error: "Not found. The MCP endpoint is /mcp.", docs: DOCS_URL }, 404));

export default app;
