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

### Signing in

The server is an OAuth 2.1 provider. When you add it to Claude (or any MCP client that supports OAuth), you are sent to openalex.org to log in and approve the connection; from then on every query runs on **your** OpenAlex API key and budget (free keys get $1/day; [plans and prepaid usage](https://openalex.org/pricing) get more). If you own an OpenAlex organization, the connector uses the organization's key instead, and the consent screen says so. There is no shared key and no way to query without signing in.

When the budget is running low, tool results carry a one-line note saying how much is left and when it resets. Rotating your API key at openalex.org/settings/api disconnects existing connections; Claude will ask you to sign in again.

## Tools

All tools are read-only.

| Tool | What it does |
|------|--------------|
| `search_works` | Find papers by keyword (Boolean syntax) or by meaning (`mode: "semantic"`), with filters for year, type, open access, citations, and author/institution/source/topic/funder IDs. For complex selections pass an [OQL](https://help.openalex.org/access/oql/) query directly (nested groups, exclusions, exact phrases, proximity). `preview: true` returns just the count, the canonical OQL and a sample for tuning a query. Every response echoes the canonical OQL and a link that reproduces it. |
| `get_work` | Full record for one work by OpenAlex ID, DOI, PMID or PMCID: all authors and affiliations, abstract, topics, funding, citations by year. Free. |
| `resolve_references` | Check up to 25 citations (DOIs, PMIDs, or free-text references) in one call; reports whether each exists and how confidently it matched. Catches fabricated or garbled references and fills in DOIs. |
| `list_citations` | Works that cite a paper, the works it references, or related works. |
| `search_entities` | Find authors, institutions, sources (journals), topics, funders and publishers by name and/or filters: researchers at an institution working on a topic, open-access journals in a field under a given APC, companies in a country. |
| `get_entity` | Full profile for an author, institution, source, topic, funder or publisher. Free. |
| `group_works` | Count works by author, institution, institution type, country, source, publisher, funder, year, type, topic, subfield, field, domain, keyword, OA status, top-10%/top-1% cited, language or SDG. |
| `analyze_works` | One-call profile of any set of works (an institution's output, a funder's portfolio, a topic): totals, open-access share, top-cited share, trend by year, top fields, topics, institutions, countries, sources, funders and authors, and international and industry collaboration shares. |

Every works query, structured or OQL, comes back with the canonical OQL that ran and a URL that reruns it, so a search can be shared, cited in a methods section, or continued by hand in the OQL tab on openalex.org.

Responses are shaped for language models: abstracts are rebuilt from OpenAlex's inverted index and truncated in lists, author lists are collapsed to the first five, and every response stays under Claude's tool-result size limit.

## Example prompts

- What are the most-cited papers on CRISPR off-target effects since 2020, and who are the top authors?
- Summarize the University of Toronto's 2024 research output: volume, open-access share, share in the top 10% most cited, strongest fields, and top collaborating countries.
- Who at Simon Fraser University works on scientometrics? Top five by output with h-index.
- Check whether these references are real and give me DOIs: [paste a bibliography].
- Which open-access journals in ecology charge no APC and have an h-index above 50?
- Who cites this paper: 10.1038/s41586-021-03819-2? Summarize the follow-up work.
- Build a systematic search for studies of vaping among adolescents since 2018, show me the count and a sample, and give me the OQL.

## Development

```bash
npm install
cp .dev.vars.example .dev.vars   # shared secret + local users-api / MCP URL
npm run dev                      # http://localhost:8788/mcp
npm test                         # unit tests
MCP_URL=http://localhost:8788/mcp USERS_API_BASE=http://localhost:8000 SMOKE_USER_API_KEY=<a user key> npm run smoke   # real OAuth flow + every tool
```

Deploy (Cloudflare Workers):

```bash
npx wrangler secret put OAUTH_EXCHANGE_SECRET       # staging (same value as the users-api Heroku config var)
npm run deploy                                     # staging: *.workers.dev
npx wrangler secret put OAUTH_EXCHANGE_SECRET --env production
npm run deploy:production                          # https://mcp.openalex.org
```

The server is stateless: each request builds a fresh MCP server bound to the API key in the caller's OAuth grant, so it scales horizontally with no session store. OAuth state (clients, grants, tokens) lives in Workers KV via [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider); grant props (the API key) are encrypted at rest. Identity comes from openalex-users-api: the consent page on openalex.org obtains a short-lived signed code, which the Worker exchanges server-to-server (shared secret) for the user's key. Both DCR and CIMD client registration are supported. Per-tool metrics go to a Cloudflare Analytics Engine dataset (`openalex_mcp_requests`).

## Privacy

The server forwards tool arguments to the OpenAlex API and returns the results. It stores no conversation content. Per-call metrics (tool name, latency, credits used, success/failure) are recorded without query text. See the [OpenAlex privacy policy](https://openalex.org/privacy).

## License

MIT. OpenAlex data is [CC0](https://creativecommons.org/publicdomain/zero/1.0/).
