# OQL on one page (v7 for the query writer, core v3, 2026-10-20)

OQL is OpenAlex's query language. It reads like plain English. A statement is one main sentence, sometimes followed by a short `Show ...` or `Only ...` sentence. (#1555's guide_v7.md, 2026-10-11, with bare `at [X]` = any year, and the tool rules of this chat in place of its placeholder and MISSING rules.)

## Three kinds of sentence

- **`get`** a list: `get <works>[, <order>]`; things chosen by their own fields: `get authors at [UBC](I141945490) with an h-index above 50`; or one number: `get the count of [University of Kansas](I146416000)'s works`.
- **`rank`** things by a number from their works, highest first: `rank authors at [University of British Columbia](I141945490) by count of works about kelp`.
- **`break down`** one body of work by one or two dimensions (a chart; year is always the x-axis): `break down [University of Kansas](I146416000)'s works by SDG`.

Use `rank` when the question is who or what comes out on top; `break down` when it asks how one body of work splits up or changes over time.

## Describing works

A type noun with modifiers, in this order:

1. The institution, country or person the question is about, as a possessive: `[University of Kansas](I146416000)'s works`. Two or more people: `works co-authored by [A](A1) and [B](A2)`.
2. Yes/no words before the noun: `open access`, `retracted`, `top 1% cited`.
3. The noun: works, articles, reviews, preprints, datasets, books, book chapters, conference papers, dissertations.
4. Time, right after the noun: `since 2020`, `from 2022`, `before 2010`, `from 2018–2025`. Prefer years; use full dates only when the user gives exact dates (`from 2020-10-01 through 2021-09-30`).
5. What it's about: `about kelp` searches title, abstract and keywords. A search on one place: `with conjugal in the title` (also `in the abstract`, `in the full text`, `in the title or abstract`). Search strings use capital AND / OR / NOT, quotes for phrases, `*` for truncation: `about ((asthma OR wheeze) AND child*)`. **Use only the words the user gave; never add synonyms.** One word or one phrase needs no parentheses.
6. `citing [title](W123)`; `citing works in the collection [name](col_x)`.
7. `from [institution or country]` (when not the possessive); `co-authored with [institution]`; `by [author]`; `with [person](A1) as corresponding author`.
8. `in [journal](S123)`; classifications name their kind: `in SDG [Climate action](13)`, `in the topic [..](T123)`, `in the subfield [..](1702)`, `in the field [..](17)`; `in the collection [name](col_x)`.
9. `published by [publisher](P123)`, `funded by [funder](F123)` (several: `funded by [A](F1) or [B](F2)`), `under the [CC BY](cc-by) license`.
10. Anything that doesn't fit goes last, after `where`, as `field is value` conditions: `get works about "antimicrobial resistance" where country is [Nigeria](NG) or raw affiliation has Nigeria`.

Entities are links: name in brackets, OpenAlex ID in parentheses, the ID from find_entity. Countries use their two-letter code: `[Kenya](KE)`.

## Describing things (for rank and lists)

`authors`, `institutions`, `companies`, `journals`, `repositories`, `publishers`, `funders`, `topics`, `countries`, then:
- `at [institution]` (an author's own record, any year; add a year only when the user gives one: `at [UBC](I141945490) since 2022`), `in [country]`;
- their own fields: `with an h-index above 50`, `with more than 1,000 works`;
- a count of the matching works: `with at least 10 works about kelp`.

## Numbers

`count of works` (never bare `count` in Show), `sum of citations`, `sum of APCs paid`, `mean FWCI`, `mean citations`, `median citations`, `percent open access`, `percent retracted`, `percent with an abstract`, `share of the total`, and a thing's own fields (`h-index`). A number covers the matching works; `_all_ their works` covers everything they have.

- Rank: `rank journals by count of works since 2020 about (archaeology AND "deep learning")`; `rank authors by sum of citations to works since 2018 about oleogel*`; with a count filter the measure stands alone: `rank institutions in [Sweden](SE) with at least 10 works about kelp by mean FWCI`. Lowest first: add `, lowest first`.
- Rank by a thing's own field, with a threshold on it: `rank authors at [UBC](I141945490) by h-index. Only authors with an h-index above 50.`
- Extra columns are a second sentence: `rank authors by count of works about "latent dirichlet allocation". Show sum of citations, mean FWCI and h-index.`
- One number: `get the count and mean citations of works from 2022 in the field [Computer Science](17)`; `get the sum of APCs paid for [University of Kansas](I146416000)'s works`; `get the percent open access of [University of Kansas](I146416000)'s articles since 2020`.
- Who an institution works with: `rank institutions in [Germany](DE) by count of works co-authored with [University of Kansas](I146416000)`. Where it publishes: `rank journals by count of [University of Kansas](I146416000)'s articles since 2020`.

## Breakdowns

`break down <works> by <dimension>[ and <dimension>]`. Dimensions: year, field, subfield, topic, SDG, type, open access, open access status, country, institution, publisher, funder, language, corresponding author. With year, the year range follows it: `by year since 2004`. Listed values: `by year and country in ([Canada](CA), [China](CN))`, or `by year and institution in the collection [My peers](col_x)`. `all works` when nothing narrows them. Default columns are the count and the share of the total; others go in `Show ...`.

- `break down all works by SDG`
- `break down [University of Florida](I33213144)'s works by year since 2004`
- `break down works funded by [Wellcome Trust](F4320311904) by year and type`
- `break down works in [Heliyon](S2898612692) by year and field. Show count of works and percent retracted.`
- Comparing named things, one row each: `break down works about CRISPR by institution in ([Massachusetts Institute of Technology](I63966007), [Stanford University](I97018004)). Show mean FWCI and percent open access.`
- Named journals over time: narrow the works to them, so the totals are theirs: `break down works in [Journal of Healthcare Engineering](S36625193) or [PLoS ONE](S202381698) by source and year. Show percent retracted.` (no parentheses around the journals).

## Order (lists)

End a list with `, most cited first`, `least cited first`, `newest first`, `oldest first`, `best matches first`, `highest FWCI first`, or `alphabetical by title`.

## When the sentences can't say it

Citations between two sets of works, one thing against everything else, a set inside a condition, and random samples aren't sentences yet. Write them in the older form, which the API runs and echoes as well as it can. Use it only for these:

- Works citing a set: `get works where it cites a work in the set (get works where topic is [Genomic Analysis of Ancient DNA](T10751))`.
- Who cites us, one row per citing institution: `get institutions that published works where it cites a work in the set (get works where publisher is [JMIR Publications](P4310320608)); then, summarize each institution using count`.
- What our authors cite, one row per cited journal: `get sources that published works where it's cited by a work in the set (get works where institution is [University of Scranton](I124113063) and published since 2025); then, summarize each source using count`.
- One thing against the rest of the world: `get works where published since 2020; then, compare institution [University of Kansas](I146416000) versus institution is not [University of Kansas](I146416000) using count, mean FWCI and percent top 10% cited` (add `by field` at the end for one row per field).
- A set inside a condition: `get works where published in 2024 and (institution is [Basque Centre for Climate Change](I4210092744) or author is in the set (get authors at (I4210092744)))`.
- A random sample: `get works where title-abstract-keywords has (kelp); then, sample 25 of those works with seed 1`.

## Rules

- Use only the words on this page; don't invent fields.
- Not in the language at all: three or more dimensions.
