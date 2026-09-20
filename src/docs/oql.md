# Overview

**OQL is the OpenAlex Query Language — a readable way to ask OpenAlex anything.** Where the classic API uses URL filter strings, OQL lets you write the query out in something close to plain English:

```
works where title has ("climate change") and year >= (2020) and open access is (true)
```

You can read that aloud and roughly know what it does — that's the whole point. OQL can also express queries the old URL syntax never could (deep nesting, OR across different fields, mixed exact-and-stemmed search), while compiling down to the same engine the website and classic URLs already use.

**Where to run it:**

- **On the website:** switch to the **OQL tab** at the top of the [search page](https://openalex.org) — valid queries run as you type, and you can flip between the point-and-click builder and the OQL text. The easiest way to experiment.
- **On the API:** `https://api.openalex.org/?oql=<your query>`. The query carries its own entity (`works where …`), so it goes to the API **root**, not `/works`.

## The shape

```
<entity> where <filters> [ group by <dims> ] [ sample <n> ]
```

1. **A query is `<entity> where <filters>`.** The entity is what you get back — `works`, `authors`, `institutions`, `sources`, `funders`, `topics`, … With no filters, the bare entity is a valid query: `works`.
2. **Filter fields with `is` / `>=`; search text with `has` — the value always sits in parentheses.** `year is (2020)`, `citation count >= (100)`, `title has (cancer)`.
3. **Combine with `and` / `or`; group with parentheses.** `title has (cancer) and year >= (2020)`.

That's enough to write most queries. Everything below is detail — and every example runs on production today.

## Filtering

| Example | Meaning |
|---|---|
| `works where year is (2020)` | exact match |
| `works where type is (article or review)` | one of several — join values with `or` |
| `works where citation count >= (100)` | numeric comparison (floats allowed: `FWCI >= (2.0)`) |
| `works where year >= (2019) and year <= (2023)` | a range = two endpoint filters |
| `works where institution is (I136199984 [Harvard University])` | entities use their OpenAlex ID |
| `works where language is (en)` · `works where SDG is (3)` | closed vocabularies use codes/ids, not names |

API column ids also work as field names (`publication_year >= (2020)` is the same query as `year >= (2020)`); the canonical form shown back to you uses the OQL names.

For entity filters, the ID is what counts — the `[name]` in square brackets is optional, ignored on input, and auto-filled when the query is shown back to you, so queries stay readable:

```
works where institution is (I136199984) or funder is (F4320332161 [National Institutes of Health])
```

## Searching

Search a text field with **`has`**. The fields: `title`, `abstract`, `title/abstract` (both at once), `full text`, `raw affiliation`, `byline`.

The one rule to internalize: **bare words are stemmed, quotes mean exact.** `title has (cancer)` also matches *cancers* and *cancerous* — the everyday default, good recall. `title has ("cat")` matches only *cat*, never *cats*.

| Example | Meaning |
|---|---|
| `works where title has (cancer)` | one stemmed word |
| `works where title has (machine learning)` | stemmed phrase — one search unit, ranked higher when the words are adjacent |
| `works where title has ("climate change")` | **exact** phrase (stemming off) |
| `works where title has (stemmed "genome editing")` | the bridge: exact-adjacent phrase that *keeps* stemming |
| `works where title has ("psoriat*")` | wildcard — **must be quoted**; `*` = any chars, `?` = exactly one (`"wom?n"`); neither may start a word, and `*` needs at least 3 characters before it |
| `works where title has (within 3 ("smart", "phone"))` | proximity — terms within N words, any order |
| `works where title/abstract is similar to ("ocean acidification effects on coral reefs")` | semantic search — by meaning, not keywords |

## Boolean logic

Join filters with `and` / `or`, and group with parentheses. `and` binds tighter than `or`, so `a and b or c` means `(a and b) or c` — but the canonical form always adds the parentheses back so nothing is left to guess:

```
works where title/abstract has ((vape or vaping) and (health or harm))

works where (year < (2000) and title/abstract has ("global warming"))
  or (title/abstract has ("climate change") and year > (2020))
```

This nesting — and OR across *different* fields (`institution is … or funder is …`) — is what the classic URL syntax can't express.

## Negation

There's just one way to negate: `not` inside the parentheses, directly before the value to exclude. To exclude a whole group, write `(not (a or b))`.

```
works where country is (not FR)
works where title has (covid) and abstract has (not pediatric)
works where title has (not mouse and cancer)
```

## Boolean flags

Boolean flags read as `is (true)` / `is (false)`:

```
works where open access is (true)
works where has DOI is (true)
works where retracted is (true)
```

## Citation links

Follow the citation edge in either direction — the subject `it` is each work in your results. Takes `not` and `or` in the value like any other filter:

```
works where it cites (W2741809807)                 works whose reference list includes W…
works where it's cited by (W2741809807)            works in W…'s reference list
works where it's related to (W2741809807)          OpenAlex "related works"
works where title has (climate) and it cites (W1767272795 or W2741809807)
```

## Grouping and sampling

`group by` aggregates results into buckets; `sample` returns a random subset:

```
works where year >= (2020) group by topic
works where year >= (2020) group by topic, year
works where year is (2020) sample 500
```

> Sorting and choosing columns are **not** part of OQL — they're controls in the results view (`?sort=` / `?select=` on the API). OQL says *which* works you want, not how to display them.

## Error reporting

OQL never guesses. A query that can't do what it appears to do is always a clear error **with a fix-it** — never a silent wrong answer:

| You wrote | OQL says |
|---|---|
| `title contains (cancer)` | `contains` was renamed → use `title has (cancer)` |
| `title has (bar*)` | wildcards need quotes → `title has ("bar*")` |
| `type is (article review)` | two values need a connective → `type is (article or review)` |
| `pub_year is (2020)` | unknown field `pub_year` — check the field name (you want `year`) |

## Going deeper

- **[Cases](https://openalex.org/query/oql/cases)** — a browsable library of worked examples, each with its OQL and the underlying query object.
- **[Specification](/access/oql-spec/)** — the formal, normative spec: every rule and edge case, plus the formal grammar.
- **[OQO](/access/oqo-schema/)** — the machine-readable JSON twin of OQL, built for agents and tools.
- **[OQL API](/api/oql/)** — executing and translating OQL over HTTP.

OQL is in active development and we'd love your feedback — tell us what's confusing, what's missing, and what you wish you could express.
