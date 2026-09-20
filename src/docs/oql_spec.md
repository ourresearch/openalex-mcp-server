# Specification

> This is the **formal specification** of OQL. If you want to get started right away, see the [overview](/access/oql/) or the [Systematic reviews with OQL](/tutorials/systematic-reviews/) recipe.

OQL is the **human-readable surface over OQO**. It is defined and validated *in
terms of* OQO (the canonical query object — see the [OQO page](/access/oqo-schema/)) — not
in terms of the classic URL syntax. Its whole bet, versus Scopus / Web of Science /
Dimensions, is that a researcher can **read a query aloud and roughly understand
it** (confirmed by a peer survey: OQL is the only one of the four that does this).

---

## Design principles

In priority order:

1. **Human-readable / reads aloud.** Protect this above all.
2. **Map as tightly to OQO as possible.** OQO is canonical; OQL is sugar over it.
3. **When (1) and (2) conflict, decide case-by-case** — no global tiebreak.
4. **Cases > rules.** Rules emerge from worked examples; the spec leads with cases.
5. **Loud, never silent.** A query that can't do what it appears to do is an
   **error with a fix-it**, never a silent wrong answer.

## The canonical triple

```
URL  ↔  OQO  ↔  OQL          (OQO is canonical)
```

- **`OQL → OQO` is semantically lossless and order-preserving.** It discards only
  the **non-semantic text layer** — annotations/comments (display-name labels are a
  special case) and whitespace — and **normalizes equivalent spellings** to one
  canonical OQO (an implicit-AND space-run and an explicit `and` → one form; a
  technical column-id and its display name → one column).
- **`OQO → OQL` is deterministic** and *synthesizes* display-name labels.
- **Round-trip identity holds on the OQO side:** **`OQO → OQL → OQO` is the
  identity.** (`OQL-text → OQO → OQL-text` is *normalizing*, not identity —
  canonical spelling, regenerated `[names]`, comments gone.) This is how comments
  are allowed to exist without breaking "OQL is a pure function of OQO": they live
  only in the text layer, exactly like whitespace.
- **Operand order is the user's.** The order of clauses (the
  implicit top-level AND of the filter rows) and of values inside `is ( … )` /
  `has ( … )` groups is **preserved**, not alphabetized — for OQL-text and
  builder/direct-OQO input alike. So the block builder never jumps a freshly-added
  clause to an alphabetical slot, and a systematic-review author's block order is
  kept. **Consequence:** OQO is no longer a *single* canonical form on the OQL
  side — `where A and B` and `where B and A` are distinct OQO (idempotence still
  holds: `OQO → OQL → OQO` is a fixed point). **Exception — the classic-URL and
  natural-language translation paths sort operands alphabetically** into one
  canonical order: their input order is machine-shaped, not author-meaningful, and
  a deterministic order keeps the translation stable (this is also where the
  lower-bound-then-upper-bound numeric ordering applies).

This invariant is the spec's runnable contract — see [Conformance](#conformance).

## Statement shape

```
<entity> [ where <conditions> ] [ group by <dims> ] [ sample <n> [ seed <s> ] ]
```

- The entity type names the rows returned (`works`, `authors`, `institutions`,
  `sources`, `publishers`, `funders`, `topics`, …). It is a sentence word →
  lowercase canonically; any case accepted on input.
- `where` introduces the conditions. With no conditions, the bare entity is a valid
  query: `works`.
- Directives (`group by`, `sample`) follow, each introduced by
  its own keyword — no separating punctuation. A leading `;` is still
  accepted on **input** for back-compat, but the canonical form never emits one.

