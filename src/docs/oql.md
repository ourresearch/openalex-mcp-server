# Overview

**OQL, the OpenAlex Query Language, lets you ask OpenAlex for works, people, institutions and journals, and for numbers about them, in something close to plain English.** A query is a short series of steps:

```
get works where title-abstract has ("climate change") and published since 2020;
then, group those works by year;
finally, summarize using count and percent open access
```

You can read that aloud and know what it returns: climate-change papers since 2020, year by year, with how many there are and what share is open access. That's the point: a query you can paste into a paper's methods section, that a reader understands, and that anyone can run again for the same answer. OQL also says things the classic URL syntax never could: deep nesting, OR across different fields, one row per author or institution, comparisons between named things, and calculations.

**Where to run it:**

- **On the website:** switch to the **OQL tab** at the top of the [search page](https://openalex.org). Valid queries run as you type, and splits and calculations show as a table. The easiest way to experiment.
- **On the API:** `https://api.openalex.org/?oql=<your query>`. The query names what it gets (`get works ...`), so it goes to the API **root**, not `/works`. See the [OQL API](/api/oql/).
- **Check before you run:** `https://api.openalex.org/query/oql/<your query>` is free. It says whether the query is valid (and if not, what to change), how long it should take, and what it will cost, and it gives the query back in the form shown on this page.

**OQL shows every query back in one form**, the form on this page, whatever you typed. You can type `year >= 2020` and get back `published since 2020`, or type a bare ID and get back `[MIT](I63966007)`. So you never have to remember the exact wording: write it close enough, and read the echo.

## The shape

```
get <things> where <conditions>
  [; then, <step>]          splits, comparisons, walks
  [; finally, <step>]       the last of two or more steps
```

1. **Start with `get` and what you want back:** `get works where ...`, or `get authors where ...`, `get institutions where ...`, `get sources where ...`. With no conditions, `get works` is a valid query.
2. **Filter fields with `is` and words for numbers and dates; search text with `has`.** `type is [review](review)`, `citation count is at least 100`, `published since 2020`, `title has (cancer)`.
3. **Add steps after a semicolon.** Each later step opens with `then,`; the last of two or more opens with `finally,`. `group those works by year` splits the works into groups; `summarize using ...` computes numbers, and always comes last.
4. **To get one row per author, institution, journal, funder, country or topic, start with that thing:** `get institutions that published works where ...` (see [Start with the thing you want](#start-with-the-thing-you-want)).

That's enough for most questions. Everything below is detail, and every example runs on production today.

## Filtering

A condition is a field, a verb and a value:

| Example | Meaning |
|---|---|
| `get works where institution is [Massachusetts Institute of Technology](I63966007)` | entities are links: the name in brackets, the OpenAlex ID in parentheses |
| `get works where type is [review](review) and language is [French](fr)` | closed vocabularies are links too, by their codes |
| `get works where institution is ([Massachusetts Institute of Technology](I63966007) or [Stanford University](I97018004))` | one of several: join values with `or`, in one pair of parentheses |
| `get works where country is ([United States](US) and [China](CN))` | all of several, for things a work has many of |
| `get works where type is not ([review](review) or [editorial](editorial))` | anything but: negate on the verb |
| `get works where citation count is at least 1000` | numbers in words: `is above`, `is at least`, `is below`, `is at most` (decimals allowed: `FWCI is at least 2.0`) |
| `get works where institution is unknown` | the field is empty |
| `get works where ORCID is 0000-0001-6187-6610` | other schemes' ids have their own fields: `DOI is 10.1038/nature12373`, `ROR ID is 00ghzk478`, `PMID`, `ISSN` |

**For entities the ID is what counts.** The name in brackets is optional and ignored when you type it; the echo fills it in, so queries stay readable. `institution is (I63966007)` and `institution is [MIT](I63966007)` are the same query. One value needs no parentheses around the link; several share one pair.

API column ids also work as field names (`publication_year >= 2020` is the same query as `published since 2020`); the echo uses the OQL names.

### Years and dates

Years and dates read in words:

| Example | Meaning |
|---|---|
| `published in 2023` | that year |
| `published since 2020` | 2020 or later |
| `published before 2000` | 1999 or earlier |
| `published after 2020` | 2021 or later |
| `published from 2015 through 2024` | both years included |
| `published since 2025-01-01`, `published on 2021-06-01` | dates work the same way |
| `added since 2026-10-01`, `updated since 2026-10-01` | when OpenAlex added or last changed the work (added-since needs a paid plan) |

`after` works for a year but not for a date: `published after 2021-06-01` is an error, because it's unclear whether June 1 counts. Write `published since 2021-06-02` (or `since 2021-06-01` to include it). Typing `date > 2021-06-01` comes back as `published since 2021-06-02`.

### Yes/no fields

A yes/no field reads as a sentence about the work:

```
get works where it's open access and it has a DOI and it doesn't have an abstract
get works where country is [Ghana](GH) and it has an abstract and it's not retracted
get works where it's in the top 10% by citations
```

### Collections

A [collection](/how-to/collections/) is a list you saved: names, DOIs, a ranking OpenAlex doesn't hold. Use it like a value:

```
get works where institution is in the collection (col_abc123)
get works where institution is not in the collection (col_abc123)
get works in the collection (col_abc123)
get each author in the collection (col_abc123)
```

The last one returns each author in the list with all their fields. Write the collection's ID in parentheses (or as a link, `[Our peers](col_abc123)`); a bare `col_abc123` is an error.

## Searching

Search a text field with **`has`**. The fields: `title`, `abstract`, `title-abstract` (both at once), `title-abstract-keywords` (title and abstract, plus works tagged with a [keyword](/api/searching/#keywords-in-search) a phrase in your search names; openalex.org's default), `full text` (title, abstract and full text, plus keywords), `raw affiliation`, `byline`.

The parentheses hold a portable search string, with capital `AND`, `OR` and `NOT`, exactly as a systematic review would report it:

```
get works where title-abstract has ((asthma OR wheeze) NOT (child OR pediatric))
```

The one rule to internalize: **bare words are stemmed, quotes mean exact.** `title has (cancer)` also matches *cancers* and *cancerous*: the everyday default, good recall. `title has ("cat")` matches only *cat*, never *cats*.

| Example | Meaning |
|---|---|
| `get works where title has (cancer)` | one stemmed word |
| `get works where title has (machine learning)` | stemmed phrase: one search unit, ranked higher when the words are adjacent |
| `get works where title-abstract has ("climate change")` | **exact** phrase (stemming off) |
| `get works where title has (stemmed "genome editing")` | a phrase kept together that *keeps* stemming |
| `get works where title has (psoriat*)` | wildcard: `*` is any characters, `?` exactly one (`wom?n`); neither may start a word, and `*` needs at least 3 characters before it |
| `get works where title has ("smart" and "phone" within 3 words of each other)` | proximity: terms within N words, any order |
| `get works where title-abstract is similar to ("ocean acidification effects on coral reefs")` | semantic search: by meaning, not keywords |

## Combining and nesting

Join conditions with `and` / `or`, and group them with parentheses. `and` binds tighter than `or`, so `a and b or c` means `(a and b) or c`, but the echo always adds the parentheses so nothing is left to guess:

```
get works where (published before 2000 and title-abstract has ("global warming"))
  or (title-abstract has ("climate change") and published after 2020)
```

This nesting, and OR across *different* fields (`institution is [Massachusetts Institute of Technology](I63966007) or funder is [National Institutes of Health](F4320332161)`), is what the classic URL syntax can't express.

**Exclude on the verb:** `is not`, `is not in`, `doesn't`:

```
get works where country is not ([France](FR) or [Germany](DE))
get works where it's not open access
```

Inside a search, exclude with `NOT`, as in any search string: `title has (cancer NOT mouse)`.

## Citations and sets

Follow the citation edge in either direction; `it` is each work in your results. The three below are works whose reference list includes that paper, the works in its reference list, and OpenAlex's "related works" for it:

```
get works where it cites ([The state of OA: a large-scale analysis of the prevalence and impact of Open Access articles](W2741809807))
get works where it's cited by ([The state of OA: a large-scale analysis of the prevalence and impact of Open Access articles](W2741809807))
get works where it's related to ([The state of OA: a large-scale analysis of the prevalence and impact of Open Access articles](W2741809807))
```

**A set** is a query inside a condition. It names what it holds (`works where ...`, `authors of works where ...`):

```
get works where it cites a work in the set (works where institution is [University of Kansas](I146416000) and published in 2020)
get works where it's cited by a work in the set (works where institution is [University of Kansas](I146416000) and published in 2020)
get works where topic is [CRISPR and Genetic Engineering](T10878) and published in 2024 and it doesn't cite any work in the set (works where institution is [University of Kansas](I146416000))
get works where author is in the set (authors of works where title-abstract has (kelp) and published since 2022) and published since 2025
```

The first finds every work citing one of Kansas's 2020 papers; the second, every work those papers cite; the last, recent work by anyone who wrote about kelp since 2022.

**Co-authorship** is a filter on authors and institutions:

```
get authors where co-author is [Jason R Priem](A5023888391)
get institutions where country is [Germany](DE) and collaborator is not [Massachusetts Institute of Technology](I63966007)
```

## Start with the thing you want

To get one row per author, institution, source (journal), publisher, funder, country or topic, start the query with that thing, then say which works count:

```
get institutions that published works where title-abstract has ("climate change");
then, summarize each institution using count and mean FWCI
```

Each row is one institution; `count` is how many of the matching works it has, and `mean FWCI` is over those works. The verb fits the thing:

| Start | Example |
|---|---|
| authors | `get authors who published works where institution is [Massachusetts Institute of Technology](I63966007) and published in 2024` |
| institutions | `get institutions that published works where ...` |
| sources | `get sources that published works where title-abstract has ("large language model") and published since 2023` |
| publishers | `get publishers that published works where country is [Kenya](KE) and published in 2024` |
| funders | `get funders that funded works where country is [Kenya](KE) and published since 2020` |
| countries | `get countries that published works where topic is [CRISPR and Genetic Engineering](T10878) and published since 2020` |
| topics | `get topics of works where institution is [University of Kansas](I146416000) and published since 2022` |

**Where the authors are.** `at` an institution reads each author's own record (the institutions on their profile, with years), not the papers' affiliations; `in` takes a country or continent:

```
get authors at [University of British Columbia](I141945490) since 2022 who published works where title-abstract has (kelp);
then, summarize each author using count, mean FWCI, and h-index
```

`at [UBC](I141945490) since 2022` means UBC is on their record in 2022 or later; `at [UBC](I141945490) in 2+ years since 2022` means in at least two of those years; `ever at [UBC](I141945490)` means any year. For where they are now, use their last known institution, OpenAlex's best guess from the record: `get authors where last known institution is [University of British Columbia](I141945490) who published works where title-abstract has (kelp)`. With no year, `at` and `in` look at the last five years, and the echo writes the year out: typing `get authors in BR who published ...` comes back as `get authors in [Brazil](BR) since 2022 who published ...`. Institutions take `in` too: `get institutions in [Asia](Q48) that published works where ...`.

**The thing's own fields** go in a `where` before the verb:

```
get authors where h-index is above 20 who published works where title-abstract has (kelp)
get authors where co-author is not [Jason R Priem](A5023888391) who published works where title-abstract has (kelp)
```

**How many of the matching works each has** goes on the verb: `get authors who published more than 5 works where title-abstract has (kelp)` (also `at least`, `fewer than`, `at most`).

**Split each one's works further** with `group each <thing>'s works by`:

```
get institutions in [Asia](Q48) that published works where topic is [Livestock and Poultry Management](T13294) and published since 2016;
then, group each institution's works by year;
finally, summarize using count
```

**Count the things themselves** with `summarize all those <things>`: `get authors who published works where topic is [CRISPR and Genetic Engineering](T10878); then, summarize all those authors using count` gives how many distinct authors wrote on CRISPR.

**Just listing things by their own fields is not a calculation.** For MIT's most-cited authors, start from the authors and stop: `get authors where last known institution is [Massachusetts Institute of Technology](I63966007) and h-index is above 50`.

## Splitting into groups

`group those works by <field>` splits the works you have into groups, one per value of a field that isn't a thing: year, type, language, open access status, institution type, source type, subfield, field, domain, keyword, SDG, license, and the yes/no fields. Everything after it is computed within each group. Split by two or three fields in the same step:

```
get works where country is [Kenya](KE); then, group those works by year
get works where institution is [Massachusetts Institute of Technology](I63966007); then, group those works by year and type
get works where country is [Kenya](KE); then, group those works by open access
```

A yes/no field splits in two (`open access` and `not open access`). For one group per author, institution, journal, funder, country or topic, [start with that thing](#start-with-the-thing-you-want).

**Split a number into bins:**

```
get works where institution is [Massachusetts Institute of Technology](I63966007) and published in 2020;
then, group those works into citation count bins at (1, 10, 100)
```

That gives `0`, `1-9`, `10-99`, `100+`; `into FWCI bins of 0.5` gives equal widths. Decimals (FWCI) always need bins.

**Every grouped result also has a summary row**: the same numbers for the whole starting set, and with two or more splits, for each split's groups on their own (each year across all types, each type across all years). Every summary number is computed from the works, never added up or averaged from the group rows. That's your baseline: start from the widest set you want to compare against (the world since 2016, a country, a field), and read each group's numbers against the summary.

## Comparing named things

`compare` gives one row for each thing you name, side by side:

```
get works where topic is [CRISPR and Genetic Engineering](T10878);
then, compare institution [Massachusetts Institute of Technology](I63966007) versus [Stanford University](I97018004) versus [Harvard University](I136199984) using count and mean FWCI by year
```

**Measure** the comparison with `using`, and **break it down** with `by` after that (up to three splits in all, the comparison counting as one). A comparison comes before any other split and ends the query: no `summarize` step after it. The summary row is the whole starting set (all CRISPR papers, here), so each institution reads against the field.

What you can compare:

| Compare | Example |
|---|---|
| things in one field (write the field once) | `compare institution [Massachusetts Institute of Technology](I63966007) versus [Stanford University](I97018004)` |
| different fields | `compare institution [KU Leuven](I99464096) versus country [Belgium](BE) using count and percent of those works by SDG` |
| searches | `compare title-abstract has "machine learning" versus "edge AI" using count` |
| periods | `compare published from 2016 through 2019 versus published since 2021 using count and percent open access` |
| a yes/no field | `compare open access versus not open access using count and mean FWCI by year` |
| one thing against the rest | `compare country [India](IN) versus country is not [India](IN) using mean FWCI` |
| each member of a collection | `compare each institution in the collection (col_abc123) using count` |

`is` goes unsaid inside a comparison, but `is not` is written out. Inside one item, `and` / `or` are logic. Rows can overlap (a paper by MIT and Stanford counts in both). Up to 100 items; for more, save them as a collection and compare its members. To set yourself against your peers as one row: `compare institution [Massachusetts Institute of Technology](I63966007) versus institution in the collection (col_abc123)`.

## Calculating

`summarize ... using` is always the last step. It names what it summarizes:

```
get works where country is [Kenya](KE) and published since 2015; then, summarize all those works using percent open access
get works where country is [Kenya](KE) and published since 2015; then, group those works by year; finally, summarize using percent open access
get authors who published works where title-abstract has (kelp); then, summarize each author using count and h-index
```

`summarize all those works using` gives one row for the whole set; after a split, `summarize using`; after a things start, `summarize each <thing> using` (one row each) or `summarize all those <things> using` (one row for all of them).

| Calculation | Example |
|---|---|
| `count` | `summarize using count` |
| `mean`, `median`, `sum`, `min`, `max` of a number field (`min`/`max` also of a date) | `mean FWCI`, `median citation count`, `sum APC paid`, `max date` |
| `percent` of a yes/no field | `percent open access`, `percent retracted` |
| `percent of those works` | each row's share of the set it came from |
| the things' own fields, after a things start | `summarize each author using count, h-index, and last known institution` |

A field of the works always needs a calculation: `mean authors count`, never `authors count`.

With splits you get a flat table, one row per group with a column per split (group by year and type: a year column and a type column), plus the summary; without any split, one row.

> Sorting and choosing columns are **not** part of OQL. They're controls in the results view (`?sort=` / `?select=` on the API, where `sort` takes any calculated column, e.g. `sort=mean_fwci:desc`). OQL says *which* works and *which* numbers, not how to display them.

## Walking out to related things

A walk moves from the works you have to the things related to them, and then to everything those things did, not just the works you started with:

```
get works where institution is [University of Kansas](I146416000) and published in 2023;
then, get each author of those works where h-index is above 20;
then, get all that author's works;
finally, summarize each author using count and mean FWCI
```

That's each Kansas 2023 author with an h-index above 20, and their count and mean FWCI over **all** their papers. Compare `get authors who published works where ...`, whose numbers count only the matching works.

- `get each <thing> of those works` gives one result per thing (author, institution, source, publisher, funder, topic, subfield, field, domain, keyword, SDG, country); filter them by their own fields with `where`.
- `get <things> of those works` gives one combined set; `get all those <things>' works` then gives one list of works you can split:

```
get works where topic is [CRISPR and Genetic Engineering](T10878);
then, get institutions of those works;
then, get all those institutions' works where published since 2025;
finally, group those works by type
```

One walk out per query, before any split. After `get each`, summarize directly (no split).

## Sampling

`sample` returns a random subset; add a seed to get the same subset again:

```
get works where published in 2020; then, sample 500 of those works
get works where published in 2020; then, sample 500 of those works with seed 42
```

## Downloading results

A query with a `summarize` step, a comparison, bins, or a things start exports every row, however many there are, the same way a list of works exports every work. On the website, use the download button above the results: the Export dialog shows the price before you start, and you can follow the export in **Settings → Exports**. An export costs the query's price for every 100 rows it writes (1 credit per 100 groups for a filtered set, 10 for a search), and stops if your credits run out.

There's nothing to choose. With no split, the export is the one row for the whole set, as a CSV. With splits, it's one zip of:

- **`groups.csv`**: every group, one row each (with nested splits, one row per innermost group, its outer groups repeated), so every row stands on its own. Columns are named in OQL words: each split (`institution`, plus `institution id` for things with ids), then each calculation (`percent open access`).
- **The summary**: `all-works.csv`, the whole set in one row, and with two or more splits one CSV per split, each split's groups on their own (`by-institution.csv`, `by-year.csv`). Read these rather than summing the groups: a work can sit in more than one group (or in none, when it has no year), so groups don't always add up, and a mean of group means is not the mean.

On the API, the two are separate calls: `format=csv` for the groups, and `format=csv&table=summary` for the summary (one CSV, or a zip of one CSV per table with two or more splits). A single split by a field pages: add `cursor=*` and follow the `X-Next-Cursor` response header (10,000 groups a page) until it's gone. Everything else comes whole in one answer.

```
https://api.openalex.org/?oql=get works where country is [Kenya](KE) and published since 2015; then, group those works by year; finally, summarize using count and percent open access&format=csv
```

## Limits, time and price

Up to three splits (a comparison counts as one); up to 100 items in a list or a comparison; at most 5 AND/OR/NOT in each compared search; a nested split up to 10,000 groups per split (a single split pages through any number); one walk out per query; about ten seconds a query. Anything over a limit is refused before it runs, with the limit and how to fix it.

A query with a `summarize` step, a comparison, bins, or a things start is priced from what it does: the starting set costs what a list (1 credit) or a search (10) costs, each compared search 10, each lookup 1. Nothing else adds to the price: splits by a field, counts, means and percentages are free. Any other query costs what the same query costs as a URL: 1 credit for a list, 10 for a search. The check tells you the price for free, and a response shows what it cost in `meta.cost`. See [Example costs](/access/example-costs/#what-an-oql-calculation-costs).

## OQL never guesses

A query that can't do what it appears to do is always a clear error **with a fix**, never a silent wrong answer:

| You wrote | OQL says |
|---|---|
| `...; then, group those works by FWCI` | FWCI is a decimal: split it into bins, `group those works into FWCI bins at (0.5, 1, 2)` |
| `...; then, summarize all those works using authors count` | name the calculation: `mean authors count` (or median, sum, min, max) |
| `published after 2021-06-01` | ambiguous for a date: write `published since 2021-06-02`, or `since 2021-06-01` to include it |
| `type is (article review)` | two values need a connective: `or` (or `and` if you mean both) |
| four splits | a query splits its works at most three times: drop a split |
| `institution is in the collection col_abc123` | wrap the collection ID: `(col_abc123)` |
| `title contains (cancer)` | `contains` was renamed: use `title has (cancer)` |
| `pub_year is (2020)` | unknown field `pub_year`: check the field name (you want `published in 2020`) |

## Not in the language yet

Splitting each walked thing's works further (walk to the combined set instead); a second walk out in one query; sorting or top N inside the query (results come back sorted by count; ask for all groups and read the top, or sort in the results view). And nothing OpenAlex doesn't hold.

## Going deeper

- **[Cases](https://openalex.org/query/oql/cases)**: a browsable library of worked examples, each with its OQL and the underlying query object.
- **[Specification](/access/oql-spec/)**: the formal, normative spec: every rule and edge case, plus the formal grammar.
- **[OQO](/access/oqo-schema/)**: the machine-readable JSON twin of OQL, built for agents and tools.
- **[OQL API](/api/oql/)**: executing and translating OQL over HTTP.

Tell us what's confusing, what's missing, and what you wish you could ask.
