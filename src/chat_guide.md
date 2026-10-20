# OQL on one page (v8, tables of groups, 2026-10-20)

OQL is OpenAlex's query language. It reads like plain English. A statement is one main sentence, sometimes followed by a short `Show ...` or `Only ...` sentence. Every query returns one of two shapes: **a list of records** (works, or things by their own fields) or **a table of groups** (numbers about a set of works, one row per group).

## Two kinds of sentence, both start with `get`

- **A list:** `get <works>[, <order>]`, or things by their own fields: `get authors at [University of British Columbia](I141945490) with an h-index above 50, highest h-index first`.
- **A table of groups:** `get the <numbers> of <works> by <splits>[, <order>]`. One number is the smallest table: `get the count of [University of Kansas](I146416000)'s works`. With splits: `get the count of works about kelp by author at [University of British Columbia](I141945490)`.

The sentence never changes with the order: the order is only the words after the last comma. Never write `rank` or `break down`: they are not OQL (a query that starts with them is refused).

## Describing works

A type noun with modifiers, in this order:

1. The institution, country or person the question is about, as a possessive: `[University of Kansas](I146416000)'s works`. Two or more people: `works co-authored by [A](A1) and [B](A2)`. Works with several places at once: `works from both [University of Oxford](I40120149) and [University of Cambridge](I241749)` (three or more: `from all of A, B, and C`).
2. Yes/no words before the noun: `open access`, `retracted`, `top 1% cited`.
3. The noun: works, articles, reviews, preprints, datasets, books, book chapters, conference papers, dissertations. Say `articles` when the user says articles (journal articles, research articles); papers, publications and research are `works`, which counts every type (datasets too).
4. Time, right after the noun: `since 2020`, `from 2022`, `before 2010`, `from 2018–2025`. Prefer years; full dates only when the user gives exact dates (`from 2020-10-01 through 2021-09-30`). **Write a year only when the user gives one.**
5. What it's about: `about kelp` searches title, abstract and keywords. One place: `with conjugal in the title` (also `in the abstract`, `in the full text`, `in the title or abstract`). Search strings use capital AND / OR / NOT, quotes for phrases, `*` for truncation: `about ((asthma OR wheeze) AND child*)`. **Use only the words the user gave; never add synonyms.** One word or one phrase needs no parentheses.
6. `citing [title](W123)`; `citing works in the collection [name](col_x)`.
7. `from [institution, country or continent]` (when not the possessive); `co-authored with [institution]`; `by [author]`; `with [person](A1) as corresponding author`.
8. `in [journal](S123)`; classifications name their kind: `in SDG [Climate action](13)`, `in the topic [..](T123)`, `in the subfield [..](1702)`, `in the field [..](17)`; `in the collection [name](col_x)`.
9. `published by [publisher](P123)`, `funded by [funder](F123)` (several: `funded by [A](F1) or [B](F2)`), `under the [CC BY](cc-by) license`.
10. Anything that doesn't fit goes last, after `where`, as `field is value` conditions.

Entities are links: name in brackets, OpenAlex ID in parentheses, the ID from find_entity. Countries use their two-letter code (`[Kenya](KE)`), continents their ID (`[Africa](Q15)`, `[Europe](Q46)`).

## Tables of groups

`get the <numbers> of <works> by <split>[ and <split>][, <order>]`

**Numbers**, joined with `and` (Oxford comma for three): `count`, `share` (each row's slice of the group one level up: of the whole set with one split, of each year with `by year and country`), `sum of citations` (takes `to`: `the sum of citations to works ...`), `sum of APCs paid` (takes `for`), `mean FWCI`, `median FWCI`, `mean citations`, `median citations`, `percent open access`, `percent retracted`, `percent with an abstract`, `percent top 10% cited`, any `percent <yes/no word>`. A number covers the matching works.

**Splits** (one or two): `year`, `field`, `subfield`, `domain`, `topic`, `SDG`, `type`, `open access`, `open access status`, `language`, `corresponding author`, and things: `author`, `institution`, `company`, `country`, `journal`, `source`, `publisher`, `funder`. With year, the year range follows it: `by year since 2004`.

**Which groups**, right after the split word:
- the things' own record: `by author at [University of British Columbia](I141945490)` (authors whose record lists UBC, with all their matching works wherever they wrote them; different from `works from [UBC] by author`, which counts everyone on UBC's papers), `by institution in [Sweden](SE)`, `by institution in [Africa](Q15)`, `by author with an h-index above 40`;
- a list: `by country in ([United States](US), [China](CN))`, `by institution in ([A](I1), [B](I2))`, `by funder in ([A](F1), [B](F2))`, `by institution in the collection [My peers](col_x)`. Authors and journals take no list: for named journals side by side, narrow the works to them (`works about kelp in [A](S1) or [B](S2) by journal`); for named people side by side, the general form's `compare author [A](A1) versus [B](A2) using count` (below);
- leaving some out: `by country except [Kenya](KE)`, `by institution except ([ETH Zurich](I35440088), [Board of the Swiss Federal Institutes of Technology](I2799323385))`. Use it when the subject would top its own partner list.
- the things' own fields, after `where` (the fields under "Things' own fields" below, and `co-author` for authors): `by author where last known institution is [University of Kansas](I146416000)` (people there now; `by author at [X]` also counts anyone whose record lists X in any year), `by author where last known institution is not [KU Leuven](I99464096)`, `by author where co-author is not [Albert A. Koelmans](A5001483262)` (people who never co-authored with him), `by institution where institution type is [education](education)` (universities). Conditions about the people or places go here, not on the works: `works where institution is not [KU Leuven](I99464096) by author` drops papers, not people. A broad one needs a count floor to run in time: `Only authors with at least 5 works about ...`.

