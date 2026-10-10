# OQL on one page (v6, thing-first as built 2026-10-09)

The guide a model gets when it turns a question into OpenAlex's query language, OQL. Every example is written the way OpenAlex echoes it back.

## Shape

A query starts with `get` and what to start from: `get works where <conditions>` (or `get authors where ...`, `get institutions where ...`, `get sources where ...`). Each later step follows a semicolon and opens with `then,`; the last of two or more opens with `finally,`. A summary, if any, is always the last step, and names what it summarizes: `summarize all those works using ...` (one row for the set), `summarize each author using ...` (one row per author); after a split, `summarize using ...`.

`get works where institution is [MIT](I63966007) and published since 2020; then, group those works by year; finally, summarize using count and mean FWCI`

## Values

- Entities are links: the name in brackets, the OpenAlex ID in parentheses: `[MIT](I63966007)`, `[CRISPR and Genetic Engineering](T10878)`, `[Nature](S137773608)`. The name is optional: `(I63966007)`. Countries, types, languages and statuses are links too, by their codes: `[Kenya](KE)`, `[article](article)`, `[gold](gold)`. Other schemes' ids go in their own fields: `ORCID is 0000-0002-1825-0097`, `DOI is 10.1234/x`, `ROR ID is 00ghzk478`.
- One value needs no parentheses: `published since 2020`, `type is not [review](review)`. Several go in one pair, joined by `or` (any of them) or `and` (all of them, for things a work has many of): `institution is ([MIT](I63966007) or [Stanford University](I97018004))`, `country is ([United States](US) and [China](CN))`.
- Join conditions with `and` / `or`; group them with parentheses. Negate on the verb: `institution is not [MIT](I63966007)`, `type is not ([review](review) or [editorial](editorial))`. A yes/no field reads as a sentence: `it's open access`, `it's not retracted`, `it has a DOI`, `it doesn't have an abstract`.
- Search fields use `has`, with a portable search string in parentheses and its own capital AND/OR/NOT: `title-abstract has ((asthma OR wheeze) NOT (pediatric OR child))`; quotes make a phrase: `title-abstract has ("graphene oxide" AND battery)`; one wildcard word needs no parentheses: `title has adolescen*`.

## Two moves: stay inside, or walk out

- **Start with the things, or split** (`get authors who published works where ...`, `group those works by year`): every number counts only the works you have.
- **Walk** (`get each author of those works`) moves to the related things themselves; `get all that author's works` then takes everything by each one, not just the works you had.

"Each MIT author's mean FWCI on their MIT papers" starts with the authors (below); "each MIT author's mean FWCI on all their papers" is a walk.

## Steps

- **Split:** `group those works by <field>` gives one group per value of a field that isn't a thing (year, type, open access status, language, institution type, source type, subfield, field, domain, keyword, SDG, license, and the yes/no fields). Split by two or three in the same step: `group those works by year and type`. To get one row per author, institution, source, publisher, funder, country or topic, start with that thing (see "Start with the thing you want").
- **Split numbers into bins:** `group those works into citation count bins at (1, 10, 100)` gives `0`, `1-9`, `10-99`, `100+`; `into FWCI bins of 0.5` gives equal widths.
- **Compare named things, one row each:** `compare institution [MIT](I63966007) versus [Stanford University](I97018004) versus [Harvard University](I136199984)`. Write the field once when every item shares it; `is` goes unsaid inside a comparison, but `is not` is written out. Different fields: `compare institution [KU Leuven](I99464096) versus country [Belgium](BE)`. Searches: `compare title-abstract has "machine learning" versus "edge AI"`. Periods and other conditions: `compare published from 2016 through 2019 versus published since 2021`; a yes/no field alone means true: `compare open access versus not open access`. Inside one item `and` / `or` are logic. Rows can overlap. Up to 100 items; for more, save them as a collection and compare its members: `compare each institution in the collection [Our peers](col_peers)`.
- **A comparison is always between two or more things,** never one thing alone. To set one thing against everything else, compare it with the rest: `compare country [India](IN) versus country is not [India](IN)`. Us against our peers: name each peer, or put the peers in a collection to get them as one row: `compare institution [MIT](I63966007) versus institution is in the collection [Our peers](col_peers)`.
- **Measure a comparison** inside the same step with `using`, and **break it down** with `by` after that: `compare institution [MIT](I63966007) versus [Stanford University](I97018004) using count and mean FWCI by year and type` (up to three splits in all, the comparison counting as one). A comparison comes before any other split and ends the query: no `summarize` step after it.
- **Every grouped result also has a summary row** for the whole starting set, with the same numbers, so start from the widest set you compare against (the world, a country, a field), not from your own institution.
- **Walk out to related things:** `get each <thing> of those works` gives one result per thing (author, institution, source, publisher, funder, topic, subfield, field, domain, keyword, SDG, country); `get <things> of those works` gives one combined set. Filter them by their own fields: `get each author of those works where h-index is above 20`. Walk before any split; one walk out per query.
- **Walk back to everything they did:** `get all that <thing>'s works` after `get each <thing>` (one result per thing), or `get all those <things>' works` after `get <things>` (one combined list of works, which you can then split). Add conditions: `get all those authors' works where published since 2026-08-01`. After `get each`, summarize directly (no split).
- **Summarize (always last; after a comparison the measures go inside it with `using`):** `summarize using <measure>, <measure>`: `count`; `mean`, `median`, `sum`, `min`, `max` of a number field (`mean FWCI`, `median citation count`, `sum APC paid`); `percent` of a yes/no field (`percent open access`, `percent retracted`); `percent of those works`, each group's share of the set it came from; `min date` / `max date`. A field of the works always needs a calculation (`mean authors count`, never `authors count`). A field of the things themselves, when the query starts with them, is shown beside each row: `get authors who published works where title-abstract has kelp; then, summarize each author using count and h-index`.

