# Overview

**OQL, the OpenAlex Query Language, lets you ask OpenAlex for works, and for numbers about them, in something close to plain English.** A query is a short series of steps:

```
get works where title-abstract has ("climate change") and year >= (2020);
then group those works by year;
then calculate count, percent open access
```

You can read that aloud and know what it returns: climate-change papers since 2020, year by year, with how many there are and what share is open access. That's the point: a query you can paste into a paper's methods section, that a reader understands, and that anyone can run again for the same answer. OQL also says things the classic URL syntax never could: deep nesting, OR across different fields, comparisons between sets, and calculations.

**Where to run it:**

- **On the website:** switch to the **OQL tab** at the top of the [search page](https://openalex.org). Valid queries run as you type, and splits and calculations show as a table. The easiest way to experiment.
- **On the API:** `https://api.openalex.org/?oql=<your query>`. The query names what it gets (`get works ...`), so it goes to the API **root**, not `/works`. See the [OQL API](/api/oql/).
- **Check before you run:** `https://api.openalex.org/query/oql/<your query>` is free. It says whether the query is valid (and if not, what to change), how long it should take, and what it will cost.

Queries written the older way (`works where ... group by year`) still work, and come back in the form above.

## The shape

```
get <things> where <conditions>
  [; then group those <things> by <split> [where <group filter>]]   up to three splits
  [; then calculate <calculation>, <calculation>]                    always last
```

1. **Start with `get <things> where <conditions>`.** The things are what you get back: `works`, `authors`, `institutions`, `sources`, `funders`, `topics`, … With no conditions, `get works` is a valid query.
2. **Filter fields with `is` and comparisons; search text with `has`. The value always sits in parentheses.** `year is (2020)`, `citation count >= (100)`, `title has (cancer)`.
3. **Add steps with `; then`.** `group those works by <field>` splits the works into groups; `calculate ...` computes numbers, and is always the last step.
4. **Combine conditions with `and` / `or`; group them with parentheses.**

That's enough for most questions. Everything below is detail, and every example runs on production today.

## Filtering

A condition is `<field> <operator> (<value>)`:

| Example | Meaning |
|---|---|
| `get works where year is (2020)` | exact match |
| `get works where type is (article or review)` | one of several: join values with `or` |
| `get works where type is not (review)` | anything but: negate on the verb |
| `get works where citation count >= (100)` | numeric comparison (decimals allowed: `FWCI >= (2.0)`) |
| `get works where year >= (2019) and year <= (2023)` | a range is two endpoint conditions |
| `get works where institution is (I136199984 [Harvard University])` | entities use their OpenAlex ID |
| `get works where language is (en)` · `get works where SDG is (3)` | closed vocabularies use codes, not names |
| `get works where institution is in (col_abc123)` | a saved [collection](/how-to/collections/); `is not in (...)` excludes it |

API column ids also work as field names (`publication_year >= (2020)` is the same query as `year >= (2020)`); the form shown back to you uses the OQL names.

For entities (institutions, authors, funders, sources, topics, …) the ID is what counts. The `[name]` in square brackets is optional, ignored on input, and filled in when the query is shown back to you, so queries stay readable:

```
get works where institution is (I136199984) or funder is (F4320332161 [National Institutes of Health])
```

## Searching

Search a text field with **`has`**. The fields: `title`, `abstract`, `title-abstract` (both at once), `title-abstract-keywords` (title and abstract, plus works tagged with a [keyword](/api/searching/#keywords-in-search) a phrase in your search names; openalex.org's default), `full text` (title, abstract and full text, plus keywords), `raw affiliation`, `byline`. (Until October 2026 `title-abstract` and `title-abstract-keywords` were spelled `title/abstract` and `title/abstract/keywords`; those spellings still work and come back with hyphens.)

The parentheses hold a portable search string, with capital `AND`, `OR` and `NOT`, exactly as a systematic review would report it:

```
get works where title-abstract has ((asthma OR wheeze) NOT (child OR pediatric))
```

The one rule to internalize: **bare words are stemmed, quotes mean exact.** `title has (cancer)` also matches *cancers* and *cancerous*: the everyday default, good recall. `title has ("cat")` matches only *cat*, never *cats*.

| Example | Meaning |
|---|---|
| `get works where title has (cancer)` | one stemmed word |
| `get works where title has (machine learning)` | stemmed phrase: one search unit, ranked higher when the words are adjacent |
| `get works where title has ("climate change")` | **exact** phrase (stemming off) |
| `get works where title has (stemmed "genome editing")` | the bridge: a phrase kept together that *keeps* stemming |
| `get works where title has ("psoriat*")` | wildcard, **must be quoted**; `*` is any characters, `?` exactly one (`"wom?n"`); neither may start a word, and `*` needs at least 3 characters before it |
| `get works where title has (within 3 ("smart", "phone"))` | proximity: terms within N words, any order |
| `get works where title-abstract is similar to ("ocean acidification effects on coral reefs")` | semantic search: by meaning, not keywords |

## Combining and nesting

Join conditions with `and` / `or`, and group with parentheses. `and` binds tighter than `or`, so `a and b or c` means `(a and b) or c`, but the form shown back to you always adds the parentheses so nothing is left to guess:

```
get works where (year < (2000) and title-abstract has ("global warming"))
  or (title-abstract has ("climate change") and year > (2020))
```

This nesting, and OR across *different* fields (`institution is … or funder is …`), is what the classic URL syntax can't express.

## Negation

**Exclude on the verb:** `is not`, `is not in`.

```
get works where type is not (review)
get works where country is not (FR or DE)
get works where institution is not in (col_abc123)
```

Inside a search, exclude with `NOT`, as in any search string: `title has (cancer NOT mouse)`, `abstract has (NOT pediatric)`. A `not` written before a value (`country is (not FR)`) still works, and comes back in the form above.

## Yes/no fields

Yes/no fields read as `is (true)` / `is (false)`:

```
get works where open access is (true)
get works where has DOI is (true)
get works where retracted is (false)
```

## Citation links

Follow the citation edge in either direction; the subject `it` is each work in your results. Takes `or` in the value like any other filter:

```
get works where it cites (W2741809807)                 works whose reference list includes W…
get works where it's cited by (W2741809807)            works in W…'s reference list
get works where it's related to (W2741809807)          OpenAlex "related works"
get works where title has (climate) and it cites (W1767272795 or W2741809807)
```

## Sampling

`sample` returns a random subset; add a seed to get the same subset again:

```
get works where year is (2020); then sample (500) of those works
get works where year is (2020); then sample (500) of those works with seed (42)
```

## Splitting into groups

`group those works by <field>` splits the works you have into groups; everything after it is computed within each group. Split again with `group those works again by`, up to three splits:

```
get works where year >= (2020); then group those works by topic
get works where institution is (I63966007); then group those works by year; then group those works again by type
```

Besides a field, you can split by:

| Split | Example | Groups |
|---|---|---|
| **listed values** | `group those works by institution in (I63966007, I97018004, I136199984)` | one per value, in that order, empty ones included (up to 100) |
| **searches** | `group those works by title-abstract search in (("edge AI"), ("neuromorphic computing"))` | one per search (up to 100, at most 5 AND/OR/NOT each) |
| **conditions**, to compare sets or periods | `group those works into ((institution is (I99464096)), (country is (BE)))` · `into ((year <= (2019)), (year >= (2021)))` | one per condition, in order |
| **bins** of a number | `group those works into citation count bins at (1, 10, 100)` | `0`, `1-9`, `10-99`, `100+`; `bins of (10)` gives equal widths. Decimals (FWCI) always need bins |

A yes/no field splits in two: `open access` and `not open access`.

**Every result also has a summary**: the same numbers for the whole starting set, and with two or more splits, for each split's groups on their own (each year across all open access statuses, each status across all years). Every summary number is computed from the works, never added up or averaged from the group rows. That's your baseline: start from the widest set you want to compare against (the world since 2016, a country), and read each group's numbers against the summary.

**Filter the groups** by adding `where` to the split. A calculation tests each group's works; any other field belongs to the group itself:

```
get works where title-abstract has (kelp);
then group those works by author where count of those works > (10) and h-index > (20)

get works where topic is (T10878);
then group those works by institution where collaborator is not (I63966007)
```

Filtering on a group's own fields (h-index, last known institution) looks the groups up, so put a count filter first; without one, a big set can take too long, and the check will say so.

## Calculating

`calculate` is always the last step:

```
get works where country is (KE) and year >= (2015);
then group those works by year;
then calculate count, percent open access
```

| Calculation | Example |
|---|---|
| `count` | `calculate count` |
| `mean`, `median`, `sum`, `min`, `max` of a number field (`min`/`max` also of a date) | `mean FWCI`, `median citation count`, `sum APC paid`, `max date` |
| `percent` of a yes/no field | `percent open access`, `percent retracted` |
| `percent of those works` | each group's share of the set it came from |
| after a split by authors, institutions or sources, their own fields | `get works where source is (S137773608); then group those works by author; then calculate count, h-index` |

With splits you get a flat table, one row per group with a column per split (group by year, then by open access status: a year column and a status column), plus the summary; without any split, one row.

> Sorting and choosing columns are **not** part of OQL. They're controls in the results view (`?sort=` / `?select=` on the API, where `sort` takes any calculated column, e.g. `sort=mean_fwci:desc`). OQL says *which* works and *which* numbers, not how to display them.

## Downloading results

A query with a `calculate` step, a split by a list, bins or conditions, or a filter on its groups exports every group, however many there are, the same way a list of works exports every work. On the website, use the download button above the results: the Export dialog shows the price before you start, and you can follow the export in **Settings → Exports**. An export costs the query's price for every 100 rows it writes (1 credit per 100 groups for a filtered set, 10 for a search), and stops if your credits run out.

There's nothing to choose. With no split, the export is the one row for the whole set, as a CSV. With splits, it's one zip of:

- **`groups.csv`**: every group, one row each (with nested splits, one row per innermost group, its outer groups repeated), so every row stands on its own. Columns are named in OQL words: each split (`institution`, plus `institution id` for things with ids), then each calculation (`percent open access`).
- **The summary**: `all-works.csv`, the whole set in one row, and with two or more splits one CSV per split, each split's groups on their own (`by-institution.csv`, `by-year.csv`). Read these rather than summing the groups: a work can sit in more than one group (or in none, when it has no year), so groups don't always add up, and a mean of group means is not the mean.

On the API, the two are separate calls: `format=csv` for the groups, and `format=csv&table=summary` for the summary (one CSV, or a zip of one CSV per table with two or more splits). A single split by a field pages: add `cursor=*` and follow the `X-Next-Cursor` response header (10,000 groups a page) until it's gone. Everything else comes whole in one answer.

```
https://api.openalex.org/?oql=get works where country is (KE) and year >= (2015); then group those works by year; then calculate count, percent open access&format=csv
```

## Limits, time and price

Up to three splits; up to 100 items in a list; at most 5 AND/OR/NOT in each listed search; a nested split up to 10,000 groups per split (a single split pages through any number); about ten seconds a query. Anything over a limit is refused before it runs, with the limit and how to fix it.

A query with a `calculate` step, a split by a list, bins or conditions, or a filter on its groups is priced from what it does: the starting set costs what a list (1 credit) or a search (10) costs, each listed search 10, each lookup 1. Nothing else adds to the price: splits by a field, counts, means and percentages are free. Any other query costs what the same query costs as a URL: 1 credit for a list, 10 for a search, grouped or not. The check tells you the price for free, and a response shows what it cost in `meta.cost`. See [Example costs](/access/example-costs/#what-an-oql-calculation-costs).

## OQL never guesses

A query that can't do what it appears to do is always a clear error **with a fix**, never a silent wrong answer:

| You wrote | OQL says |
|---|---|
| `... then group those works by FWCI` | FWCI is a decimal: split it into bins, `group those works into FWCI bins at (0.5, 1, 2)` |
| `... then calculate authors count` | name the calculation: `calculate mean authors count` |
| `... then group those authors by year` (after `get works`) | this query holds works: `group those works by year` |
| `title has (bar*)` | wildcards need quotes: `title has ("bar*")` |
| `type is (article review)` | two values need a connective: `type is (article or review)` |
| a fourth split | a query splits its works at most three times: drop a split |
| `title contains (cancer)` | `contains` was renamed: use `title has (cancer)` |
| `pub_year is (2020)` | unknown field `pub_year`: check the field name (you want `year`) |

## Going deeper

- **[Cases](https://openalex.org/query/oql/cases)**: a browsable library of worked examples, each with its OQL and the underlying query object.
- **[Specification](/access/oql-spec/)**: the formal, normative spec: every rule and edge case, plus the formal grammar.
- **[OQO](/access/oqo-schema/)**: the machine-readable JSON twin of OQL, built for agents and tools.
- **[OQL API](/api/oql/)**: executing and translating OQL over HTTP.

Tell us what's confusing, what's missing, and what you wish you could ask.
