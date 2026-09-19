# OpenAlex MCP server

The official [OpenAlex](https://openalex.org) server for the [Model Context Protocol](https://modelcontextprotocol.io). Connect it to Claude (or any MCP client) and ask questions about the scholarly literature: find papers, trace citations, profile authors and institutions, and count research output by topic, year, venue or country.

- **Endpoint:** `https://mcp.openalex.org/mcp` (Streamable HTTP)
- **Docs:** https://help.openalex.org/api/mcp/
- **Support:** support@openalex.org

## Connecting

**Claude (web, desktop, mobile):** Settings → Connectors → *Add custom connector*, paste `https://mcp.openalex.org/mcp`. No login needed.

**Claude Code:**

```bash
claude mcp add --transport http openalex https://mcp.openalex.org/mcp
```

**Any MCP client:** point a Streamable HTTP transport at the endpoint above.

### Using your own OpenAlex API key (optional)

By default the server queries OpenAlex on its own key, with a shared daily budget. If you want your own budget (free keys get $1/day; [plans](https://openalex.org/pricing) get more) send your key as a bearer token and the server will use it instead:

```
Authorization: Bearer YOUR_OPENALEX_API_KEY
```

Get a free key at https://openalex.org/settings/api. Claude's custom-connector settings support request headers for this.

## Tools

All tools are read-only.

| Tool | What it does |
|------|--------------|
| `search_works` | Find papers by keyword (Boolean syntax) or by meaning (`mode: "semantic"`), with filters for year, type, open access, citations, and author/institution/source/topic IDs. |
| `get_work` | Full record for one work by OpenAlex ID, DOI, PMID or PMCID: all authors and affiliations, abstract, topics, funding, citations by year. Free. |
| `list_citations` | Works that cite a paper, or the works it references. |
| `search_entities` | Resolve a name to an OpenAlex ID: authors, institutions, sources (journals), topics, funders, publishers. |
| `get_entity` | Full profile for an author, institution, source, topic, funder or publisher. Free. |
| `group_works` | Count works by author, institution, country, source, year, topic, type, OA status, and more. |

Responses are shaped for language models: abstracts are rebuilt from OpenAlex's inverted index and truncated in lists, author lists are collapsed to the first five, and every response stays under Claude's tool-result size limit.

## Example prompts

- What are the most-cited papers on CRISPR off-target effects since 2020, and who are the top authors?
- Find recent open-access review articles on transformer models for protein structure prediction.
- Which institutions publish the most on perovskite solar cells, and how has output grown since 2015?
- Who cites this paper: 10.1038/s41586-021-03819-2? Summarize the follow-up work.
- Give me Jennifer Doudna's publication profile and her main collaborating institutions.

## Development

```bash
npm install
cp .dev.vars.example .dev.vars   # add an OpenAlex API key
npm run dev                      # http://localhost:8788/mcp
npm test                         # unit tests
MCP_URL=http://localhost:8788/mcp npm run smoke   # live end-to-end test of every tool
```

Deploy (Cloudflare Workers):

```bash
npx wrangler secret put OPENALEX_API_KEY           # staging
npm run deploy                                     # staging: *.workers.dev
npx wrangler secret put OPENALEX_API_KEY --env production
npm run deploy:production                          # https://mcp.openalex.org
```

The server is stateless: each request builds a fresh MCP server bound to the resolved API key, so it scales horizontally with no session store. Per-tool metrics go to a Cloudflare Analytics Engine dataset (`openalex_mcp_requests`).

## Privacy

The server forwards tool arguments to the OpenAlex API and returns the results. It stores no conversation content. Per-call metrics (tool name, latency, credits used, success/failure) are recorded without query text. See the [OpenAlex privacy policy](https://openalex.org/privacy).

## License

MIT. OpenAlex data is [CC0](https://creativecommons.org/publicdomain/zero/1.0/).