**A count floor** is its own sentence after the main one: `Only institutions with at least 10 works about kelp.` (the same works as the table).

**A thing's own fields** (h-index, works count) are not numbers of the works: add them with `Show h-index.`, or order by them (`, highest h-index first`), which shows them.

**Order**, after a comma at the end; leave it out for the default (most works first; years oldest first):
`, highest <number> first`, `, lowest <number> first` (one number: `, highest first`), `, fewest works first`, `, most works first` (only needed with a year split), `, newest first` (years), `, alphabetical by <split>`, `, highest h-index first`.

A percent or mean ordered highest first puts tiny groups at the top (5 works, 100% open access). When the user asks who is highest on a rate or mean, add a count floor: `Only institutions with at least 500 works.`

Examples:
- `get the count of works since 2020 about (archaeology AND "deep learning") by journal`
- `get the count and mean FWCI of works about kelp by institution in [Sweden](SE), highest mean FWCI first. Only institutions with at least 10 works about kelp.`
- `get the count of works about "latent dirichlet allocation" by author. Show h-index.`
- `get the count of works about kelp by author at [University of British Columbia](I141945490), highest h-index first`
- `get the sum of citations to works since 2018 about oleogel* by author, highest first`
- `get the count and share of all works by SDG`
- `get the count of [University of Florida](I33213144)'s works by year since 2004`
- `get the count and percent retracted of works in [Heliyon](S2898612692) by year and field`
- `get the count and share of top 1% cited articles by year and country in ([United States](US), [China](CN))` (the US share of each year's top articles)
- `get the count of works since 2015 co-authored with [Kiel University](I32021983) by company`
- `get the count of works from [Kenya](KE) by country except [Kenya](KE)`
- `get the count and mean FWCI of works since 2015 by institution in ([Indian Institute of Technology Bombay](I162827531), [Indian Institute of Technology Delhi](I68891433))`
- One number: `get the count and mean citations of works from 2022 in the field [Computer Science](17)`; `get the sum of APCs paid for [University of Kansas](I146416000)'s works`.

## Lists

End a list of works with `, most cited first`, `, least cited first`, `, newest first`, `, oldest first`, `, best matches first`, `, highest FWCI first`, or `, alphabetical by title`. Things by their own fields: `get institutions in [Austria](AT), most cited first`; `get authors at [University of British Columbia](I141945490) with an h-index above 50, highest h-index first`.

## Fields for `where`

Anything the phrases above don't say goes after `where` at the end of the works phrase, as `field is value` conditions joined with `and` / `or`: `get works about kelp where source type is [journal](journal) and language is [English](en)`. Negate on the verb (`type is not [review](review)`); numbers in words (`citation count is above 100`, `is at least`, `is below`, `is at most`); several values in one pair of parentheses (`institution type is ([company](company) or [government](government))`); yes/no fields as sentences (`it's open access`, `it has an abstract`, `it's not retracted`).

- **Works, searches** (`has`): title, title-abstract, title-abstract-keywords, abstract, full text, raw affiliation: `where raw affiliation has ("Max Planck" AND Leipzig)`.
- **Works, fields:** type, language, open access, open access status, license, retracted, has DOI, has abstract, has fulltext, has ORCID, global south, top 1% cited, top 10% cited; institution, institution type, institution country, country, continent, author, corresponding author, corresponding institution, source, source type, publisher, funder, awards, topic (primary), topics (any), subfield, field, domain, keyword, SDG; citation count, FWCI, citation percentile by subfield, reference count, authors count, institutions count, countries count, APC paid; DOI, PMID, ISSN, ORCID.
- **Journal articles:** `articles` is the type; the journal is the source type: `get articles since 2020 about kelp where source type is [journal](journal)`.
- **Things' own fields** (lists and `where` on things): authors: h-index, i10-index, works count, citation count, last known institution, has ORCID; institutions: country, continent, type, region, city, global south, works count, h-index; sources: type, publisher, ISSN, works count, h-index, 2-year mean citedness.

## When a sentence can't say it: the general form

The sentences above cover lists and tables. For anything else, write the general form; it is fully supported, and the page shows the sentence form whenever one exists. It starts `get works where <conditions>` (conditions only: `published since 2015`, `title-abstract-keywords has (kelp)`, `institution is [X](I1)`), and steps follow semicolons: `then,` for each, `finally,` for the last of two or more.

- **Citations between sets:** `get works where it cites a work in the set (works where institution is [University of Kansas](I146416000)); then, group those works by year; finally, summarize using count` (`it's cited by a work in the set (...)` for the other direction).
- **One against the rest, or named things side by side:** `get works where published since 2015; then, compare country [India](IN) versus country is not [India](IN) using count and mean FWCI`; `get works where topic is [CRISPR and Genetic Engineering](T10878); then, compare institution [Massachusetts Institute of Technology](I63966007) versus [Stanford University](I97018004) using count and mean FWCI by year`.
- **Sets inside conditions:** `get works where author is in the set (authors of works where title-abstract has (kelp) and published since 2022) and published since 2025`.
- **Walks** (each author of a set, then all their works): `get works where institution is [University of Kansas](I146416000) and published in 2023; then, get each author of those works; then, get all that author's works; finally, summarize each author using mean FWCI`.
- **How many distinct authors:** `get authors who published works where topic is [CRISPR and Genetic Engineering](T10878); then, summarize all those authors using count`.
- **Number bins:** `get works where title-abstract-keywords has (kelp); then, group those works into citation count bins at (1, 10, 100); finally, summarize using count`.

## Worked examples

1. "Most cited papers on large language models since 2023" -> `get works since 2023 about "large language models", most cited first`
2. "Newest Oxford papers on malaria vaccines" -> `get [University of Oxford](I40120149)'s works about (malaria AND vaccine), newest first`
3. "Highest-FWCI journal articles on CRISPR" -> `get articles about CRISPR where source type is [journal](journal), highest FWCI first`
4. "Which countries publish most on quantum computing?" -> `get the count of works about "quantum computing" by country`
5. "Leading researchers on microplastics in the ocean since 2019, with h-index" -> `get the count of works since 2019 about (microplastics AND marine) by author. Show h-index.`
6. "UBC's kelp researchers, most senior first" -> `get the count of works about kelp by author at [University of British Columbia](I141945490), highest h-index first`
7. "Which Swedish institutions with 10+ kelp papers have the best FWCI on them?" -> `get the count and mean FWCI of works about kelp by institution in [Sweden](SE), highest mean FWCI first. Only institutions with at least 10 works about kelp.`
8. "University of Florida output per year since 2004" -> `get the count of [University of Florida](I33213144)'s works by year since 2004`
9. "France's papers since 2013 by year and OA route" -> `get the count and share of [France](FR)'s works by year since 2013 and open access status`
10. "Is the US share of top 1% cited articles falling while China's grows?" -> `get the count and share of top 1% cited articles by year and country in ([United States](US), [China](CN))`
11. "IIT Bombay vs IIT Delhi on output and FWCI since 2015" -> `get the count and mean FWCI of works since 2015 by institution in ([Indian Institute of Technology Bombay](I162827531), [Indian Institute of Technology Delhi](I68891433))`
12. "Which countries does Kenya co-author with most?" -> `get the count of works from [Kenya](KE) by country except [Kenya](KE)`
13. "How many papers have Oxford and Cambridge co-authored each year since 2015?" -> `get the count of works from both [University of Oxford](I40120149) and [University of Cambridge](I241749) by year since 2015`
14. "Average citations of 2022 computer science papers" -> `get the count and mean citations of works from 2022 in the field [Computer Science](17)`
15. "What did Wellcome-funded papers pay in APCs, by publisher?" -> `get the sum of APCs paid for works funded by [Wellcome Trust](F4320311904) by publisher, highest first`
16. "Austrian institutions with the most open access" -> `get the count and percent open access of all works by institution in [Austria](AT), highest percent open access first. Only institutions with at least 500 works.`
17. "Papers citing KU's work, per year" -> the general form, citations between sets (above).

## Rules

- Use only the words on this page; don't invent fields.
- Prefer a sentence (a list or a table); use the general form only for what no sentence can say. Up to two splits in a table, three in the general form.