OQL covers exactly **filtering plus grouping**. Result-display
concerns — **sort order** and **column projection** — are deliberately **not** part
of the OQL surface, and not part of the OQO either: they travel as
sibling request params on the execute surface (`?sort=` / `?select=`), driven by
the GUI's own controls. There is deliberately **no HAVING-style syntax** for
filtering on group aggregates ([Out of scope](#out-of-scope)).

### Canonical formatting

`OQO → OQL` lays the canonical string out **width-aware and multi-line** when it
is long, so a real systematic-review query (one corpus case carries 114 search
leaves) reads as an indented tree instead of one ~1,600-char line. Because the
parser is **whitespace-blind** (whitespace is the non-semantic text layer — see
[the canonical triple](#the-canonical-triple)), the layout is
**OQO-identity-preserving by construction** — it cannot change meaning or break
any consumer. There is exactly **One Right Way** to lay a query out; it is a pure
function of the query, never of the input's whitespace. The rules:

- **Target width 80 columns** (soft); **indent 2 spaces** per level.
- **Recursive fits-or-explode** (the Black model): render a node flat; if it
  fits at its starting column, keep it on one line; otherwise **explode its
  direct children one level and recurse**. Breaking a parent does **not** force
  its children to break.
- **Top level.** A statement that fits stays on one line. Otherwise the entity
  head, the `where` body, and **each directive** go on their own line(s); the
  directives (`group by …`, `sample …`) sit at column 0.
- **Leading connectives — everywhere.** When *anything*
  explodes, `and` / `or` **begin** each continuation line (the first operand is
  bare; every later one is prefixed by the connective). This holds at the boolean
  `where` body **and** inside value/term groups — they read the same. A
  parenthesized group puts `(` on the current line, its operands one level
  deeper, and `)` back at the group's indent.
- **Value/term groups** (`is ( … )`, `has ( … )`): inline if they fit; else
  **> 8 items that all fit the width → fill/pack** (this is what tames long
  synonym blocks) — a *wrapped* line begins with the connective; otherwise **one
  item per line**, and an item that is itself an over-width parenthesized
  sub-group **explodes recursively** (a [merged](#merged-same-field-rendering)
  clause nests whole OR-blocks inside an AND; each block gets the same treatment,
  its open paren carrying the leading connective).
- **Why leading, not trailing.** `and`/`or` are **infix** — they can never sit on
  the last line the way a trailing comma can — so the Python/Black trailing-comma
  "clean append" trick doesn't transfer. With leading connectives, appending an
  item dirties **one** line (the new one); a trailing form would dirty **two** (the
  old last item gains a connective + the new line). The parser is whitespace-blind,
  so either form re-parses to the identical OQO; leading just gives the cleaner
  diff and a single rule across the whole tree.
- **Idempotence is a hard invariant:** `format(format(x)) == format(x)`. Every
  break decision is a pure function of *(content, width, depth)*.
- **Hard ceiling 100 columns:** only a **single unbreakable atom** (one quoted
  phrase, ID, or term longer than the budget) may exceed the target; nothing
  with an internal ` or `/` and ` break point ever does.

```
works where year >= (2020)
  and title has (
    fat or obese or obesity or overweight or thin or "anti fat" or "being fat"
    or "body esteem" or "body image" or "fat ideal" or "thin ideal"
    or "weight bias"
  )
```

## Conditions

### Optional leading `the`

A bare `the` immediately before a **field name** is accepted on input and
**dropped at parse**, so a clause can read like an English sentence:

```
works where the title has (cancer)     (input)  ->  works where title has (cancer)   (canonical)
works where the type is (article)       (input)  ->  works where type is (article)     (canonical)
```

- It is **input-only sugar** — like `[…]` annotations
  ([entity references](#entity-references)) and case, it carries
  no meaning and **never round-trips**: the canonical `OQO → OQL` render omits it.
- It is swallowed **only when a known field follows** (curated, faceted, or a raw
  registry column). This is a semantic guard, not a grammatical one: a search
  value that happens to open with "the" keeps it — `title has (the great gatsby)`
  is unchanged, and a stray `the` with no field after it is still an
  `OQL_UNKNOWN_FIELD` error (it is not silently eaten).
- Exactly **one** leading determiner is dropped, once per clause, right before the
  field. It is deliberately narrow (only `the`) — the goal is to let the
  natural-language reading the block builder's leading-`the` chip implies actually
  be typeable in the OQL pane, not to grow a stop-word list.

### Entity references

```
works where institution is (I136199984 [Harvard])
works where institution is (I136199984 [those Harvard bastards, go Yale])
```
Both produce `{column_id: authorships.institutions.lineage, value: I136199984}`.

- **`[ … ]` is a universal annotation slot.** Its contents are **ignored on input**
  (never validated) and **regenerated as the entity's display name on output**. You
  may write anything inside it. It attaches to the token before it.
- The name **cannot lie**, because nothing reads it — this kills a classic
  silent-mismatch bug (a query saying `Stanford [I136199984]` silently resolving
  to Harvard, because the ID — not the name — is what counts).
- The parser is **offline-pure**: no entity resolver in the parse path. A
  best-effort "⚠ that ID isn't Harvard" is the editor/linter's job, never the
  parser's, and never blocks.
- An entity reference with **only** an annotation and no ID is a **loud error**:
  `institution is [Harvard]` → `OQL_MISSING_ENTITY_ID`.
- Values are **bare** (no `entity/id` prefix): `I136199984`, `de`, `article`, `13`,
  `gold` — the column carries the namespace (per the [OQO spec](/access/oqo-schema/)).
  A `col_…` collection reference is also a valid bare value.

**Which values get a `[display name]` on output is per-column (registry-driven):**
the renderer synthesizes a name only when the bare value is **not human-readable** —
opaque OpenAlex IDs (`I136199984` → `[Harvard University]`) and **country codes**
(`de` → `[Germany]`). Already-readable slugs (`article`, `gold`, `en`) get **no**
annotation — `article [article]` is noise. This is a column property in the
properties registry, not an entity-vs-string distinction.

**Value case is cosmetic, not semantic.** The engine is case-insensitive on values
(`US`==`us`, `Article`==`article`, `I136…`==`i136…`), so
OQL canonicalizes case purely for readability: **enum slugs → lowercase**
(`type is Article` → `type is article`), **ISO country codes → uppercase**
(`country is us` → `country is US`), and **IDs / search text → verbatim** (an
OpenAlex ID's uppercase prefix is conventional; search text is the user's literal
words). `col_…` references are always preserved. (Per-column canonical case is a
registry property.)

### Value groups

A condition's value is **always** a parenthesized group — `is ( … )`:

```
works where institution is (I33213144 [Harvard] or I97018004 [Stanford])
works where type is (article or review)
works where type is (article)                              (singleton — same shape)
works where country is (us and uk)                         (works with BOTH a US and a UK authorship)
works where institution is (not I33213144 and not I97018004)
```

- **The parens rule (one rule, every condition operator, zero
  exceptions):** in canonical OQL a condition's **value slot is always a
  parenthesized group**, whether it holds one atom or many: `type is (article)`,
  `title has (cancer)`, `year >= (2019)`, `open access is (true)`,
  `language is (unknown)`, `work is in collection (col_abc123)`,
  `abstract is similar to ("…")`. An *atom* is one bare word, one quoted
  phrase, or one parenthesized sub-group. This replaces the old conditional
  arity rule ("parens when 2+, bare when single") — one shape, no exception for
  the grammar, the editor, or the reader to carry. **Directives are not
  condition values** and keep their own shapes (`group by topic, year`,
  `sample 500 seed 7`).
- **Bare singletons are accepted input only** (`type is article`,
  `year >= 2019`, `title has cancer` all parse) and canonicalize to the
  parenthesized form. They are part of the lenient input layer. **2+ bare
  values/terms with no parens stay a loud error** (`type is article review` →
  `OQL_UNDELIMITED_TERM_LIST`) — that is the rule that **kills the silent
  keyword-truncation footgun**: a reserved word (`group by`, `and`, …) can only
  "float" inside unquoted free text when there are 2+ unparenthesized terms.
- **Inside an `is ( … )` group the join is ALWAYS explicit:** `or` /
  `and` / `not`, nesting allowed; the field + operator distribute over every
  atom. **Bare space-adjacency between two values is a loud error**
  (`type is (article review)` → `OQL_GROUP_VALUES_NEED_CONNECTIVE`, fix-it:
  "add `or` between the values — or `and` if you mean both"), never a silent
  implicit AND. (If it silently parsed as AND, then for a single-valued field
  like `type` it would be the empty set: count 0, no error — the exact species of
  silent misparse this language forbids. The `has ( … )` search side is the
  one deliberate adjacency exception — a bare-word run there is ONE stemmed
  node, see [Search](#search).) `country is (us or uk)` is an OR-branch of
  equality leaves; `country is (us and uk)` (explicit `and`) means works with
  **both** a US and a UK authorship (for a single-valued field it is the
  empty set, which is coherent, not a footgun). Negation inside a group is
  the bare prefix `not` binding the next atom (`has (cancer and not mouse)` —
  see [Negation](#negation)).
- **Scalar-domain operators take exactly ONE atom in their group:** a
  comparison bound, a boolean, a collection ref, a semantic passage.
  `year >= (2019 or 2020)`, `retracted is (true or false)`,
  `work is in collection (col_a or col_b)` → `OQL_GROUP_NEEDS_ONE_VALUE` —
  the syntax shape is uniform (always parens); what may go INSIDE the group
  stays per-operator/domain. (`year is (2019 or 2020)` is fine — `is` on a
  numeric column is an ordinary set.)
- **Search values are the exception:** for a `has ( … )`
  search group, a **maximal run of bare connective-free words is ONE value node**
  (stemmed, adjacency-boosted), not a distributed AND of per-word leaves —
  `title/abstract has (mental health)` is a single
  `{title_and_abstract.search: "mental health"}` leaf. The engine adjacency-boosts
  the whole run (`match_phrase`), so splitting it would silently change ranking;
  recall is unaffected (cross-field AND). Explicit `and`/`or`/`not` still build
  the tree *between* such nodes (`(mental health or anxiety)` = two nodes OR'd).
  See [Search](#search). *(Space adjacency as AND still holds for **enum/value**
  groups like `country is (us and uk)` above — just not between search words.)*
- `not (a or b)` negates the whole group: `NOT(a OR b)` = `(NOT a) AND (NOT b)` by
  De Morgan — canonical NNF carries the negation on the leaves, and the canonical
  render keeps the group together with the `not`s inside: `x is (not a and not b)`
  (see [merged rendering](#merged-same-field-rendering) and
  [Negation](#negation)). (`is not (a or b)` is an accepted input
  spelling for the same thing.)
- **`unknown` / `null` inside a group is the null sentinel** — exactly as
  in the bare-scalar position ([null and unknown](#null-and-unknown)), so
  `language is (unknown)` is the canonical null test and mixed groups are
  expressible: `language is (en or unknown)` = language-is-English OR
  language-unknown. A literal value spelled "unknown" is written quoted
  (`is ("unknown")`), which is also how the canonical render emits it.
  - **One separator per level** — `or`/`and` inside a `( … )` group, not commas;
    a comma in a group is `OQL_COMMA_IN_GROUP`.
- **Not in the language:** the `any (…)` / `all (…)` / `any of` / `is in` list
  keywords and comma-separated lists. `(a or b)` / `(a and b)` are strictly more
  expressive (they nest; flat keyword lists can't) and lose no capability.
- `( … )` does **double duty**: a clause-group at the clause level
  (`(year >= (2020) or open access is (true))`) and a value/term group after an operator.
  The position disambiguates (a group right after `is`/`has` is a value/term
  group; one where a clause is expected is a clause group).

### Numeric bounds and ranges

A numeric field (`year`, `citation count`, `FWCI`) takes a single number, or a range
written as **explicit endpoint clauses** with the comparison operators:

```
works where year >= (2019) and year <= (2023)     (closed range — two endpoint clauses)
works where FWCI >= (1.5) and FWCI <= (3.0)       (floats allowed)
works where year >= (2019)                         (single-ended bound)
works where year > (42) and year < (100)           (strict bounds — stay strict)
```

A comparison's group takes **exactly one bound** (`year >= (2019 or
2020)` is `OQL_GROUP_NEEDS_ONE_VALUE`, never a distribution); the bare form
(`year >= 2019`) stays accepted input.

- **There is no dash range literal.** The `year is 2019-2023` / open-ended `year is
  2019-` / `year is -2023` spellings are **not** OQL surface syntax: write the
  explicit endpoints instead. This makes the parser simpler (a numeric
  value is a pure number, not a "mostly-int string"), buys clean type-checking, and
  fits OQL's picky/precise philosophy. Typing a dash range on a num field is a **hard
  error** (`OQL_RANGE_LITERAL_REMOVED`) with a fix-it echoing the endpoint
  form — *not* a lenient parse, and *not* a generic "not a number".
- **A closed range is the two-bound implicit-AND** `year >= (2019) and year <= (2023)`.
  Because the filter rows are an implicit AND, the two clauses round-trip as two bound
  leaves; the canonical render is lower-bound-then-upper-bound.
- **Strict bounds stay strict — no inference.** `year > 42 and year < 100` renders
  exactly as written; it is **not** rewritten to the inclusive `year >= 43 and year <=
  99`.
- **The OpenAlex URL range form is unaffected.** `publication_year:2019-2023` (and
  `fwci:1.5-3.0`, the open `:-2023`, strict `:>42`) still parse from URLs and still
  render *to* URLs from the bound leaves — only the OQL *surface literal* is absent, so
  URL round-trip survives.

### Merged same-field rendering

Published systematic reviews are **search-term trees** — "this term and that term,
but not that term" — written to be plugged whole into one text search; they are not
filter-triple trees. Canonical OQL therefore renders all the boolean structure that
belongs to **one field** as **one clause**, the tree inside the value group:

```
works where title has ((vape or vaping) and (health or harm))
works where title has (not dog and cat)
works where country is (not FR and US)
works where institution is (not I33213144 [Harvard] and not I97018004 [Stanford])
```

- **The rule:** among the children of one boolean node — including the implicit
  top-level AND of the filter rows — the items sharing one **(field,
  base-operator)** pair merge into a single `field op ( tree )` clause, the boolean
  structure preserved inside the parens. A negated leaf renders as a bare `not
  <atom>` prefix ([Negation](#negation)), merged or standalone alike — and the
  prefix always sits INSIDE the value group (`title has (not dog)`,
  `country is (not FR)`, `title has (not dog and cat)`), one position for both
  the singleton and merged cases.
- **All filter kinds**, not just search: `country is (not FR and US)` is canonical
  exactly like its `has` twin. Search groups merge by **base field** (a
  stemmed `.search` leaf and an exact `.search.exact` leaf share one group — that
  mix is a key expressiveness win for systematic-review strategies); `is` groups
  merge by column.
- **The principled boundary:** comparison operators live on the leaf (`>=`, `<`),
  so mixed-comparator pairs never merge — bound endpoints stay as separate clauses
  (`year >= 2019 and year <= 2023` —
  [numeric bounds](#numeric-bounds-and-ranges)). Null (`is unknown`),
  collection membership, semantic search, and bool/date columns keep their own
  surfaces and never merge. Cross-field structure necessarily stays multi-clause.
- **OQO is untouched.** Canonical OQO remains maximally distributed (NNF,
  leaf-level `is_negated`, top-level AND = the filter rows); the parser still
  distributes the field over every atom ([value groups](#value-groups)). This rule
  is **render-direction only** — it makes OQO→OQL emit the same forms OQL→OQO
  already accepts, so the round-trip identity
  ([the canonical triple](#the-canonical-triple)) is preserved by construction.
- **Ordering inside the merged group** follows the same operand-order rule as
  everything else: the user's given value order is preserved on
  the OQL/builder path, and alphabetized only on the classic-URL /
  natural-language paths. Merged and hand-written groups therefore read the same.
- Grounded in a survey of 732 real published systematic-review search strings:
  the dominant real-world shape is a flat AND of OR-groups over one field — which
  a maximally-split rendering would shatter into per-group clauses.

### Delimiters

| Delimiter | Meaning |
|---|---|
| `( … )` | boolean grouping: a group of clauses **and** a group of values/terms (`is (a or b)`, `has (a or b)`) |
| `[ … ]` | annotation slot — ignored on input, regenerated as a display name on output |
| `" … "` | literal text to match (a phrase) |
| `{ … }` | **unused** — banked for later |

**The language has no escape sequences at all.** Two lexing rules buy this:
1. **Strings are scanned opaquely** — any delimiter inside `" … "` (`[ ] ( ) ,`) is
   inert.
2. **An annotation runs to the first `]`** (no nesting, no `]` inside).

Therefore **only `"` delimits strings** — `'` is *not* a delimiter, so apostrophes
and contractions are ordinary characters: `"parkinson's disease"`, `child's`.
A literal `"` inside a search term is unsupported (the engine normalizes
punctuation away, so it is meaningless anyway) and documented, not escaped.

### Booleans, casing, precedence

```
works where title has (apple) and title has (banana or cherry)   ✓
works where title has apple and banana or cherry       ✗ OQL_UNDELIMITED_TERM_LIST
works where title has ("a" and "b" and "c")            ✓ (pure-AND, associative)
works where title has FOO and (bar or baz)             ✓ (any case accepted on input)
```

- **Operators always sit OUTSIDE quotes.** Inside quotes, even `or` is a literal
  word (the [search](#search) governing law).
- **`and` / `or` / `not` are lowercase canonically**, but **case-insensitive on
  input** (`AND`, `And`, `and` all parse). Lowercase wins on output because
  principle #1 is "reads aloud," and the rule "**`and`/`or`/`not` outside quotes are
  *always* operators — quote them to search them literally**" removes any ambiguity
  with content words, so the uppercase-for-disambiguation convention scholarly DBs
  rely on buys us nothing. (All keywords are lowercase: `where`, `is`, `has`,
  `within`, `stemmed`, `and`/`or`/`not`.)
- **`&` is an accepted input synonym for `and`** (`a & b` ≡ `a and b`, in both the
  clause body and inside a `has ( … )` search group). It is **input-only**: the
  canonical render always spells out `and`, never `&`. (Mirrors the long-standing
  `title & abstract` field-name spelling, which canonicalizes to `title/abstract`.)
- **Mixed and/or at one grouping level resolves by the standard precedence
  `NOT > AND > OR`** — it is **not** an error. `AND` binds tighter than
  `OR`, so `a and b or c` = `(a and b) or c` and `a or b and c` = `a or (b and c)`.
  This is the precedence boolean algebra and every programming language use, and —
  since Scopus changed early 2026 — **both Web of Science and Scopus now agree on
  it**, so honoring it (rather than throwing) matches the muscle memory of anyone
  coming from those tools. Pure-and or pure-or runs are associative and stay flat.
  **Canonical output always re-parenthesizes the precedence grouping**, so the
  structure is never left to the reader's head: the AND group inside a top-level OR
  renders parenthesized (`a or (b and c)`), while a single-connective level renders
  paren-free.
- **`not` is the prefix operator with the tightest precedence: it binds the single
  value immediately after it** (`not a or b` = `(not a) or b`). To negate a group,
  write `not (a or b)`. With AND/OR precedence also in effect, the full operator
  ordering is the conventional `NOT > AND > OR`.
- **Adjacency (space) between *search words* = ONE value node, NOT AND**
  ([search](#search)): `title has (climate change)` is a single stemmed
  adjacency-boosted node, not climate AND change. At the top level a 2+ word value
  must still be parenthesized (`title has climate change` →
  `OQL_UNDELIMITED_TERM_LIST`; the canonical render always
  parenthesizes). Explicit `and`/`or`/`not` build the tree *between* nodes, so
  `(climate change or warming)` = `node("climate change") OR node("warming")`.
  Explicit `and` + `or` at one level does not error — it resolves by precedence
  AND > OR (`(climate and change or warming)` = `(climate and change) or warming`),
  and the canonical render re-parenthesizes it. Between *whole
  clauses* at the top level a connective is still required (`year >= (2020) and
  open access is (true)`); two full clauses jammed together with no `and` is
  `OQL_IMPLICIT_ADJACENCY`. *(Adjacency-as-AND still holds for enum/value groups —
  [value groups](#value-groups), `country is (us and uk)`.)*

### Negation

```
works where title has covid and abstract has not pediatric
```
→ `{title has covid}` AND `{abstract has pediatric, is_negated: true}`.

There is **one** negation mechanism, mapping to OQO's `is_negated` (negation
normal form, NNF). On the
surface it is the bare prefix keyword **`not`**, written immediately before the
value it negates: `not FR`, `not dog`, `not col_abc`, `not unknown`. The predicate
spellings `is not` / `does not have` / `is not in collection` are **accepted on
input** as friendly aliases, but they are pure sugar — they lex straight to an
`is_negated` leaf (the OQO has no "negated predicate": its leaf operators are
strictly affirmative and negation only ever rides the `is_negated` bit), so they
**never survive canonicalization** — the emitted form is always the bare `not`
prefix.

**`not` binds the single value-node that follows it** — the tightest-binding
operator in OQL's `NOT > AND > OR` precedence
([precedence](#booleans-casing-precedence)). A run of bare words is one
value-node ([search](#search)), so `not machine learning` negates the whole run.
`not` binds only the next operand: **`not a or b` = `(not a) or b`.** To negate a
group, write `not (a or b)`: the parens are an ordinary group and the
canonicalizer pushes the negation down to the leaves by De Morgan —
`not (a or b)` → `(not a and not b)`.

`not`'s tight binding is the conventional top of the precedence ladder, and
it is especially safe here because negation only ever applies to a **single value**
(canonical NNF never negates a whole clause —
[merged rendering](#merged-same-field-rendering)): in everything OQL *emits*
`not` always has exactly one value to its right, so there is no group for it to
ambiguously scope over. The **block builder** (the primary on-ramp) makes this
concrete — you negate an individual value brick, which prepends `not` to that one
chip; there is no affordance to negate a sub-clause. The OQL text matches the brick
1:1.

Canonical output pushes negation **down to the leaf/value** (NNF) and renders it as
a bare `not <value>` prefix — it **never** emits `not <whole clause>` (`not (country
is FR)` is a readability trainwreck, and the canonicalizer's NNF guarantees a
clause-level negation can't reach the surface). So:
- a **standalone** negated leaf: `country is (not FR)`, `title has (not dog)`,
  `work is in collection (not col_abc)`, `language is (not unknown)` — the
  `not` sits inside the always-parenthesized value group (the predicate
  spellings `is not FR` / `has not dog` remain accepted input);
- **in-group** negation prefixes each atom: `has (not a and b)`,
  `country is (not FR and US)` ([merged rendering](#merged-same-field-rendering)) —
  the same position as the standalone case, one rule.

**Booleans negate by flipping the value, not a `not` prefix** — a boolean's value is
just `true` or `false`, so the two polarities are `open access is (true)` /
`open access is (false)` (the builder toggles the value brick). `is not true` folds to
`is (false)` on input ([boolean flags](#boolean-flags)). Negating a *group* value
spells the same NNF either way:
`title has not (dog or cat)` and `title has (not dog and not cat)` both
canonicalize to `title has (not cat and not dog)` (two negated leaves on one
field merge — [merged rendering](#merged-same-field-rendering)).

### Search

> **The search operator is `has`** (`title has (cancer)`). It was renamed from
> `contains` — shorter, friendlier, fits a monitor better — for both the OQL
> surface keyword **and** the OQO `operator` value, in lockstep. The old
> `contains` / `does not contain` spellings are a **hard error**
> (`OQL_CONTAINS_RENAMED`, with a `has` fix-it) — no lenient parse.

> **Stemming is ON by default; quotes are the only thing that turns it off.**
> A **run of bare words is ONE stemmed value node** (`(machine learning)` is one
> adjacency-boosted search, not `machine` AND `learning`); the
> engine matches each word across the field set (cross-field recall) and
> ranks adjacency higher (`match_phrase` boost). **Explicit `and`/`or`/`not` build
> the boolean tree between such nodes.** **Quotes = an exact, adjacent phrase** (no
> stemming) — single word or many. **`stemmed "…"`** is the bridge: an adjacent phrase
> that *stays* stemmed (recall). A **quoted word embedded in a bare run** is an
> *escape* — a literal stemmed word — so a reserved word can sit inside a value
> (`road traffic safety "and" Ghana`). Outside quotes = structure; inside quotes =
> literal text (even `or` is just a word there).

This is the mainstream model (Google, Bing, PubMed, Web of Science, Elasticsearch
all do space=AND and quotes=exact), chosen after surveying peer databases. OQO has
exactly **one** text
operator, `has`; the *mode* is split across the **column** (stemmed vs exact
vs semantic) and **inline value micro-syntax** (phrase / proximity / wildcard); the
**boolean** structure is the filter tree.

> **Cross-surface note — quotes mean something different in the GUI search box.**
> In OQL, **quotes = exact** (a quoted value routes to `.search.exact`, no stemming).
> The openalex.org **search box** instead treats quotes as a **stemmed adjacency
> phrase**: a quoted query stays on the stemmed `.search` field (stemming is a
> separate explicit "Disable stemming" toggle, plus an unquoted wildcard auto-routes
> to exact). So the same `"climate models"` is an *exact* phrase typed into OQL but a
> *stemmed* phrase typed into the search box. Both surfaces are internally consistent
> and consistent with the engine; they simply chose different defaults for the quote
> character. The translator bridges them faithfully: a search-box (stemmed,
> quoted) URL — `title_and_abstract.search:"climate models"` — renders to OQL as
> **`stemmed "climate models"`** (stemmed adjacency), *not* `"climate models"` (which
> would be exact and return a different result set). This is intentional, not a
> translator bug.

| Axis | OQL surface | OQO encoding |
|---|---|---|
| field scope | the field name (`title`, `title/abstract`, `abstract`, `full text`, `raw affiliation`, `byline`) | column prefix (`display_name.search`, `title_and_abstract.search`, `fulltext.search`, …) |
| stemming | **default ON**; quotes turn it OFF | column suffix `.search` (stemmed) vs `.search.exact` |
| stemmed phrase | `stemmed "…"` | `.search` with a quoted value |
| semantic | `is similar to ("…")` | column suffix `.search.semantic` (2-phase) |
| adjacency (phrase) | `" … "` | quotes in the value |
| proximity | leading list form `within N (a, b, …)` | `"op1"~N~"op2"[~"op3"…]` in the value |
| wildcard | bare `*` / `?` | `*` / `?` in the value |
| not OQL syntax | `~` (fuzzy / slop), `\|` (URL OR-pipe), `\\` (engine escape) | **rejected** — `OQL_NO_FUZZY` / `OQL_CHAR_NOT_OPERATOR`; these never reach the engine from OQL (#865) |
| boolean | infix `and`/`or`/`not` inside `( … )` (a bare-word run is ONE node, not AND) | the BranchFilter tree |

The gauntlet pins the consequences:

| OQL (`title has …`) | Result |
|---|---|
| `(climate change)` | **a bare-word run = ONE stemmed adjacency-boosted node**, NOT climate AND change. The everyday default. Use explicit `and` for two separate nodes. |
| `"climate change"` | **quotes = exact adjacent phrase**, no stemming (`.search.exact`) |
| `stemmed "whopper junior"` | **`stemmed` = stemmed adjacent phrase** → matches "whoppers junior" |
| `"cat"` | quoting a **single** word = exact (no plurals) — quotes always mean exact |
| `cat` | bare word = stemmed (matches cats) — a single bare term is fine |
| `"rock or roll"` | inside quotes = literal: `or` is a word, one exact phrase |
| `climate change or warming` | ✗ `OQL_UNDELIMITED_TERM_LIST` — 2+ bare terms must be parenthesized |
| `(climate and change or warming)` | ✓ resolves by precedence → `(climate and change) or warming` (canonical re-parenthesizes) |
| `"bar*"` | ✓ quoted wildcard = the sanctioned path → no-stem `.search.exact` |
| `bar*` | ✗ `OQL_WILDCARD_NEEDS_EXACT` — bare wildcard is stemmed (wrong); fix-it: quote it `"bar*"` |
| `cancer~1` | ✗ `OQL_NO_FUZZY` — `~` is search-engine syntax OQL does not expose; proximity is `within N (…)`, fuzzy matching is not available yet |
| `dog\|cat` | ✗ `OQL_CHAR_NOT_OPERATOR` — the pipe is classic-URL OR; write `(dog or cat)` |

**No search-engine syntax leaks through a value.** OQL is explicit pseudo-English:
the only value micro-syntax is the table above (quotes, `within N (…)`, `*`/`?`
wildcards inside quotes). Operator characters from other search languages — `~`
(fuzzy / slop), `|` (the classic URL's OR), `\` (the engine's escape character) —
are **rejected with a fix-it** rather than silently passed to the engine with their
engine meaning. (Before #865, `title has (cancer~1)` quietly ran as fuzzy matching;
`^`, `+`/`-`, `{}` and `&&` are literal text at every door since #633.) **Fuzzy
matching is planned; ask us if you're interested.** A classic-URL query that uses
the documented `term~N` fuzzy form still works on the classic door, but it has no
OQL form: its `x_query.oql` leg is `null` with an `oql_unavailable` reason — never
OQL that means something else.

Key rules these encode:

- **The canonical value is always the parenthesized group** — `title has
  (cancer)`, `title has (climate change)`. A single bare term is accepted input
  (`title has cancer` ✓ → canonicalizes to `has (cancer)`); a 2+ word value must
  be parenthesized (`title has climate change` → `OQL_UNDELIMITED_TERM_LIST`) —
  this is the rule that kills the silent
  keyword-truncation footgun. **Inside a `( … )` group** a bare-word run is ONE node,
  so `(climate change or warming)` = `node("climate change") OR
  node("warming")`. **Mixing explicit `and` and `or` at one level resolves by the
  standard precedence AND > OR** — `(climate and change or warming)` =
  `(climate and change) or warming`; the canonical render re-parenthesizes it so the
  grouping is always explicit. (Pure runs — all-`and` or all-`or` — stay flat with no
  inner parens.) A literal reserved word inside a value is quoted as an escape
  (`("road traffic" "and" ghana)` style — the governing law above).
- **Quotes = exact, single word or phrase.** `"cat"` excludes "cats"; `"climate
  change"` is the adjacent, unstemmed phrase. This is the mainstream "quotes = exact
  match" people already expect.
- **`stemmed "…"` = the stemmed phrase** — adjacent *and* lemmatized (`.search`), for
  when you want phrase precision without losing recall.
  Without quotes you don't need `stemmed`: bare terms are already stemmed.
- **Booleans are structural, never lexical.** `has "foo or bar"` searches the
  literal phrase; the boolean is the tree (`has (foo or bar)`).
- **`is similar to ("…")` is semantic** vector search (`.search.semantic`);
  exactly one quoted passage in the group.
- **A `( … )` group holds a boolean of terms** — canonical `has (a and (b or c))`;
  items may themselves be `"exact"` or `stemmed "phrase"` phrases. Groups nest freely
  ([value groups](#value-groups)).
- **A search value runs until the next field-clause.** `title has (a or b) and
  year >= (2020)` is `(title has (a or b)) and year >= (2020)` — the `or` is the
  has-group's, the `and` joins clauses. This is deterministic, not a precedence
  choice: a `year >= …` clause can't live *inside* a `has`, so the value
  boundary is forced. A genuinely mixed and/or *between clauses* resolves by
  precedence AND > OR ([precedence](#booleans-casing-precedence)).

### Proximity and wildcards

```
works where title has (within 3 ("smart", "phone"))     ✓ exact list proximity → .search.exact, value "smart"~3~"phone"
works where title has (within 3 (smart, phone))         ✓ stemmed list proximity → .search
works where title has (within 3 ("foo", "bar", "baz"))  ✓ K-ary proximity (3+ operands)
works where title has (within 3 ("smart", "phone*"))    ✓ wildcard in a quoted operand
works where title has ("foo*bar")                       ✓ mid-word * (quoted = no-stem .search.exact)
works where title has ("wom?n")                         ✓ ? = exactly one char (quoted = no-stem)
works where title has bar*                              ✗ OQL_WILDCARD_NEEDS_EXACT (bare = stemmed = wrong)
works where title has *cycle                            ✗ OQL_LEADING_WILDCARD
works where title has ab*                               ✗ OQL_SHORT_WILDCARD_PREFIX (need ≥3)
works where title has "smart phone" within 3 words      ✗ OQL_PROXIMITY_SUFFIX_REMOVED (write it BEFORE the terms)
works where title has within 3 (smart*, phone)          ✗ OQL_WILDCARD_NEEDS_EXACT (quote a wildcard operand)
works where title has within 3 ("only")                 ✗ OQL_PROXIMITY_NEEDS_OPERANDS (need 2+)
works where title has within 3 (foo, "bar")             ✗ OQL_PROXIMITY_MIXED_OPERANDS (all bare or all quoted)
```

- **Proximity is the leading list form `within N (a, b, …)` — the ONE proximity
  surface:** K operands NEAR each other within an N-word window,
  **unordered**. An operand may itself be a multi-word phrase (`within 5
  ("machine learning", "neural network")`) — each operand is its own
  adjacent sub-phrase. Operands are **all bare (stemmed, `.search`) or all
  quoted (exact, `.search.exact`)** — mixing is `OQL_PROXIMITY_MIXED_OPERANDS`.
  Compiles to an engine intervals query (ordered=false, max_gaps=N); the OQO value
  encoding is `"op1"~N~"op2"[~"op3"…]`. The older *suffix* forms — `"smart
  phone" within 3 words` and the binary `"a" within N words of "b"` — were
  REMOVED and reject loudly (`OQL_PROXIMITY_SUFFIX_REMOVED`) with a
  pointer to the list form. (The classic-URL `~` notation is untouched: a
  single-phrase slop value `"smart phone"~3` still parses/executes via
  `?filter=`, it just has no round-tripping OQL form.)
- On the multi-valued per-record search fields (`raw affiliation` /
  `byline`), a quoted phrase — and each proximity window — **scopes to one
  sub-record** (one affiliation / one byline). This is how a single `has` leaf
  expresses intra-affiliation co-occurrence (e.g. `raw affiliation has (within 5
  (london, hospital))`).
- **Wildcards require the no-stem (exact) field — quote them.** A
  wildcard matches indexed tokens literally, but the default search is *stemmed*
  at index time, so a bare wildcard hunts for a prefix the index no longer holds
  and returns near-nothing (`studies*` = 2.4k stemmed vs 2.2M no-stem). So a wildcard
  on a single token must be **quoted** → it runs on `.search.exact`: `"bar*"`,
  `"foo*bar"`, `"wom?n"`. A **bare** wildcard is `OQL_WILDCARD_NEEDS_EXACT` (fix-it:
  quote it). `stemmed` keeps a phrase stemmed, so a wildcard there is the same error.
  Leading → `OQL_LEADING_WILDCARD`. Sub-3-char prefix → `OQL_SHORT_WILDCARD_PREFIX`.
  In a proximity list the same rule applies per operand: a wildcard needs a
  *quoted* operand. Wildcard-heavy queries share an
  expansion budget: two-plus wildcards each need a ≥4-char prefix
  (`OQL_MULTI_WILDCARD_SHORT_PREFIX`), and past the budget it's
  `OQL_TOO_MANY_WILDCARDS`. Every unsupported combination is a loud
  error with a fix-it — never a silent literal, never a false promise.

> Wildcard-in-a-phrase and wildcard-in-proximity — `"smart* phone"`,
> `within 3 ("smart", "phone*")` — are supported. The floors that remain are
> deliberate guards, not gaps: no leading wildcards, ≥3-char single-wildcard
> prefixes, and the multi-wildcard expansion budget above.

### Null and unknown

`language is (unknown)` / `language is (not unknown)` → `value: null`
(± `is_negated`). Emit `unknown` canonically; accept `null` and `unknown` on
input, bare or parenthesized. `unknown` is also the null sentinel
**inside** a value group, so mixed groups work: `language is (en or unknown)`
= English OR language-unknown ([value groups](#value-groups)). A column value
literally spelled "unknown" is quoted (`is ("unknown")`), on input and output
alike.

### Boolean flags

Boolean (yes/no) columns are ordinary subject-predicate-value clauses, exactly like
every other filter — the subject is the flag's noun and the only values are `true`
and `false`: `open access is (false)`, `retracted is (true)`, `has DOI is (true)`,
`has ORCID is (true)`. They compile to
`{column: …, value: true|false}`. `is not true` / `is not false` / `is (not true)`
are accepted on input and fold into the value, so the canonical form is always
`is (true)` / `is (false)` (never a separate `not`). The group takes exactly one
value — `is (true or false)` is `OQL_GROUP_NEEDS_ONE_VALUE`. There is no
reads-aloud `it's retracted` / `it has a DOI` surface for boolean
flags — One Right Way, shared with all other clauses. (The row-subject pronoun
forms `it cites (…)` / `it's cited by (…)` in
[row-subject verb phrases](#row-subject-verb-phrases) are a different category,
canonical for the relation columns only; they don't reintroduce a boolean
`it's retracted` surface.)

The flag's noun drops any helper verb (`is_retracted` → `retracted`,
`open_access.is_oa` → `open access`); where the bare noun would collide with a
value-bearing field it keeps a short `has` qualifier (`has DOI`, `has ORCID`,
`has abstract`, `has ISSN`) so `DOI is …` stays the exact-DOI string filter.

### Collection membership

```
works where work is in collection (col_abc123)                     (same-type: works in a Collection of works)
works where author is in collection (col_xyz789)                   (cross-type: works by authors in a Collection of authors)
works where country is in collection (col_eu27)                    (predefined country set)
works where work is in collection (not col_abc123)                 (negation: bare not prefix on the value; is not in collection accepted on input)
```

A **Collection** is a named, predefined or user-saved set of entities, addressed by a
`col_<base58>` id (`^col_[A-Za-z0-9]{1,48}$`). Membership is its own operator — distinct
from `is` / `is (…)` — because the intent ("is a member of this named set") and its
value space (a Collection picker) differ from value equality; this keeps the operator→value
model clean for the editor and downstream tooling.

- **Surface:** `<subject> is [not] in collection (<col_id>)` — exactly one
  `col_…` ref in the group (`(col_a or col_b)` is `OQL_GROUP_NEEDS_ONE_VALUE`;
  the bare `… in collection col_id` form stays accepted input). `not`
  negates via the single
  `is_negated` mechanism ([Negation](#negation)), never a separate operator.
- **OQO:** `operator: "in collection"`, `value: <col_id>`, on a leaf. One collection per
  clause; union several via `or` clauses.
- **Same-type** (the Collection is of the queried entity, e.g. works on `/works`): the subject
  is the entity itself and the OQO uses `column_id: collection`, mirroring the dedicated
  `filter=collection:<col_id>` API param.
- **Cross-type** (the Collection is of a *referenced* entity, e.g. a set of authors/countries):
  the OQO keeps the referenced entity's `column_id` (e.g. `authorships.countries`) and renders
  to the bare `filter=<field>:<col_id>` URL surface. `col_…` ids are always preserved verbatim
  (never case-folded), as elsewhere.
- **URL round-trip:** a working prod URL carrying a `col_…` value (`collection:col_…` or
  `<field>:col_…`) parses back to the canonical `is in collection` form, so the triple holds.

### Row-subject verb phrases

```
works where it cites (W123 [Some title…])                          (outgoing edge -> filter=referenced_works:W123)
works where it's cited by (W456 […])                               (incoming edge -> filter=cited_by:W456)
works where it's related to (W789 […])                             (related works -> filter=related_to:W789)
works where title has (foo) and it cites (not W123 or W456)        (composes anywhere; value-level not)
```

A grammar **category**, not a one-off: the subject is the queried row itself — the
pronoun **`it`** — and a verb phrase names a relation column; the value is the usual
parenthesized group. This exists because the citation edge's two directions are verbs,
not nouns: `references is (W)` read as the wrong direction, and the two filters didn't
look like the mirror images they are. The verb pair (`cites` / `cited by`) matches the
GUI chips and the classic input alias `cites:` — one vocabulary across OQL, basic GUI,
and advanced GUI. ([Collection membership](#collection-membership) is the
noun-subject cousin.)

- **Canonical renders (contraction included):** `it cites (…)` → `referenced_works`;
  `it's cited by (…)` → `cited_by`; `it's related to (…)` → `related_to`. In OQO these
  are ordinary `is` leaves on those columns — nothing new at the OQO layer.
- **Forgiving input, one render:** `it is cited by`, `its cited by` (dropped apostrophe),
  the legacy field-word forms (`cites is`, `references is`, `cited by is`,
  `related to is`, plus the raw column ids), and the bare verb forms (`cites (W…)`,
  `cited by (W…)`, `related to (W…)` — for these relation columns the field word IS
  the verb, so a value group directly after it implies `is`) all parse and converge
  on the renders above.
- **Negation is value-level ONLY** ([Negation](#negation)): `it cites (not W123)`. There is
  no `doesn't cite` / `isn't cited by` verb form — leaves stay affirmative;
  `it doesn't …` is `OQL_BAD_VERB_PHRASE` with a fix-it.
- **Word unification:** `referenced_works`'s display word is **"cites"**
  everywhere — filter verb, column header, sort ("references" survives as an accepted
  input alias; `reference count` = `referenced_works_count` keeps its own word). GUI
  chips stay bare: `cites` / `cited by` / `related to`.
- **Classic URLs:** rendered URLs keep `filter=referenced_works:` / `cited_by:` /
  `related_to:` exactly — `filter=cites:` is never emitted (it stays a classic-REST
  input alias only).

## Directives

```
works where year >= 1976 group by topic, year              (multi-dim: spec-level; the live API currently executes a single dimension)
works where … stemmed "genome editing" … sample 500
```

- **`group by <dim>[, <dim>]*`** → `group_by` list (order = dimension order).
- **`sample <n> [seed <s>]`** → `sample` (+ optional reproducibility `seed`).

**Not in the OQL surface — nor in the OQO:** result *sort
order* and *column projection* are view concerns, not query language. They travel
as sibling request params on the execute surface (`?sort=` / `?select=`, or POST
body siblings), populated by the GUI's own sort/column controls — OQL and OQO
never read or emit them. (They are additive to re-introduce in a future version.)

## Diagnostics

Diagnostics are a **language-agnostic contract**: every error
is a stable **code** + a human message + a **fix-it**; consumers (parser, editor,
natural-language layers) share codes and only localize prose. Every error case in
the [corpus](#the-case-corpus) asserts its code.

| Code | When | Fix-it |
|---|---|---|
| `OQL_IMPLICIT_ADJACENCY` | two operands, no connective | insert an `and` or `or` |
| `OQL_MISSING_ENTITY_ID` | entity ref with only a `[name]` | put the ID first: `institution is I136199984 [Harvard]` |
| `OQL_WILDCARD_NEEDS_EXACT` | bare (stemmed) `*`/`?` wildcard — standalone or as a proximity operand | quote it: `"bar*"` (runs on no-stem `.search.exact`) |
| `OQL_NO_FUZZY` | `~` typed in a search value (`term~N` fuzzy, `"phrase"~N` slop) — search-engine syntax with no OQL surface | proximity: `within N (…)`; fuzzy matching is not available in OQL yet — remove the `~` |
| `OQL_CHAR_NOT_OPERATOR` | `\|` or `\\` typed in a search value — classic-URL OR-pipe / engine escape character | write alternatives with `or`; remove a backslash |
| `OQL_LEADING_WILDCARD` | leading `*`/`?` | anchor it: `cycle*` |
| `OQL_SHORT_WILDCARD_PREFIX` | `<3` chars before `*` | add characters: `abc*` |
| `OQL_MULTI_WILDCARD_SHORT_PREFIX` | 2+ wildcards with a `<4`-char prefix | lengthen the prefixes (expansion budget) |
| `OQL_TOO_MANY_WILDCARDS` | too many wildcards in one query | drop some |
| `OQL_PROXIMITY_SUFFIX_REMOVED` | the removed suffix form `X within N words [of Y]` | write it before the terms: `within N (a, b, …)` |
| `OQL_PROXIMITY_NEEDS_OPERANDS` | proximity list with `<2` operands | e.g. `within 3 ("smart", "phone")` |
| `OQL_PROXIMITY_MIXED_OPERANDS` | mixed bare + quoted proximity operands | quote every operand or none |
| `OQL_GROUP_VALUES_NEED_CONNECTIVE` | two values in an `is ( … )` group with no connective (`is (article review)`) | add `or` between the values (or `and` if you mean both) |
| `OQL_GROUP_NEEDS_ONE_VALUE` | 2+ atoms in a scalar-domain group (`year >= (2019 or 2020)`, `is (true or false)`, `in collection (col_a or col_b)`) | keep one value in the parens; combine with or-clauses |
| `OQL_UNTERMINATED_STRING` / `OQL_UNTERMINATED_ANNOTATION` | missing `"` / `]` | close it |
| `OQL_UNKNOWN_FIELD` / `OQL_UNKNOWN_ENTITY` | not in the registry | check the properties registry |
| `OQL_MISSING_OPERATOR` / `OQL_MISSING_VALUE` / `OQL_BAD_NUMBER` | malformed clause | — |
| `OQL_UNBALANCED_PARENS` | missing `)` | add `)` |
| `OQL_BAD_SAMPLE` / `OQL_BAD_PROXIMITY` / `OQL_SEMANTIC_NEEDS_TEXT` / `OQL_TRAILING_TOKENS` | malformed directive/clause | — |

(The engine's diagnostics registry is the authoritative code list.)

## Attributes and values

OQL field names, the columns they map to, value types, and valid operators are owned
by the **properties registry**
([`/properties`](https://api.openalex.org/properties)), **not** by this spec.
Field validity ("is this column valid on this entity? what
value type? which operators?") is a registry question; OQL's grammar is
column-agnostic, exactly as the OQO is.

### Value-domain validation

OQL is **readable in form but strict in validation**: a column whose value is drawn
from a *closed* vocabulary must carry a literal member of that vocabulary. Validation
is not lenient on these — name-based or fuzzy matching is a natural-language
layer's job, never raw OQL. So `country is Canada` (the value is the name, not the
code) and `country is 42` are **errors** (`invalid_value`), not
silently-matches-nothing queries. They are NOT auto-resolved to `ca`; the validator
offers a "did you mean 'ca'?" fix-it but the query is still rejected.

The closed vocabularies (keyed by the property's `entity_type`, validated against the
same vocabulary tables the renderer resolves display names from — a value
validates **iff** it can also be rendered with a name):

| `entity_type` | canonical value form | example valid / invalid |
|---|---|---|
| `countries`   | ISO 2-letter, uppercased | `us`, `gb` / `uk`, `Canada`, `42` |
| `languages`   | ISO 2-letter code        | `en` / `english` |
| `sdgs`        | numeric id `1`–`17`      | `3` / `99` |
| `work-types`  | type slug                | `article`, `review` / `boguskind` |
| `oa-statuses` | status slug              | `gold`, `green` / `sparkly` |
| `continents`  | Wikidata Q-id            | `q15` |
| `domains`     | numeric id (4 total)     | `2` / `99999`, `social sciences` |
| `fields`      | numeric id (26 total)    | `27` / `99999`, `medicine` |
| `subfields`   | numeric id (252 total)   | `2712` / `99999` |

> The topic-hierarchy vocabs (`domains` / `fields` / `subfields`) are small,
> fully-enumerable closed sets, so they validate the same way: `field is 99999`
> (out-of-range) and `field is medicine` (a name) are rejected, with a "did you
> mean '27'?" fix-it for the name.

> `gb` is the ISO code for the United Kingdom; `uk` is **not** a valid code and is
> rejected (the natural-language phrasings "UK"/"Britain"/"United Kingdom" all
> resolve to `gb`).

Membership descends into value groups, so each leaf of `country is (us or canada)`
is checked independently. Free-text `*.search` / `phrase` values and raw strings are
never membership-checked.

### ID-shape validation

The **open** ID entities — authors, works, institutions, sources, publishers,
funders, topics, concepts, awards — have millions of members, so they can't be
enumerated. Instead, an `openalex_id`-typed value is checked for the right
**ID prefix/shape** for the column's `entity_type`. This catches the common slip of
a correctly-shaped ID of the *wrong* type: `institution is W5` is an `invalid_value`
error — `W5` is a Works ID, and `institution` expects an Institutions ID (`I…`). A
non-ID value on an ID column (`institution is Canada`) is likewise rejected.

The shape is **declared once**, in each entity's ID pattern in the engine's
entity registry — there is no hand-maintained prefix table; the native-entity set
and their prefixes derive from those patterns. The OpenAlex URL/path forms a value
may legitimately take (`I5`, `institutions/I5`, `https://openalex.org/I5`) all
validate; only the entity letter is enforced.

| `entity_type` | prefix | `entity_type` | prefix |
|---|---|---|---|
| `works` | `W` | `funders` | `F` |
| `authors` | `A` | `topics` | `T` |
| `institutions` | `I` | `concepts` | `C` |
| `sources` | `S` | `awards` | `G` |
| `publishers` | `P` | | |

> `is in collection col_…` uses a distinct operator (not `is`), so a `col_…` value
> on an ID column is **not** shape-checked. Slug-id entities (`keywords`) and
> numeric-id entities (`fields` / `subfields` / `domains`) have no letter prefix and
> are not shape-checked here.

## The case corpus

This is a **cases-first** specification: the normative truth is a corpus of worked
`(OQL, OQO)` example pairs, machine-checked against the implementation. **The rules
in this prose are the generalization *under* the cases** — when prose and a case
disagree, the case wins. Each case either round-trips cleanly (`ok`), raises a
named [diagnostic](#diagnostics) with a fix-it (`error`), or documents a known
non-representable boundary. The corpus covers real published systematic-review
search strategies, the search gauntlet, the proximity/wildcard matrix, and the
entity/boolean/set cases. You can browse it in the
[cases browser](https://openalex.org/query/oql/cases).

## Out of scope

- **HAVING-style filtering on group aggregates.** OQL must not promise what the
  engine can't execute; group ranking by an aggregate metric is roadmap, not
  language.
- **Multi-dimensional `group by`** is expressible in the spec but currently
  single-dimension in the live API.
- **Acronym / name resolution** and **set-references** are not query-language
  features.

## Conformance

The [round-trip invariant](#the-canonical-triple) is the spec's runnable contract:
a reference implementation is machine-checked over the normative
[case corpus](#the-case-corpus) — every `ok` case must round-trip
`OQO → OQL → OQO` to identity, and every `error` case must raise exactly its named
diagnostic. An implementation conforms if it passes the corpus.

## Related documentation

- **[OQL overview](/access/oql/)** — the readable tour: every construct with a copyable example.
- **[OQO](/access/oqo-schema/)** — the canonical query object OQL is sugar over, with its JSON Schema.
- **[OQL API](/api/oql/)** — executing and translating OQL over HTTP.
- **[Cases browser](https://openalex.org/query/oql/cases)** — the worked-example corpus, browsable.
- **[Railroad diagram](https://api.openalex.org/query/spec/railroad)** — the formal grammar, rendered visually.

## Formal grammar

The grammar below is **derived from the OQL implementation** in W3C-EBNF notation, so it can't drift from what the engine actually parses. A visual [railroad-diagram rendering](https://api.openalex.org/query/spec/railroad) of the same grammar is also available.

```ebnf
/* OQL (OpenAlex Query Language) v2.2 -- reference grammar (W3C-EBNF). */
/* Derived from the implementation and machine-checked against it. */

query        ::= entity ( 'where' conditions )? directive*

entity       ::= word

directive    ::= groupBy | sample | ';'

groupBy      ::= 'group' 'by' word ( ',' word )*

sample       ::= 'sample' NUMBER ( 'seed' NUMBER )?

/* The `where` body is a boolean of clauses joined by infix `and`/`or`; a 2+
   body renders as the implicit-AND list `a and b`, and explicit groups use
   bare parens `(a or b)` / `(a and b)`. */
conditions   ::= operand ( connective operand )*

connective   ::= 'and' | '&' | 'or'   /* '&' is an input synonym for 'and'; canonical render is always 'and' */

operand      ::= 'not' operand
               | '(' conditions ')'
               | clause

clause       ::= determiner? ( valueClause | searchClause )

/* An optional leading determiner 'the' is ignorable input sugar before a
   field name (`the title is foo`), so a clause can read like a sentence. It is
   dropped at parse and never round-trips (the canonical render omits it). It is
   only swallowed when a known field follows -- a semantic guard, not
   grammatical -- so a search value that opens with "the"
   (`title has (the great gatsby)`) keeps it. */
determiner   ::= 'the'

valueClause  ::= field operator value

field        ::= word+

operator     ::= 'is' 'not'? 'in' 'collection'
               | 'is' 'not'?
               | 'is' 'similar' 'to'
               | 'has'
               | ( 'does' 'not' | "doesn't" | 'doesnt' ) 'have'
               | '>=' | '<=' | '>' | '<'

/* The CANONICAL value form is always the parenthesized group -- `type is
   (article)`, `year >= (2019)`; the bare scalar / bare 'unknown' alternatives
   are the accepted-input (lenient) layer only. Scalar-domain operators
   (comparisons, booleans, collection, similar-to) take exactly ONE item in
   their group -- a semantic rule, not grammatical. */
value        ::= valueGroup | 'unknown' | 'null' | scalar   /* a boolean's value is 'true' or 'false' */

/* A value group is a parenthesized boolean of values: `(a or b)` / `(a and b)`,
   nesting freely. Items are joined by infix 'or'/'and' (one separator per
   level); bare adjacency between value items is a loud error, never an
   implicit AND. 'unknown'/'null' inside a group is the null sentinel. */
valueGroup   ::= '(' valueExpr ')'

valueExpr    ::= valueItem ( connective valueItem )*

valueItem    ::= 'not'? ( valueGroup | 'unknown' | 'null' | scalar )

scalar       ::= ( WORD | NUMBER | STRING ) ANNOT?

searchClause ::= searchField ( 'has' | ( 'does' 'not' | "doesn't" | 'doesnt' ) 'have' ) searchExpr
               | searchField 'is' 'similar' 'to' ( '(' STRING ')' | STRING )

searchField  ::= word ( ( '&' | 'and' ) word )*

searchExpr   ::= termRun ( connective termRun )*

termRun      ::= searchOperand+

searchOperand ::= 'not' searchOperand
               | proximity
               | '(' searchExpr ')'
               | searchAtom

/* Proximity is one leading list operator: K (2+) operands within an N-word
   window of each other, unordered. Quotes freeze an operand into an adjacent
   phrase; bare operands stem. (The legacy `within N words` suffix and
   `within N words of` binary forms are not OQL surface syntax; the classic-URL
   `~` notation keeps single/binary proximity unchanged.) */
proximity    ::= 'within' NUMBER '(' term ( ',' term )+ ')'

searchAtom   ::= 'stemmed'? term

term         ::= STRING | word

word         ::= WORD | NUMBER

WORD         ::= wordChar+

NUMBER       ::= [0-9]+

STRING       ::= '"' [#x20-#x10FFFF]* '"'

ANNOT        ::= '[' [#x20-#x10FFFF]* ']'

wordChar     ::= [#x21-#x10FFFF]
```
