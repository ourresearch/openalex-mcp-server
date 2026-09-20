# Author Curation

OpenAlex assigns [authors](/data/authors/) to works automatically, but sometimes we get things wrong.
Author curation lets you fix that: sign in, tell us what's wrong, and we'll make the change.

This page covers the API mechanics; for the self-serve workflow (claiming your profile, split and merge, using AI agents), see [Fixing errors: Authors](/access/fixing-errors/authors/).

## What you can curate

Five corrections are available. The first two correct the authors attributed to a [work](/data/works/); the rest correct fields on an author profile.

| Action                 | Description                                                |
| ---------------------- | ---------------------------------------------------------- |
| `claim work`           | Assign a misattributed authorship to your profile          |
| `remove from work`     | Detach a work that isn't yours                             |
| `modify display_name`  | Update the `display_name` on your author profile           |
| `modify full_name`     | Update the `full_name` used to match future works to your author profile |
| `modify orcid`         | Set the correct [ORCID](https://orcid.org/) on your profile, or detach a wrong one |

## Submitting a curation

Submit curations to:

```bash
POST https://user.openalex.org/curations
```

The endpoint accepts a single JSON object or an array of objects.

Requests are authenticated with your [API key](/api/authentication/), passed as an `Authorization: Bearer <api_key>` header. Owners of a claimed author profile can curate that profile; site curators and organization owners/curators can also submit.

### Claim a work

"The authorship with name `Smith, J.` on work W4404012345 is me, author A5023888391."

```json
{
  "entity": "works",
  "entity_id": "https://openalex.org/W4404012345",
  "property": "authorships[raw_author_name=\"Smith, J.\"].author.id",
  "action": "replace",
  "value": "https://openalex.org/A5023888391"
}
```

The `property` string anchors the claim to a specific `raw_author_name` from the authorships list in the work. Inside the brackets, the raw author name is wrapped in double quotes and sent byte-for-byte — apostrophes and inner double quotes are not escaped (so a byline like `George "Vern" Yocum` goes in verbatim). The downstream view extracts the name from `property` with this regex, where the capture group is the raw author name:

```
^authorships\[raw_author_name="(.+)"\]\.author\.id$
```

### Remove from work

"Work W4404012345 lists author A5023888391, but that's not me."

```json
{
  "entity": "works",
  "entity_id": "https://openalex.org/W4404012345",
  "property": "authorships.author.id",
  "action": "remove",
  "value": "https://openalex.org/A5023888391"
}
```

The `property` here has no `raw_author_name` anchor — the removal is non-positional and sticky. Every cycle, that author ID is cleared from every authorship on that work, even if the matcher tries to re-attach it.

### Modify display_name

"My author profile A5023888391 should be displayed as `John Smith`, not `J Smith`."

```json
{
  "entity": "authors",
  "entity_id": "https://openalex.org/A5023888391",
  "property": "display_name",
  "action": "replace",
  "value": "John Smith"
}
```

The author's works will be re-synced so the updated name is reflected in the API.

### Modify full_name

"Match works to my profile A5023888391 using the full name `John W. Smith`."

```json
{
  "entity": "authors",
  "entity_id": "https://openalex.org/A5023888391",
  "property": "full_name",
  "action": "replace",
  "value": "John W. Smith"
}
```

`full_name` feeds the matcher (not the displayed profile), so `value` should be one of the author's existing raw author names from a work already on their profile.

### Modify orcid

OpenAlex records an author's ORCID only when it arrives attached to an authorship in the source metadata, so a researcher who has an ORCID but has never supplied it to a publisher won't have one on their profile. This curation lets them set it themselves.

"My author profile A5023888391 is `https://orcid.org/0000-0002-0889-9220`."

```json
{
  "entity": "authors",
  "entity_id": "https://openalex.org/A5023888391",
  "property": "orcid",
  "action": "replace",
  "value": "https://orcid.org/0000-0002-0889-9220"
}
```

To detach an ORCID that isn't yours, use `remove` — and note that `value` is still the ORCID, the one being detached:

```json
{
  "entity": "authors",
  "entity_id": "https://openalex.org/A5023888391",
  "property": "orcid",
  "action": "remove",
  "value": "https://orcid.org/0000-0002-1825-0097"
}
```

Three things to know about the `value`:

- **The canonical form is the full HTTPS URL** — `https://orcid.org/0000-0002-0889-9220` — matching the form of the live [`orcid`](/data/authors/#orcid) field on an author. The API accepts the friendlier variants too (a bare `0000-0002-0889-9220`, an unhyphenated `0000000208899220`, `http://` or `www.`, a trailing slash) and canonicalizes them for you, but the stored value is always the full HTTPS URL.
- **The check digit is verified at submission.** An ORCID carries an ISO 7064 mod-11-2 check character (the last character, which may be `X`). A transposed or mistyped ORCID fails that check and the item is rejected with a `400` rather than being accepted and quietly applied to the wrong profile.
- **`property` is the flat `orcid`**, not `ids.orcid` — ORCID is a top-level author property despite appearing under the `ids` display category.

Like the other author-profile curations, this one is available to the owner of a claimed profile (and to site curators and organization owners/curators). Setting an ORCID does **not** trigger any automatic merging of profiles that share it.

A successful request returns `201` with the saved curation:

```json
{
  "id": "cur-9Fw3RtYxQ7nLpK",
  "user_id": "usr-abc123",
  "user_name": "Casey M",
  "entity": "works",
  "entity_id": "https://openalex.org/W4404012345",
  "property": "authorships[raw_author_name=\"Smith, J.\"].author.id",
  "value": "https://openalex.org/A5023888391",
  "action": "replace",
  "created": "2026-05-13T12:34:56Z",
  "is_applied": false,
  "applied_at": null
}
```

Submitting the same curation twice (matching `user_id`, `entity`, `entity_id`, `value`, `action`) returns the existing row rather than creating a duplicate.

## Who can curate

Curation actions are recorded against the signed-in OpenAlex user account that submits them. Every curation row carries that `user_id`, so the audit trail of "who claimed what" is preserved in the source database even though it is not surfaced on the public API.

## When changes appear

Curations apply on the next end-to-end refresh of the pipeline, which runs once per day. So changes should appear within 24 hours.

## How it flows under the hood

The pipeline has four steps. The first two live in the OpenAlex users API (Heroku Postgres); the last two live in the OpenAlex data warehouse (Databricks / Delta).

1. **Save the request to public.curations**

   The `POST /curations` request lands as one row in the `public.curations` Postgres table on the OpenAlex users API.

2. **Split into views by curation type**

   Views in the users-api Postgres database split `public.curations` into one view per curation type:

   - `work_author_claim_curations`
   - `work_author_remove_curations`
   - `author_display_name_curations`
   - `author_full_name_curations`
   - `author_orcid_curations` (set) and `author_orcid_removals` (detach)

3. **Sync nightly to Delta tables**

   A nightly Databricks job copies each view into a Delta table in the OpenAlex data warehouse:

   - `openalex.works.work_author_claim_curations`
   - `openalex.works.work_author_remove_curations`
   - `openalex.authors.author_names_curations` (one row per author, both name fields joined)

4. **Apply curations**

   Each pipeline run applies the curations to the live entity tables.

   **Work curations** are applied during the works pipeline, between the `MatchAuthors` and `UpdateWorkAuthorships` steps. They modify `openalex.works.work_authors`:

   - A **claim** overwrites the `author_id` at the matching `(work_id, raw_author_name)`.
   - A **remove** sets the `author_id` to NULL at `(work_id, author_id)`.

   Both run every cycle, so a removed author stays removed even if the matcher tries to re-attach it. Every curated `work_id` is queued in `openalex.works.curated_work_ids_pending_sync` so the work re-exports to the search index on the next sync.

   **Author name curations** are applied during the authors pipeline. They modify `openalex.authors.authors`:

   - A **display_name** change overwrites the profile's `display_name`, then queues every work that lists the author in `curated_work_ids_pending_sync` so the new name appears in the API.
   - A **full_name** change overwrites the profile's matching `full_name`.