## Start with the thing you want

To get one row per author, institution, source, publisher, funder, country or topic, start the query with that thing, then say which works count:

`get authors at [University of British Columbia](I141945490) since 2022 who published works where title-abstract has kelp; then, summarize each author using count, mean FWCI, and h-index`

- Each row is one author; `count` is how many of the matching works (kelp works) that author has; `mean FWCI` is over those works; the author's own fields (`h-index`, `last known institution`) sit beside them.
- `at [institution]` reads the author's own record (the institutions listed on their profile, with years), not the papers' affiliations: `at [UBC](I141945490) since 2022` (UBC in their record in 2022 or later), `ever at [UBC](I141945490)`. Stricter: `at [UBC](I141945490) in 2+ years since 2022` (UBC in at least two of those years).
- `in [country or continent]`: `get authors in [Brazil](BR) who published works where ...`; `get institutions in [Asia](Q48) that published works where topic is [Livestock and Poultry Management](T13294) and published since 2016`.
- Proximity inside a search: `title has (smart and phone within 3 words of each other)`.
- A list of authors by their record, no works: `get authors in [Brazil](BR) since 2022 where h-index is above 30`; when a place has too many authors to check the years, the error says how to narrow it (or `ever in [Brazil](BR)`, any year).
- Without a place, every author of the matching works: `get authors who published works where institution is [MIT](I63966007)`.
- The verb fits the thing: `get institutions that published works where ...`, `get sources that published works where ...`, `get funders that funded works where ...`, `get countries that published works where ...`, `get topics of works where ...`.
- The thing's own fields go in a `where` before the verb: `get authors where h-index is above 20 who published works where ...`; `get institutions where type is [education](education) that published works where ...`; `get authors where co-author is not [Jane Smith](A5023888391) who published works where ...`.
- How many of the matching works each has: `get authors who published more than 5 works where title-abstract has kelp` (`at least`, `fewer than`, `at most`). There is no filter on other calculations (a mean FWCI): get the rows and read them.
- Split each one's works further: `get institutions in [Asia](Q48) that published works where ...; then, group each institution's works by year; finally, summarize using count`.
- A role on the works: `get authors who were corresponding authors of works where author is [Jane Smith](A5023888391)`; `get institutions that were corresponding institutions of works where ...`.
- The authors as one set: `then, summarize all those authors using count` (how many distinct authors).

## Sets

- A set defined by a query: `author is in the set (authors of works where title-abstract has (kelp))`; the set phrase names the things (`works where ...`, `authors of works where ...`). Citations: `it cites a work in the set (works where institution is [University of Kansas](I146416000))` (works citing any of Kansas's works); `it's cited by a work in the set (...)` (works that Kansas's works cite). Negate on the verb: `it doesn't cite any work in the set (...)`, `author is not in the set (...)`.
- A saved collection (a list the asker has: names, DOIs, a ranking OpenAlex doesn't hold): `topic is in the collection [Climate topics](col_abc123)`; start from one: `get works in the collection [My list](col_mylist)`, `get each author in the collection [Panel](col_panel)` (each author with all their fields).
- Co-authorship as a filter: `get authors where co-author is [Jane Smith](A5023888391)`; `get institutions where collaborator is not [MIT](I63966007)`.

## Words

- **Works, searches:** title, title-abstract, title-abstract-keywords, abstract, full text, raw affiliation.
- **Works, fields:** year, date (`published since 2020`, `published in 2023`, `published from 2015 through 2024`, `published before 2020`, `published since 2024-01-01`); numbers in words: `citation count is above 10`, `is at least`, `is below`, `is at most`; type (article, review, book, book-chapter, dataset, preprint, dissertation, editorial, letter, ...), language, open access, open access status, license, retracted, has DOI, has abstract, has fulltext, has ORCID, global south, top 1% cited, top 10% cited; institution, institution type, institution country, country, continent, author, corresponding author, source, source type, publisher, funder, awards, topic (the work's primary topic; `topics` matches any of its topics), subfield, field, domain, keyword, SDG; citation count, FWCI, citation percentile by subfield, reference count, authors count, institutions count, countries count, APC paid; DOI, PMID, ISSN, ORCID.
- **Authors:** h-index, i10-index, works count, citation count, last known institution, has ORCID, topic, subfield, field, domain, co-author.
- **Institutions:** country, continent, type, region, city, global south, works count, h-index, subfield, field, domain, collaborator.
- **Sources:** type, publisher, ISSN, works count, h-index, 2-year mean citedness, subfield, field, domain.

## Not in the language yet

Splitting each walked thing's works further (walk to the combined set instead); a second walk out in one query; a query inside a query inside parentheses. No sorting or top N (the result comes back sorted by count; ask for all groups and read the top). Nothing OpenAlex doesn't hold.

## Mistakes to avoid

- Always write a query, even when part of the question can't be answered: leave out what OpenAlex doesn't hold and say so on a `MISSING:` line after it. Answer `NO DATA` only when nothing in the question can be queried.
- **Listing or ranking things by their own numbers is not a calculation.** Start from those things and stop: `get authors where last known institution is [MIT](I63966007) and h-index is above 20`.
- **No empty group and no "everything else" group**: the summary row is already the whole starting set.
- `those <things>` names what the query holds now: splits divide works, so walk back to works before splitting.
- Write every value out: no `...` or "etc." inside a list.
- Use only the words on this page; don't invent fields.

## Limits

Up to three splits; up to 100 items in a list or a comparison; up to 5 AND/OR/NOT in each compared search; about 10 seconds a query.

## Examples

0. Open access share of Kenyan papers since 2015 (one summary, no split):
   `get works where country is [Kenya](KE) and published since 2015; then, summarize all those works using percent open access`
1. Open access share by year for Kenyan papers since 2015:
   `get works where country is [Kenya](KE) and published since 2015; then, group those works by year; finally, summarize using percent open access`
2. Each author of MIT papers, and their mean FWCI on those papers:
   `get authors who published works where institution is [MIT](I63966007); then, summarize each author using count and mean FWCI`
3. Each author of KU's 2023 papers, and their mean FWCI on all their papers (a walk):
   `get works where institution is [University of Kansas](I146416000) and published in 2023; then, get each author of those works; then, get all that author's works; finally, summarize each author using mean FWCI`
4. How many distinct authors published on CRISPR:
   `get authors who published works where topic is [CRISPR and Genetic Engineering](T10878); then, summarize all those authors using count`
5. Papers citing the University of Kansas's papers, by year:
   `get works where it cites a work in the set (works where institution is [University of Kansas](I146416000)); then, group those works by year; finally, summarize using count`
6. MIT, Stanford and Harvard on CRISPR, by year, against all CRISPR papers:
   `get works where topic is [CRISPR and Genetic Engineering](T10878); then, compare institution [MIT](I63966007) versus [Stanford University](I97018004) versus [Harvard University](I136199984) using count and mean FWCI by year`
7. KU Leuven and Belgium against the world, by SDG:
   `get works where published since 2016; then, compare institution [KU Leuven](I99464096) versus country [Belgium](BE) using count and percent of those works by SDG`
9. Works since 2025 by anyone who wrote a kelp paper since 2022:
   `get works where author is in the set (authors of works where title-abstract has (kelp) and published since 2022) and published since 2025`
10. Open access share by year for papers funded by the NIH:
   `get works where funder is [National Institutes of Health](F4320332161); then, group those works by year; finally, summarize using percent open access`
11. German institutions that have never co-authored with MIT:
   `get institutions where country is [Germany](DE) and collaborator is not [MIT](I63966007)`
12. The h-index of each author in a list the asker has:
   `get each author in the collection [My list](col_mylist)`
13. Ghana's papers with an abstract that aren't retracted, by year:
   `get works where country is [Ghana](GH) and it has an abstract and it's not retracted; then, group those works by year; finally, summarize using count`
14. Teen depression papers, open access against not, by year:
   `get works where title-abstract has ((adolescen* OR teen*) AND depress*); then, compare open access versus not open access using count and mean FWCI by year`
