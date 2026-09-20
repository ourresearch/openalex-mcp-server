# LLM Quick Reference

> **Note:**
> This page is optimized for LLM agents and AI applications. For human-readable guides, see the [API reference](/api/) and [Quickstart](/quickstart/).

> **Field & vocabulary semantics live in Data.** What each entity field *means*, and controlled-vocabulary definitions, are canonical under `/data/` — e.g. the [work attribute dictionary](/data/works/attributes/) and [work types](/data/work-types/). The API reference pages cover endpoint mechanics (filtering, sorting, grouping, syntax).

## Base URL and Authentication

```
Base: https://api.openalex.org
Auth: API key free + strongly recommended (10x the no-key budget); openalex.org/settings/api
      Send as ?api_key=KEY or header: Authorization: Bearer KEY
Rate: $1/day free usage with key, $0.10/day without; 429 on over-budget or >100 req/sec
Corpus: default = curated core (~324M works). corpus=all adds the ~193M-work
        expansion corpus (formerly "XPAC"); corpus=expansion selects it alone; each
        work has an is_xpac boolean. (Legacy include_xpac=true = corpus=all; deprecated —
        never combine it with corpus=.)
```

## Entity Endpoints

```
/works          - Hundreds of millions of scholarly documents (articles, books, datasets)
/authors        - Researcher profiles with disambiguated identities
/sources        - Journals, repositories, conferences
/institutions   - Universities, research organizations
/topics         - Subject classifications (4-level hierarchy: domain > field > subfield > topic)
/publishers     - Publishing organizations
/funders        - Funding agencies
/locations      - Every harvested copy of a work, one row per copy (ids like doi:10.7717/peerj.4375, case-sensitive)
```

## Special Endpoints

```
content.openalex.org/works/{id}.pdf - Download PDFs ($0.01 each)
/text                               - DEPRECATED, do not use
```

## Critical: Two-Step ID Lookup

> **Warning:**
> **Never filter by entity names directly.** Names are ambiguous. Always resolve to IDs first.

```bash
# WRONG - will fail or return wrong results
/works?filter=author_name:Einstein

# CORRECT - two steps
# 1. Get ID
/authors?search=Einstein
# Response: id = "A5012345678"

# 2. Filter by ID
/works?filter=authorships.author.id:A5012345678
```

This applies to: authors, institutions, sources, topics, publishers, funders.

## Query Parameters

```
api_key=        - Free, strongly recommended (get at openalex.org/settings/api)
filter=         - Filter results (see syntax below)
search=         - Full-text search across title/abstract/fulltext
sort=           - Sort results (e.g., cited_by_count:desc)
per_page=       - Results per page (default: 25, max: 100)
page=           - Page number for pagination
sample=         - Random results (e.g., sample=50)
seed=           - Seed for reproducible sampling
select=         - Limit returned fields (e.g., select=id,title)
group_by=       - Aggregate results by a field
corpus=         - core (default) | expansion | all — which works corpus to query (/works only; legacy include_xpac=true = corpus=all, deprecated)
```

> **Note:**
> OpenAlex uses **snake_case** for all parameters: `per_page`, `group_by`, `api_key`.

## Filter Syntax

```bash
# Single filter
?filter=publication_year:2024

# Multiple filters (AND)
?filter=publication_year:2024,is_oa:true

# Multiple values (OR) - up to 100 values
?filter=type:article|book|dataset

# Negation
?filter=type:!paratext

# Comparison
?filter=cited_by_count:>100
?filter=publication_year:<2020
?filter=publication_year:2020-2024
```

## Common Filter Fields

### Works
```
authorships.author.id         - Author's OpenAlex ID
authorships.institutions.id   - Institution's OpenAlex ID
primary_location.source.id    - Journal/source ID
topics.id                     - Topic ID
publication_year              - Year (integer)
cited_by_count                - Citations (integer)
is_oa                         - Open access (boolean)
type                          - article, book, dataset, etc.
has_fulltext                  - Has searchable fulltext (boolean)
```

### Authors
```
last_known_institutions.id    - Current institution
works_count                   - Number of works
cited_by_count                - Total citations
```

## Common Patterns

### Get works by author
```bash
# Step 1: Find author
/authors?search=Heather+Piwowar
# Step 2: Get works
/works?filter=authorships.author.id:A5023888391
```

### Get works from institution
```bash
# Step 1: Find institution
/institutions?search=MIT
# Step 2: Get works
/works?filter=authorships.institutions.id:I63966007
```

### Bulk DOI lookup (up to 100)
```bash
/works?filter=doi:10.1234/a|10.1234/b|10.1234/c&per_page=100
```

### Random sample
```bash
/works?sample=100&seed=42
```

### Aggregate by field
```bash
/works?filter=publication_year:2024&group_by=topics.id
```

## Pricing

| Endpoint | Cost |
|----------|------|
| Singleton (`/works/W123`) | Free |
| List (`/works?filter=...`) | $0.0001 |
| Search (`?search=`) | $0.001 |
| Content download (PDF) | $0.01 |

## Query Limits

| Limit | Value |
|-------|-------|
| OR values per filter | 100 |
| `per_page` max | 100 |
| `sample` max | 10,000 |
| Basic paging limit | 10,000 results |

## Error Handling

```python
def fetch_with_retry(url, max_retries=5):
    for attempt in range(max_retries):
        response = requests.get(url, timeout=30)
        if response.status_code == 200:
            return response.json()
        if response.status_code in [429, 500]:
            time.sleep(2 ** attempt)  # Exponential backoff
            continue
        response.raise_for_status()
    raise Exception("Max retries exceeded")
```

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Filter by name | Resolve to ID first |
| Default page size | Use `per_page=100` |
| Sequential ID lookups | Batch with `\|` operator |
| No error handling | Implement exponential backoff |
| Fetching all fields | Use `select=` for needed fields |
| Surprised by result counts | Default excludes the expansion corpus; add `corpus=all` to include it |

## Deprecated Features

See [Deprecations](/api/deprecations/) for full list. Key items:

- **Concepts** → Use Topics instead
- **`/text` endpoint** → Do not use
- **`host_venue`** → Use `primary_location`
- **`grants`** → Use `funders` and `awards`

## Links

- Full docs: https://help.openalex.org (machine index: https://help.openalex.org/llms.txt)
- API key: https://openalex.org/settings/api
- Help & support: https://help.openalex.org/how-to/support/
