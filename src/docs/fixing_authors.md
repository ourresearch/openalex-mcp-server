# Authors

OpenAlex assembles [author](/data/authors/) profiles algorithmically: it takes the author names on hundreds of millions of works and decides which names refer to the same real person. Modern disambiguation is very good, but at this scale it's never perfect — works get attached to the wrong profile, one person ends up split across duplicates, names display wrong.

> [!claude]
> You can do everything on this page in conversation, with no API key: *"Make my OpenAlex author profile accurate"* with your CV attached. Set up once: [Using OpenAlex with an AI assistant](/how-to/ai-assistants/); the mechanics below still apply to what it submits.

Authors are the big self-serve exception to the [ticket-based default](/access/fixing-errors/): **you can fix your own profile yourself, by claiming it.**

## Claim your profile

1. Sign in at [openalex.org](https://openalex.org) (create a free account if you don't have one).
2. Go to your author page: search for your name and open the best match.
3. Click **Claim** near the top of the page.

There are three ways to prove the profile is yours. The first two are instant.

- **A university email on your account.** If any verified email on your account is from a university, a research institute or a government agency, your claim is approved right away. Your account can have several emails: keep your current one and add your university email in [Settings](https://openalex.org/settings). This is by far the easiest way.
- **ORCID.** If the profile carries your ORCID iD, click **Link your ORCID** in the claim window and sign in to ORCID. Your claim is approved right away. Or link your ORCID in [Settings](https://openalex.org/settings/profile): if a profile carries your iD, we claim it for you.
- **A link that shows your email.** Otherwise, send a link to a page that shows the email address of your OpenAlex account: your page on your university's or institute's website, or a paper or preprint that lists that email. A page that shows only your name is not enough, and neither is a page you could make yourself (a personal website, LinkedIn, ResearchGate). Anyone can type any name into an account; the email is the one thing we have checked.

We check every link automatically, usually within a few minutes. Some claims pass with no link at all: when your email is public on the profile's ORCID record, or printed in one of the profile's papers. If we can't approve a claim, we email you what is missing and you can send a new link. Once approved, you own the profile and can curate it.

## What you can fix

Every correction is a [curation](/data/curations/) — an auditable record of who changed what, when. On a profile you've claimed, you can:

- **Add missing works** — search by title, paste a DOI or OpenAlex ID, or upload your CV and we'll match the works in it. (Adds are capped at 1,000 per rolling 24 hours; removals are uncapped.)
- **Remove works that aren't yours** — including in bulk.
- **Remove a wrong name** — if a name variant on your profile isn't you, removing it detaches every work carrying that name.
- **Change your display name** — the name shown on your profile.
- **Change your match name** — the name used to match future works to you (API only).
- **Set or correct your ORCID** (API only). This records the ORCID and makes it your match key for future works; it doesn't move existing works or merge profiles. A wrong ORCID on one of your *papers* is the publisher's record and is corrected with them, not here; see [ORCID](/data/authors/orcid/) and [the how-to](/how-to/fixing-authors/#a-paper-shows-the-wrong-orcid-for-me-can-i-fix-it).

Everything else on a profile — alternate names, institutional affiliations, topics, citation metrics — is *derived* from its works, so you don't (and can't) edit those directly: fix which works belong to you and the rest follows. That cuts both ways: removing a work or a name variant also removes whatever those works alone were contributing, such as an institution that appeared only on them. (Wrong institution showing on one of your works? That's an [affiliation-matching fix](/access/fixing-errors/affiliations/), not an author fix.) The full picture: [Authors § A profile is built from its works](/data/authors/#a-profile-is-built-from-its-works).

Curations don't apply instantly: each one is **pending** until the next data refresh picks it up, and your changes are typically live within about two days. You can track (and cancel) your pending curations from your account.

## Split and merge

The two classic disambiguation failures are **duplicates** (your works spread across two or more profiles) and **wrong merges** (someone else's works mixed into yours). There's no separate merge or split button — both are fixed by moving works, and the moves do the whole job:

- **Merge duplicates.** Say profiles A and B are both you, and you've claimed A. Add all of B's works to A (the CV upload makes this fast). The emptied profile goes **inert**: it stops accruing works and drops out of matching, so it won't grow back.
- **Split out someone else's works.** If another person's works have been merged into your profile, remove them. The disambiguation algorithm re-homes removed works to the right profile — that part isn't your problem.

## Using AI agents

The curation API is designed to be agent-legible, and it authenticates with nothing but your [API key](/api/authentication/) — which means you can hand the whole cleanup to an [AI agent](/access/agents/) instead of clicking through it yourself. Give an agent your key and a prompt like:

```
Here's my CV (attached) and my OpenAlex author ID (A5023888391).
Add my missing works, remove the ones that aren't mine, and set my
display name to "J. García-Martínez". Use the OpenAlex curation API;
docs at help.openalex.org/api/author-curation/.
```

The agent reads your profile, submits the corrections as curations (a `POST` to `/curations` with `Authorization: Bearer <api_key>`), and can poll their status until they're applied. See [Author Curation](/api/author-curation/) for the API mechanics.

## Fixing a profile that isn't yours

Claiming is for your own profile. If you're a librarian, co-author, or research-office staffer cleaning up someone else's profile, [file a ticket](https://openalex.org/contact) — include the author ID, the specific works or names that are wrong, and evidence, per the [good-ticket guidance](/access/fixing-errors/).
