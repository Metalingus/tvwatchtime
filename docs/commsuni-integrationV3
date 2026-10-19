# CommsUni.tv — Partner API integration guide

**Audience:** developers integrating CommsUni into a TV/movie tracking app.
**Base URL:** `https://api.commsuni.tv/v1`
**Version:** `v1` (breaking changes ship as a new path prefix; new response fields may
be added inside `v1` at any time — ignore fields you do not know).

**CommsUni.tv** is the shared comments platform this API powers. The **TV Community
Archive** — [tvtime-archive.com](https://tvtime-archive.com) — is its first archival
project: a community-built cache of TV Time conversations, anonymized after the
service shut down. CommsUni evolved from that archive and is built on it; the
frozen `tvtime` layer and live partner-written comments coexist in the same API.
Endpoint paths and request shapes are unchanged — only the host is `api.commsuni.tv`.

The API serves archived TV Time comments, replies, images, and partner-written
community data. Reads and writes are both live: comment and reply creation,
likes, spoiler marks, reports, profiles, ratings, and engagement votes are
available to any partner whose key carries the `archive:write` scope. Build every
integration as a multi-source conversation surface from day one.

**One shared board.** CommsUni is the conversation. Integrating apps are not
expected to run a second public comment board next to it — that duplicates rows
and splits the community. Your app **chooses** to use this surface (and which
screens show it). The **recommended default view** is the full unfiltered board
(omit `?source=`), so users see and reply across apps. Anything that should be
visible to other apps is written here and tagged with your source slug. A "this
app's comments" tab or section is a shortcut to `?source=<your-partner-slug>` on
**that same board**, not a second store. Prefer that filter as a shortcut rather
than the home screen; an app may still land there, but that is discouraged
because it hides other apps' posts. You may keep a
local copy of that filtered layer as a cache, refreshed when a user opens the
thread again — never by periodic scraping (§8). If your product supports app-only
posting, users may choose to keep a comment **app-only** so it never hits this API;
those rows live only in your database, other apps never see them, and they should
be labelled as not shared if you stitch them into the global view (§9).

### Terminology used in this guide

The same three words are used consistently throughout; they are not
interchangeable.


| Term                             | Means                                                                                                                                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **partner** (or **partner app**) | You: the approved app integrating CommsUni. A partner holds an API key, owns one source slug, can read the sources its key is allowed to see, and writes on behalf of its own users.                      |
| **user** (API **actor**)         | One of *your* end users, identified to the archive only by an opaque actor ID. "Actor" in user-facing API/auth sections is just the API's per-user identity label; users never talk to the archive directly. |
| **client**                       | Only ever used in the technical sense — your HTTP client, your typed decoder, your app or device front end. It never means "partner" and never means "user".                                                 |


The archive calls you a partner, not a client, and your users are yours, not the
archive's.

Counted fields throughout this API split two layers. They are not interchangeable
with "partner" or with each other:


| Term          | Means                                                                                                                                                                                                 |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **archived**  | Frozen TV Time data imported into the archive. It does not change. In JSON this is the `archived` half of a split (`likes.archived`, `votes.archived`, …) and the `tvtime` source slug.             |
| **native**    | Live data written through this API by a partner on behalf of a user. It sits on top of the archived baseline. In JSON this is the `native` half of a split; `origin.kind` is `partner`.             |


A like count of `{ archived: 40, native: 2, total: 42 }` is 40 frozen TV Time
likes plus 2 likes added later by partner apps. "Native" never means "this
partner only" — native totals include every partner your key can read.

For conversation and reply counters, use the current/live fields for product UI:
`comments.total`, `replies.total`, comment `replyCount`, reply-list `count`, and
reply-list `total`. Historical/all-time fields exist only so you can inspect what
TV Time reported or debug archived gaps after deleted/moderated tombstones stop
counting as visible activity.

### Source, origin, and similarly named fields

The word **source** appears in several places. They are not interchangeable.


| Name                | Where                       | What it means                                                 | Use for                                                                |
| ------------------- | --------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `origin`            | comment/reply JSON          | `{ kind, slug, displayName }` — where the *comment* came from | Source badges, provenance UI, per-row logic                            |
| `?source=`          | query param on read routes  | Filter by source **slug** (`tvtime`, your slug, …)            | Narrowing lists, engagement, search; "this app's comments" = your slug |
| `GET /v1/sources`   | catalog route               | Branding table keyed by slug (icon, accent colour, status, …) | Mapping `origin.slug` → full display metadata                          |
| `source: "archive"` | comment/reply JSON (legacy) | Fixed constant on every API response                          | **Ignore** for UI and filtering — kept for older clients only          |
| `Origin`            | HTTP request header         | Browser/CORS origin of the caller                             | Your backend proxy must **not** forward this unless explicitly allowed |
| `media.kind`        | inside `comment.media`      | `archive` (B2-hosted image) or `external` (e.g. Tenor GIF)    | Image delivery only — unrelated to comment provenance                  |


**Source slugs** identify a content layer:

- `tvtime` — frozen historical TV Time comments (`origin.kind` is `tvtime`)
- `<partner-slug>` — native comments written by one partner app (`origin.kind` is `partner`)

`origin.kind` is only ever `tvtime` or `partner`. The slug is what distinguishes one partner from another; `kind` is the coarse bucket (immutable TV Time import vs live partner content).

**Rule of thumb:** use `origin.slug` (and `GET /v1/sources` for icons/colours) for "where did this comment come from?"; use `?source=` to filter which layers you fetch. A dedicated in-app comments view for your product is `?source=<your-partner-slug>`, not a separate dataset. Do not use comment `source: "archive"` for either job — it is always the string `"archive"`, even on partner-written comments.

---



## 1. Architecture requirement: call the API from your backend

Your API key is a server credential. It must live on your server and never be
shipped in an app binary, mobile bundle, browser JavaScript, source map, public
config, or anything a user device can read.

```
mobile app  ──►  your backend  ──►  api.commsuni.tv/v1
                 (holds the key,
                  adds the per-user actor ID header,
                  paginates, retries)
```

Your backend is a thin proxy. Everything below — authentication, per-user identity,
pagination, retries — happens there. Build the upstream request from an
explicit header allowlist; do not copy all headers from the device or browser.
In particular, do not forward its `Origin` header. The API validates any `Origin`
it receives and rejects an unapproved value with `403 origin_not_allowed`.

Do not give archive access to unauthenticated guests by default, especially on the
web. Guest traffic has no durable per-user identity, is harder for you to police,
and can burn through your quota quickly. Gate archive-backed screens behind your
own login, or keep any signed-out preview tiny and explicitly rate-limited on your
backend before it can reach the archive API. Guests can never write: every write
route requires a stable per-user actor ID. You are also expected to police what
your users publish to the shared archive; see §10.

### Credentials

Send the key as a bearer token on every request:

```http
Authorization: Bearer tvta_live_<prefix>_<secret>
Accept: application/json
```

Keys are issued out of band, are shown exactly once, and can be rotated or revoked
without notice if leaked. Read the key from your secret store or environment at
startup; do not commit it. Support two valid keys at once in your config if you want
zero-downtime rotation.

Scopes granted to partner keys:


| Scope           | Grants                                                                                                           |
| --------------- | ---------------------------------------------------------------------------------------------------------------- |
| `archive:read`  | comments, replies, single comments, author feeds, entity lookup, conversation stats, engagement, search, sources |
| `media:read`    | media grants and signed image URLs                                                                               |
| `archive:write` | native comments, replies, likes, spoiler marks, reports, profiles, ratings, and engagement votes                 |


`archive:write` does not imply `archive:read`; a write-capable key that also has
to render conversations needs both. A request to a route whose scope you lack is
`403 insufficient_scope`.

---



## 2. Per-user identification: `X-TVTA-Actor-ID` (required)

One API key serves your whole app, so every request must also say **which of your
users** it is for. Send an actor ID on every request:

```http
X-TVTA-Actor-ID: 9f2c1b0a7d3e4f5a8b6c2d1e0f3a4b5c
```

Rules:

- **Derive it on your backend from your own authenticated user identity.** Never let
the app or device pick, send, or influence the value. An actor ID supplied by a
user device is not an identity.
- **Opaque.** Do not send an email, username, phone number, device advertising ID,
or anything else that identifies a person. The recommended value is an HMAC of
your internal user ID with a secret only your backend holds:
`actorId = HMAC_SHA256(secret, internalUserId)` hex-encoded.
- **Stable.** The same user must map to the same actor ID across sessions, app
restarts, reinstalls, and devices. Stability is the whole point — a value that
churns produces meaningless usage data.
- **Format.** ASCII only, matching `[A-Za-z0-9][A-Za-z0-9._:@/-]`*, at most 128 bytes.
A 32–64 character hex or base32 string is ideal.
- **One per end user**, not one per device or per session. If you deliberately allow
a small signed-out preview, use one dedicated constant actor ID such as
`anonymous`, keep that path rate-limited on your backend, and switch to the real
one as soon as the user is known. Shared actor IDs are registered as such and are
rejected on every write route with `400 shared_actor`.

The server stores only a keyed hash of the value, scoped to your partner key. It
cannot be reversed, and the same actor ID sent by a different partner produces an
unrelated hash.

The actor ID is also what makes a read viewer-aware. When it is present, comment
objects carry `viewerLiked` and `viewerMarkedSpoiler` for that user; without it
those fields are omitted entirely.

Reads without the header still work but are attributed to a shared unknown-user
bucket with tighter limits, and come back without viewer state. Writes without it
fail with `400 actor_required`. Treat the header as mandatory everywhere. A
malformed value or a repeated `X-TVTA-Actor-ID` header fails the whole request
with `400 invalid_request`; validate the derived value against the format above
before sending it.

---



## 3. Endpoints

Every successful response that has a JSON body is `{ "data": ... }`; successful
`202` and `204` write responses have no body. Every error is
`{ "error": { "code": ..., "message": ..., "reason"?: ... } }`. The `code` is
the stable category; **`message` is the specific explanation** — always log it
and read it before guessing (many different failures share the same `code`).

### `GET /v1/health`

Unauthenticated liveness probe. Do not poll it on a schedule from app traffic.

### `GET /v1/entities/{entityType}` — resolve a TVDB reference

**Optional.** The comment routes accept TVDB path references directly, so you only
need this if you want to store the archive entity id and skip resolution on later
reads:

```http
GET /v1/entities/episode?tvdbShowId=123456&season=2&episode=5
GET /v1/entities/episode?tvdbId=7654321
GET /v1/entities/season?tvdbShowId=123456&season=2
GET /v1/entities/show?tvdbId=123456
GET /v1/entities/movie?identifier=<movie id>
```

```json
{
  "data": {
    "entityType": "episode",
    "entityId": "461e74b7-a099-4d5b-8da1-bba42393d5a5",
    "tvdbId": "7654321",
    "showTvdbId": "123456",
    "season": 2,
    "episode": 5,
    "title": "Example"
  }
}
```

- **Prefer** `tvdbShowId` **+** `season` **+** `episode`**.** It is the most reliable form. The
`tvdbId` episode form depends on per-episode TVDB IDs that are not populated for
every archived episode, so it can return `404` where the season/episode form
succeeds.
- **Seasons have no TVDB id of their own**, so `tvdbShowId` **+** `season` is the
only form, and the response carries `showTvdbId`, `season` and a `null` `tvdbId`.
- A `404 not_found` means nothing is archived for that reference yet. Treat it as
an empty result, like `404 not_archived` on the comments route, and cache it for
hours rather than forever — a partner's first native comment on a valid TVDB
reference creates the entity, after which the same lookup succeeds.
- Unknown query parameters are rejected with `400` rather than ignored — you will
never get a confidently wrong match.
- The mapping is immutable, so a resolved `entityId` can be stored and reused
indefinitely. The response is `Cache-Control: private, max-age=86400`.
- Costs one `read_unit`, same as a comment page — which is exactly why you should
not call it before every read. Either store the result, or skip this route and use
TVDB path references.

**Movies** are addressed by the archive's movie identifier, which is normally the
TVDB movie id — so `movie/tvdb-1234` works for them. The older
`movie/tvdb:1234` form is supported too. If a movie was archived under a
non-numeric identifier, the TVDB path form will not reach it; use this lookup route
with `identifier=` instead.

If your catalogue is keyed by TMDB rather than TVDB, you need your own TMDB→TVDB
mapping first: the API cannot resolve a title from a TMDB id.

### `GET /v1/entities/{entityType}/{entityId}/conversation`

Read entity-level conversation totals without loading comment rows. Use this for
title-card badges, empty-state copy, or any UI that needs counts before the user
opens the thread.

Path forms match the comments route: TVDB references or archive entity ids both
work and cost one read.

```http
GET /v1/entities/episode/tvdb-289590-s1e1/conversation
GET /v1/entities/show/tvdb-289590/conversation
GET /v1/entities/episode/461e74b7-a099-4d5b-8da1-bba42393d5a5/conversation
```

Optional `source` and `language` filters use the same repeatable or
comma-separated rules as comment reads (`source=tvtime,acme`, `language=it,en`).
No other query parameters are accepted; pass sort, limit, cursor, and include
only to the comment/reply/search routes that document them.

Response:

```json
{
  "data": {
    "entityType": "episode",
    "entityId": "461e74b7-a099-4d5b-8da1-bba42393d5a5",
    "comments": {
      "archived": 37,
      "native": 1,
      "total": 38,
      "allTime": { "archived": 40, "native": 2, "total": 42 }
    },
    "replies": {
      "archived": 10,
      "native": 1,
      "total": 11,
      "allTime": { "archived": 12, "native": 1, "total": 13 }
    },
    "commentsComplete": true,
    "repliesComplete": false,
    "languageCounts": [
      { "language": "en", "base": "en", "count": 22 },
      { "language": "fr", "base": "fr", "count": 12 },
      { "language": "en-us", "base": "en", "count": 4 }
    ],
    "sourceCounts": [
      { "source": "tvtime", "count": 37 },
      { "source": "acme", "count": 1 }
    ],
    "links": { "self": "https://api.commsuni.tv/v1/entities/..." }
  }
}
```

- `comments` and `replies` split currently visible TV Time rows (`archived`) from
currently visible partner-native rows (`native`). `total` is their sum and is
the number to show in product UI.
- `allTime` preserves the former historical count, including deleted/moderated
rows and archived reply totals TV Time reported even when not every reply body
was captured. Treat it as curiosity/debug metadata, not the badge count.
- `commentsComplete` and `repliesComplete` describe archive capture
completeness, not whether native writes can still add rows.
- `languageCounts` and `sourceCounts` are the two filter facets: currently
visible top-level comments per stored language tag and per source slug. Both are
true totals — archived and native rows together, never split — largest first.
`languageCounts` lists only languages with at least one comment.
`sourceCounts` always lists **every** source you can filter on, including those
at `0`, so a source picker shows the whole app ecosystem on every thread; use
the zero to grey out or annotate a chip rather than to hide it. Neither loads a comment:
they read counters the database maintains in the same transaction as every
comment write, delete, and moderation change, so they are current as of the
request and there is no refresh job to wait for.
- **Each facet ignores its own filter and honours the other one**, so a picker
always shows what selecting an option would return. `languageCounts` follows
`source` and ignores `language`; `sourceCounts` follows `language` and ignores
`source`. One call to `/conversation?source=<selected>&language=<selected>`
therefore fills both pickers for the current selection, and unselected options
keep their real counts instead of dropping to zero. The `comments` / `replies`
totals follow `source` only; the size of a `source` + `language` selection is the
sum of the `languageCounts` rows that selection matches.
- `sourceCounts` covers exactly the `GET /v1/sources` catalog, ties in catalog
order; join on `source` = catalog `slug` for names, icons, and colours.
- **Language tags are stored as written, so one language can span several rows.**
`en`, `en-us`, and `en-gb` are separate `languageCounts` rows, while the filter
`language=en` matches all of them. Build a language picker from `base`, not from
`language`: group rows by `base`, sum their counts, and send the base as the
filter value (`language=en`). Offer a locale row (`language=pt-br`) only if your
UI really distinguishes locales — it matches that exact tag and nothing else.
Rendering one chip per raw row shows a fragmented count beside a filter that
returns more comments than the chip promised. Comments written without a
language land in the `unknown` bucket (`base: "unknown"`); `language=unknown`
returns them, alone or combined (`language=it,unknown`).
- `404 not_archived` means the entity was never captured. An archived
conversation with zero comments returns `200` with zero totals.
- **Seasons are no different.** A season that nobody has commented on yet has no
conversation record, so it is `404 not_archived` exactly like an unarchived show —
and a season reference that resolves to nothing at all is `404 not_found`. The
first native comment creates the season and its conversation, and every read after
that is a normal `200`.
- Costs one `read_unit`. Returns `Cache-Control: private, no-store`; do not
treat counts as long-lived cache because native writes change totals at any
time.



### `GET /v1/entities/{entityType}/{entityId}/comments`

`entityType` is `show`, `movie`, `season`, or `episode`. `entityId` **accepts either
a TVDB reference or an archive entity id**, so you can read a conversation with the
identifiers you already hold, in a single request. Prefer the slash-friendly
dash form for new integrations:

```http
GET /v1/entities/show/tvdb-289590/comments
GET /v1/entities/season/tvdb-289590-s1/comments
GET /v1/entities/episode/tvdb-289590-s1e1/comments
GET /v1/entities/movie/tvdb-1234/comments
GET /v1/entities/episode/461e74b7-a099-4d5b-8da1-bba42393d5a5/comments
```

The legacy colon form is also supported:

```http
GET /v1/entities/show/tvdb:289590/comments
GET /v1/entities/season/tvdb:289590:s1/comments
GET /v1/entities/episode/tvdb:289590:s1e1/comments
GET /v1/entities/movie/tvdb:1234/comments
```

A season reference is an episode reference without the `e<episode>` tail. The two
cannot be confused: `season/tvdb-289590-s1e1` and `episode/tvdb-289590-s1` are both
`400 invalid_path`.

A TVDB reference is resolved server-side as part of the same request and is charged
as one read, exactly like the entity-id form. Season and episode numbers may be
zero-padded (`s01e05` and `s1e5` are the same episode). A malformed reference is
`400 invalid_path`; one that matches nothing archived is a `404`.

**You do not need the lookup route or a stored mapping.** Use TVDB references
throughout and it just works. Resolving once via `GET /v1/entities/{type}` and
storing the `entityId` is a valid optimisation — it skips one indexed lookup per
request — but it is not required, and the TVDB form keeps your catalogue free of
archive-internal identifiers.

**Every level carries its own conversation, and they are separate.** A show's
comments are the discussion attached to the series itself, never an aggregate of its
seasons or episodes; a season's comments come only from that season's own reference,
and an episode's only from that episode's. Ask for whichever the user is looking at
— a series page uses `show/tvdb-<show id>`, a season page uses
`season/tvdb-<show id>-s<season>`, an episode page uses
`episode/tvdb-<show id>-s<season>e<episode>` — and never substitute one for another.
The request shape is identical for all four, so one function handles all of them.

**Season conversations are native-only.** TV Time never had season-level comments,
so a season's `archived` count is always `0` and everything you read there was
written through this API. That also means a season reads as `404 not_archived`
until the first native comment on it, the same as any entity with no conversation
record. Everything else behaves normally: pagination, sorting, language filters,
likes, replies, spoilers, ratings and engagement all work the same as on a show or
an episode.


| Query param | Values                                                             | Notes                                                                                                                            |
| ----------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `sort`      | `most_liked`, `most_recent`, `most_relevant`; default `most_liked` | choose the conversation order explicitly if your UI exposes it                                                                   |
| `limit`     | 1–100, default 50                                                  | page size you want                                                                                                               |
| `cursor`    | opaque string                                                      | from the previous page's `nextCursor`                                                                                            |
| `include`   | `media_urls`, `language_counts`, `source_counts`                   | repeatable or comma-separated; the two `*_counts` values add the `languageCounts` / `sourceCounts` filter facets described under `/conversation` (pre-aggregated counters; no comment scan) |
| `source`    | source slug, repeatable or comma-separated                         | optional filter; omit for all readable sources, use `tvtime` for the archive only, or your own slug for the "this app's comments" view of the same board |
| `language`  | BCP-47-ish language tag, repeatable or comma-separated              | optional filter; `en` matches every English locale via the primary subtag, while `pt-BR` matches that exact stored tag; pass `it,en` to combine languages |


**Sorting and filtering happen server-side** over the full conversation — archived
TV Time comments and native partner comments together in one ordered result —
using the Content store's indexed feed columns (`rank_like_count`, `created_at`,
`most_relevant_rank`, `source_id`, `language_base` / `language_tag`, and
partner-scoped partial indexes when `source` excludes `tvtime`). Do not preserve
or emulate any legacy hard-coded "TV Time most-liked" snapshot. New native
comments, replies, likes, spoiler marks, source filters, and language filters all
participate in the same indexed read path:

- `most_liked` (default) ranks by the **combined** like count: the frozen TV Time
baseline plus every native like added since. New likes move a comment up. The
ranking column is refreshed by a background rollup roughly every 30 seconds, so
a like you just wrote is reflected in ordering shortly after, not instantly.
- `most_recent` ranks by comment creation time, so a native comment written a
moment ago is the first row of page one.
- `most_relevant` uses a stored relevance rank where one exists and falls back to
combined likes, then recency. See §12 — it is intentionally simple today.

`source` accepts repeated or comma-separated slugs and is validated against the
live source table: an unknown or inactive slug is `400 invalid_parameter`, never a
silently empty page. Fetch the valid slugs from `GET /v1/sources`. Source filters
are part of the cursor identity and use partner-scoped indexes when they exclude
`tvtime`, so filtering to your own app's comments is a first-class query, not a
client-side post-process.

`language` accepts one or more normalized language tags. Repeat the param or pass
comma-separated values, like `source`. Primary subtags such as `en`, `it`, or `pt`
match `language_base`, so locale variants are included. Locale-specific tags such
as `pt-BR` are normalized to lowercase and match exact `language_tag`.
`language=unknown` selects comments with no recorded language. Malformed values
are `400 invalid_parameter`; repeated tags are deduped, like
`source`. At most eight distinct tags per request. Language filters are part of the cursor identity and are served
by Content post-load feed indexes; do not fake this client-side by fetching pages
and discarding rows.

Current filtering surface:


| Filter                          | Routes                                                                                      | Status                                                                                                                                                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source=<slug>`                 | comment list, reply list, single comment, author comments, conversation, engagement, search | Supported. Repeat it or pass comma-separated slugs. Omit it for all readable sources; use `tvtime` for archived TV Time only; use your own slug for the "this app" view / native engagement layer of the same board.            |
| `q=<text>`                      | comment search only                                                                         | Supported as the search term, not a feed filter. Matches top-level comments for one entity and returns at most 50 results.                                                                                                       |
| `parent=<commentId>`            | reply list only                                                                             | Supported for expanding a specific nested reply branch. It selects which parent thread to list; it is not a general conversation filter.                                                                                         |
| `language=<tag>`                | comment list, reply list, search                                                            | Supported. Repeat it or pass comma-separated tags such as `it,en`. Use a primary tag such as `en` for all English comments, or a locale tag such as `pt-BR` for an exact stored tag. Not accepted on author comments or single-comment reads (extra params on those routes are ignored). |
| media/date/spoiler/viewer state | none                                                                                        | Not supported as filters today. Use returned fields for rendering only; do not fetch pages and discard rows client-side to fake these filters.                                                                                   |




**Ordering:** treat the returned order as authoritative for the selected `sort`.
Do not sort only the comments currently loaded in your app; that creates a
locally re-ordered prefix that changes as the user scrolls. When the user changes
sort, source filters, or language filters, restart pagination from the first page
and discard the old cursor.

**Pagination is snapshot-consistent.** A first page pins a read snapshot (a few
seconds behind now) and the cursor carries it, so a comment written mid-scroll
cannot duplicate or displace rows on later pages. The trade-off is that brand new
content appears on the *next* fresh first-page read, typically within about five
seconds, rather than in the middle of a traversal already in progress.

Response:

```json
{
  "data": {
    "comments": [ /* see below */ ],
    "sort": "most_liked",
    "nextCursor": "eyJwYWdl...",
    "complete": false,
    "languageCounts": [ { "language": "en", "count": 812 } ],
    "links": { "self": "https://api.commsuni.tv/v1/entities/..." }
  }
}
```

Comment object:

```json
{
  "id": "b2c3d4e5-6f70-4a1b-8c2d-3e4f5a6b7c8d",
  "entityId": "461e74b7-a099-4d5b-8da1-bba42393d5a5",
  "source": "archive",
  "origin": {
    "kind": "tvtime",
    "slug": "tvtime",
    "displayName": "TV Time"
  },
  "text": "That finale was unhinged",
  "createdAt": "2020-05-18T21:04:11Z",
  "likeCount": 42,
  "likes": { "archived": 40, "native": 2, "total": 42 },
  "isSpoiler": false,
  "spoilerCount": 1,
  "spoilers": { "archived": 1, "native": 0, "total": 1 },
  "viewerLiked": true,
  "viewerMarkedSpoiler": false,
  "replyCount": 3,
  "replyCountAllTime": 5,
  "parentCommentId": null,
  "inReplyToCommentId": null,
  "rootCommentId": "b2c3d4e5-6f70-4a1b-8c2d-3e4f5a6b7c8d",
  "depth": 0,
  "userId": "8ec04681-0f5d-4925-8f5d-4c6f77d1d4d0",
  "userName": "TV Time user",
  "userColor": "#9ca3af",
  "userAvatar": null,
  "language": "en",
  "rating": null,
  "mentions": [
    {
      "ordinal": 0,
      "userId": "8ec04681-0f5d-4925-8f5d-4c6f77d1d4d0",
      "userName": "TV Time user",
      "userColor": "#9ca3af",
      "start": 0,
      "end": 13
    }
  ],
  "hasImage": true,
  "media": null,
  "attachments": [],
  "imageUrl": null,
  "replies": [],
  "fetchedReplyCount": 0,
  "repliesComplete": false,
  "replyStatus": "missing"
}
```

**Archived-and-empty vs never-archived — these are different:**

- `200` with `comments: []` — the conversation was archived and holds no comments.
- `404` with `code: "not_archived"` or `"not_found"` — nothing was captured for this
entity, or the supplied TVDB reference resolves to nothing archived yet. Show
your "these comments are gone" empty state, cache it for hours, and do not retry
on a schedule. If your app supports native comments, still show the composer:
the first write to a valid TVDB reference creates the entity and the same route
starts returning `200` afterwards.

Notes:

- Author identity for TV Time archive comments is anonymized. `userId` is stable
inside the archive projection and may be used for display grouping or mention
links, but it is not a real TV Time account id. `userName` is a generated display
name, not a real handle.
- **Provenance:** see the **Source, origin, and similarly named fields** table above.
`origin` answers "where did this comment come from?". Render a badge from
`origin.slug` / `origin.displayName`; load icon and accent colour from
`GET /v1/sources` keyed by `origin.slug`. TV Time rows use `origin.slug: "tvtime"`;
partner-native rows use that partner's slug. Ignore the legacy comment field
`source: "archive"` (always the same constant).
- `replyCount` is the current visible reply count for UI. `replyCountAllTime`
keeps the historical/tombstone-inclusive count for diagnostics. Do not use
`replyCountAllTime` for badges, expand buttons, or "show N replies" labels.
- `replies` is the small inline preview. `fetchedReplyCount` is the number of
archived reply bodies available from the replies endpoint; it may exceed
`replies.length` but may also be lower than `replyCount` when native replies are
present. `repliesComplete` says whether the archived reply capture covered the
reported TV Time thread. `replyStatus` is based on archived capture status, not
live reply availability. Fetch replies lazily when the user expands a thread
with `replyCount > replies.length`; skip it when `replyCount` is `0`.
- `parentCommentId` is the structural parent used to group the thread and to call
`GET /v1/comments/{commentId}/replies?parent=...` for nested expansion.
`inReplyToCommentId` is the comment the author actually replied to. It is `null`
for top-level comments and usually equals `parentCommentId` for direct replies,
but it can differ when a deeper reply is flattened into the depth-2 display
level. Store and render both: use `parentCommentId` for tree placement, and use
`inReplyToCommentId` for "replying to" labels, mentions, notifications, and
jump-to-target behavior.
- `media` is described in §4, and `attachments` is the array form of the same
objects — `media` is simply `attachments[0]` or `null`. A comment carries at
most one attachment today, so most integrations only need `media`. Fields other
than those listed may appear; ignore them.
- `imageUrl` is a compatibility mirror. It may be an external GIF URL or, with
`include=media_urls`, a signed URL that expires in about five minutes. Never
persist it; prefer the structured `media` object.
- `mentions` contains resolved, structured mention spans when they are available.
Render these spans as mention links/chips using the supplied `userId` and
display label instead of re-detecting `@name` text. **The read shape and the
write shape differ:** reads return `{ ordinal, userId, userName, userColor, start, end }`, while a write body sends `{ authorId, start, end, text }`. The
read `userId` and the write `authorId` are the same author identifier. `userId`,
`start`, and `end` may each be `null` for a mention the archive anonymized but
could not attribute or locate. A comment may also contain plain text that looks
like a mention but has no matching structured row; treat that as ordinary text.
- `rating` is the author's own 0–10 score for the entity, attached by the writing
partner when the comment was posted. It is **always present and is `null` when
the comment carries no rating** — which is the case for every archived TV Time
comment, for partners that do not send it, and for tombstoned comments. TV Time
comments have no score here because TV Time only had the BAD→WOW poll (see
`options.starRatings[]` in §3), not a 0–10 number. Render
the badge only when it is a number; there is no "unrated" value inside the 0–10
range, so never coerce `null` to `0`. It is a snapshot frozen with the text, not
a live vote: it does not move the entity rating average, and it never changes
after the write. See §11 for the write side.
- `likeCount` and `spoilerCount` are additive totals. The matching `likes` and
`spoilers` objects split the frozen TV Time baseline (`archived`) from marks
added later by partner users (`native`). `viewerLiked` and `viewerMarkedSpoiler`
appear only when the request carries `X-TVTA-Actor-ID`.

**Frozen rows, living conversations.** Every archived TV Time comment and reply is
immutable: its text, author persona, creation time, `archived` like count,
`archived` spoiler count, and archived reply totals are an import-time freeze and
will never change. That immutability is about the *archived row*, not the *thread*.
The conversation around a frozen row is fully additive and globally mutable:

- Any user of any write-enabled partner can post a **native reply to an archived
TV Time comment or to an archived reply**, even when the archived target is
frozen. Native comments and native replies accept replies the same way. The
target's source does not matter.
- Likes, community spoiler marks, and reports can be added to archived comments
the same way. They accumulate in the `native` half of `likes` / `spoilers`
while the `archived` half stays exactly as TV Time left it.
- Those additions change `likeCount`, `spoilerCount`, the current `replyCount`,
and — for `most_liked` — the position of an archived comment in the returned
order. The historical `replyCountAllTime` is not the UI count.

So a page of comments you fetched an hour ago can be wrong in its counts, its
ordering, its viewer state, and its reply totals, even though not one archived
character changed.
Read it again rather than assuming the archive is static; see §8.

List and single-comment routes return only comments visible to the requesting
source. Hidden, moderated, and deleted comments are filtered out or returned as
`404 comment_not_found`; do not render cached copies after a fresh read says the
comment is gone. A response may carry an explicit tombstone to preserve thread
shape — `deleted: true`, `deletedAt` set, `text: null`, empty `mentions`. Hide it
completely: do not show old text, media, author actions, edit controls, or a
placeholder card. Now that authors can delete their own native comments, expect
these to appear in live threads, not only in historical data.

### `GET /v1/comments/{commentId}`

Fetches one visible comment by id. Use it for deep links, notifications, moderation
workflows, or rehydrating a comment you already store. It accepts the same optional
`source` filter as the list route and returns:

```json
{ "data": { "comment": { /* comment object */ } } }
```

`404 comment_not_found` means the comment is unknown, hidden, or excluded by the
requested `source` filter. The route costs one `read_unit`.

### `GET /v1/authors/{authorId}/comments`

Fetches comments by a non-TV-Time author, ordered `most_recent` (not configurable).
Query params: `limit` (1–100, default 50), `cursor`, and optional `source`. The
author belongs to exactly one source; if you pass `source`, it must include that
slug (a mismatch is `400 invalid_parameter`). `language` is not supported here.
It costs one `read_unit`. This route is for native write integrations, where your
own app's users have durable author ids.

TV Time archive authors are anonymized personas and cannot be read through this
route. Asking for one returns `400 unsupported_author_scope`; do not use this route
to build TV Time user profiles.

### `GET /v1/sources`

Fetches the source branding table. Use it to map `origin.slug` to display metadata
such as display name, short name, accent colour, icon URL, status, and source kind.
This is the full catalog row; each comment carries only the small inline `origin`
object (`kind`, `slug`, `displayName`). Cache the catalog for about an hour and do
not expect every comment response to repeat icon URLs or accent colours.

```json
{
  "data": [
    {
      "slug": "tvtime",
      "displayName": "TV Time",
      "shortName": "TV Time",
      "kind": "tvtime",
      "accentColor": "#1a3a5c",
      "iconUrl": null,
      "status": "active"
    }
  ]
}
```

This route costs one `read_unit`.

### Write endpoints

Writes are live and require the `archive:write` scope. Every write must be made
from your backend, with a stable authenticated `X-TVTA-Actor-ID`; writes with a
missing (`400 actor_required`) or registered shared (`400 shared_actor`) per-user
actor ID are rejected. Write responses are `Cache-Control: private, no-store`. `POST`
writes require an `Idempotency-Key` header so retries do not create duplicates;
`PUT` and `DELETE` routes are naturally idempotent.

Current write routes:


| Method           | Route                                        | Body                                                | Success                       | Notes                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------- | -------------------------------------------- | --------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PUT`            | `/v1/authors/me/profile`                     | `{ "displayName": "...", "avatarUrl": "https://..." }` (`avatarUrl` may be `null`) | `200` `{ data: { authorId, displayName, avatarUrl } }` | `displayName` is 1–64 characters and cannot be blank or contain control characters. |
| `DELETE`         | `/v1/authors/me/profile`                     | none                                                | `204`                         | Clears the display overlay for the current actor (`X-TVTA-Actor-ID`). Existing comments and replies **remain** with the same `userId`; they fall back to the generated persona (`userName`, `userColor`, `userAvatar`). This is not bulk comment deletion and does not anonymize past text — use `DELETE /v1/comments/{id}` per comment for author deletes, or operator moderation for account-wide removal. |
| `POST`           | `/v1/entities/{type}/{id}/comments`          | comment body                                        | `201` `{ data: { comment } }` | Creates a top-level native comment. `{id}` accepts an archive entity id or TVDB dash reference.                                                                                                                                                                                                                                                                                                              |
| `POST`           | `/v1/comments/{id}/replies`                  | comment body                                        | `201` `{ data: { comment } }` | Creates a native reply. The target may be any visible comment or reply, **including a frozen archived TV Time one**.                                                                                                                                                                                                                                                                                         |
| `DELETE`         | `/v1/comments/{id}`                          | none                                                | `204`                         | Author delete for that user's own native comment. Treat success as the comment disappearing from UI.                                                                                                                                                                                                                                                                                                         |
| `PATCH`          | `/v1/comments/{id}`                          | `{ "isSpoiler": <boolean> }`                        | `200` `{ data: { comment } }` | Updates only the current user's own visible native comment. |
| `PUT` / `DELETE` | `/v1/comments/{id}/like`                     | none                                                | `204`                         | Adds or removes the current user's like. A new like requires a visible, non-tombstoned native or archived comment. |
| `PUT` / `DELETE` | `/v1/comments/{id}/spoiler`                  | none                                                | `204`                         | Adds or removes the current user's community spoiler mark. A new mark requires a visible, non-tombstoned comment. Keep this separate from reporting. |
| `POST`           | `/v1/comments/{id}/reports`                  | `{ "reason": "...", "detail"?: "..." }`             | `202`                         | Queues a moderation report for a visible, non-tombstoned comment. Reasons are `spam`, `abuse`, `spoiler`, `sexual`, `illegal`, `other`, `mine_hide`, `mine_claim`; `detail` is at most 1000 characters without control characters. `mine_hide` / `mine_claim` are **only for TV Time archive comments** (`origin.kind` is `tvtime`) the reporter says are theirs and cannot `DELETE`: take it down, or later claim authorship. Sending them on a native or other-partner comment is `400 invalid_reason` — author-delete your own native rows instead. Neither reason hides, deletes, nor transfers authorship on the shared archive; operators triage later. Your app may still hide the row in **your** UI after `202` (see below). One report per actor per comment — pick one intent; a later one is `202` + `Report-Duplicate: true` and is not queued. |
| `PUT` / `DELETE` | `/v1/entities/{type}/{id}/rating`            | `{ "rating": 0..10, "entity"?: { "title", "showTitle" } }` for `PUT` | `204`                         | Sets or removes the current user's **0–10** entity rating. `rating` must be a JSON **number**; a string such as `"7.5"`, a boolean, or `null` is `400 invalid_rating`. Native only — TV Time did not archive a 0–10 score. `PUT` uses the same resolve-or-create rules as a comment write; `DELETE` never creates an entity.                                                                                                                                                                                                                                                              |
| `PUT` / `DELETE` | `/v1/entities/{type}/{id}/engagement/{kind}` | `{ "optionKey": "...", "entity"?: { "title", "showTitle" } }` | `204`                         | Sets or removes one engagement vote (native counts on top of frozen archived option totals). Kinds are `emotion`, `star_rating`, `cast_vote`, `watch_device`, `watch_platform`, `movie_interest`; an unknown kind is `404`. Body uses `optionKey` (or legacy `key`). A `PUT` that creates a new `cast_vote` option needs `character:tvdb-<TVDB character id>` (see **Cast votes** under Entity engagement fields). `PUT` uses the same resolve-or-create rules as a comment write; `DELETE` never creates an entity.                                                                                                                                         |

`DELETE /v1/comments/{id}` removes only that user's own native comment. There is
no partner bulk-delete route. To flag any visible comment — archived TV Time,
another partner's, or your own — use `POST /v1/comments/{id}/reports`.
`mine_hide` and `mine_claim` are **only for TV Time archive comments** — the ones
whose `origin.kind` is `tvtime`. When the user says an archive comment is theirs,
send `mine_hide` (take it down) or `mine_claim` (want to own it later). Both only
queue review. They do not hide the row or transfer authorship on the shared
archive. One report per actor per comment, so choose one: a second report from
the same user on the same comment is answered `202` with a `Report-Duplicate: true`
header and **is not queued**, whatever reason it carries. That header is how you
tell an ownership claim that reached operators from one that was dropped because
the same user flagged the comment months earlier — do not treat a bare `202` as
proof the claim landed, and surface it to the user rather than retrying. A dropped
duplicate still costs one `write_unit`: quota is charged on the request, not on
the outcome, so a client that re-files the same report on every screen open is
paying for nothing.
Until operators act, later reads will still return that comment. You may still
hide it in **your** app after a successful `202` — for that user, or for every
viewer in your product — using your own cache or local suppress list. That
choice is yours; it does not hide the comment for other partners or from the
archive API. Do not scrape the API to build a global takedown list.
These reasons are rejected with `400 invalid_reason` on native comments
(including your own) and on another partner's comments; delete your own native
rows with `DELETE /v1/comments/{id}`, and report others with `spam`, `abuse`,
`spoiler`, `sexual`, `illegal`, or `other`. See §10 for the moderation model; this section is the endpoint reference.

A replayed `POST` — same `Idempotency-Key`, same route target, same body — returns the original
result with an `Idempotency-Replayed: true` header instead of writing again. The
same key with a different target or a *different* body is `409
idempotency_key_reused`; the entity or target comment counts as part of comment,
reply, and report requests, so a reused key cannot silently move an action to a
different title or thread. Generate one key
per user action, not per retry. Retrying a report on its original key is safe and
keeps its verdict: if the first attempt was answered `Report-Duplicate: true`, the
replay carries that header too, so a retry never turns a dropped claim into what
looks like a queued one.

Reply depth is capped at two stored levels and the server does the flattening:
reply to a depth-2 comment and the new row is stored at depth 2 under the same
`parentCommentId`, with `inReplyToCommentId` pointing at what the user actually
answered. Your UI does not need to pre-compute this — post to whatever the user
tapped and render what comes back.

Comment body:

```json
{
  "text": "That finale was unhinged",
  "language": "en",
  "isSpoiler": false,
  "rating": 8.5,
  "mentions": [
    {
      "authorId": "8ec04681-0f5d-4925-8f5d-4c6f77d1d4d0",
      "start": 0,
      "end": 13,
      "text": "@TV Time user"
    }
  ],
  "attachments": [
    {
      "url": "https://media.example.com/comment/abc.webp",
      "contentType": "image/webp",
      "provider": "example"
    }
  ],
  "entity": {
    "title": "Episode title",
    "showTitle": "Show title"
  }
}
```

Rules:

- `text` is 1–8000 characters, and cannot contain control characters. The exception is
an image- or GIF-only post: `text` may be omitted, `null`, or `""` when
`attachments` has at least one item. A comment with neither text nor an
attachment is `400 invalid_text`.
- `language` is optional; see §12 for the current `unknown` default and detection
options.
- `isSpoiler` defaults to `false`.
- `rating` is optional: the author's own 0–10 score for the entity, taken from
your app's rating for that user and title, attached to the comment at write
time. Omit it (or send `null`) when the user has not rated the title or has not
asked to attach it — omitted means the comment reads back with `rating: null`
and partners must show no badge at all. It must be a JSON **number** from `0` to
`10`; a string, a boolean, or a value outside that range is
`400 invalid_rating`. Values are stored to two decimals, so `7.567` reads back
as `7.57`. It is a good candidate for an opt-in toggle in the composer next to
"mark as spoiler".
- **`rating` is frozen, and separate from the entity rating.** It is fixed at
write time like the text: `PATCH /v1/comments/{id}` accepts only `isSpoiler` and
rejects `rating` with `400 invalid_body`. It also does **not** feed the entity
rating average — that stays the job of `PUT /v1/entities/{type}/{id}/rating`, so
a comment badge can never double-count a vote. If you want both, send both: they
are independent writes. Consequently a user who later changes their rating in
your app will have an older comment still showing the score they gave at the
time, which is the intended reading of the badge ("what I thought when I wrote
this"), and two partners may show different numbers for the same user if only
one of them attaches ratings.
- `mentions` is optional, capped at 3, and must reference existing `authorId`
values. Include structured spans when auto-injecting reply mentions.
- `attachments` is optional and currently capped at 1. Use `attachments`, not
legacy read fields or common typos such as `media`, `image`, `imageUrl`, `gif`,
`mediaUrl`, `attachment`, `image_url`, or `media_url` — sending one of those
keys is `400 invalid_parameter`. When present, each attachment object must
include all three fields: `url`, `contentType`, and `provider`. `provider` is
required — a stable lowercase label for who hosts the image (for example
`klipy`, `tenor`, `tmdb`, or your own app slug such as `myapp`). Omitting
it or sending an empty string is `400 invalid_parameter`. The value must match
`^[a-z0-9][a-z0-9_-]{0,31}$` (1–32 characters). Attachment URLs must be stable
`https` URLs on a host allowlisted for your source, with `contentType` one of
`image/gif`, `image/png`, `image/jpeg`, `image/webp`, or `image/avif`. Avatar
hosts are allowlisted separately from comment media hosts; register both.
- `entity` is only for the first write to a valid but previously unarchived TVDB
reference, so the server can create the entity as part of the write. The same
optional block is accepted on `PUT` rating and `PUT` engagement. Do not call a
standalone entity-create route. `DELETE` rating and `DELETE` engagement never
create an entity — an unresolved reference stays `422 entity_unresolved`.
- `createdAt` is optional on comment and reply writes with `archive:write`.
  Strongly prefer sending the true user-action timestamp as an ISO 8601
  timestamp with an explicit `Z` or UTC offset, e.g. `2020-05-18T21:04:11Z` or
  `2020-05-18T23:04:11+02:00`. Naive datetimes are rejected. When omitted, the
  server uses the current time. Supplied timestamps must be on or after
  `2010-01-01` and not more than 5 minutes in the future. If your live write
  path relies on server time, any queued or replayed request must inject the
  original user-action timestamp before sending it later. Use the same rule on
  **every comment and reply in a thread from day one.** If a parent was already
  synced without `createdAt` (server time), a queued reply with `createdAt` can
  return `400 invalid_created_at` when that timestamp is before the parent's
  stored time — even when the user genuinely replied after the parent offline.
  For those parents, omit `createdAt` on the reply or re-post the parent with
  the original user-action timestamp.
- For a **season** write, `entity.title` is ignored — a season is named for its
number — and `entity.showTitle` is required only when the show itself is also new.
Writing on a season of an already-archived show needs no `entity` block at all.

**Integration testing.** There is no separate sandbox database. To try writes
without touching real catalogue titles, use the shared synthetic reference
`tvdb-900000001-s1e1` (show TVDB id `900000001`, season 1, episode 1). Real
TVDB ids never reach that range, so this will not appear on tvtime-archive.com
or in a normal in-app show search — only when you call the API with that path.
All partners use the same reference while integrating, so you may see each
other's test comments there; that is fine. On the **first** comment to this
reference, include an `entity` block (`title`, `showTitle`); later writes on
the same path do not. Do not run write smoke tests against real archived show
ids — those comments are live for every partner. You may delete your own native
test rows with `DELETE /v1/comments/{id}` when you are done, or leave some for
other apps to test against.



### Not partner contract routes

`POST /v1/web-sessions` exists for the archive website's own browser access flow.
Do not use it from partner bearer-key integrations.

There is no public partner count-only endpoint today. To show counts without
loading a full page, reuse comment-page metadata you already fetched during a real
user flow, or agree a dedicated count route with the archive operator. Do not add a
long-lived count cache as a substitute for a count endpoint: write-enabled
partners can change totals at any time. A count-only endpoint may be added later
because the server already maintains entity comment/reply stats, but partners
should not depend on an undocumented route.

### Entity engagement fields

Entity engagement uses the same pattern as comment likes: frozen TV Time
baselines plus additive native partner votes on top. Partners can read the
combined engagement payload with `archive:read` and write per-user votes with
`archive:write`.

**Read route (display engagement data):**


| Route                                     | Purpose                                                                                                                                |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/entities/{type}/{id}/engagement` | Returns entity-level ratings and engagement options for emotions, star ratings, cast votes, watch device/platform, and movie interest. |


`{type}` is `episode`, `movie`, `season`, or `show`. `{id}` accepts the archive
entity id or the same TVDB path references as comment routes, for example
`/v1/entities/episode/tvdb:289590:s1e1/engagement`. The route costs one
`read_unit` and returns `Cache-Control: private, no-store`.

**API shape vs archived baseline.** Read and write routes accept **every**
engagement kind on **every** entity type (`show`, `season`, `episode`, `movie`):
`emotion`, `star_rating`, `cast_vote`, `watch_device`, `watch_platform`,
`movie_interest`, plus entity `rating`. That does not mean TV Time archived data
exists for every kind on every type. Empty option arrays — for example
`castVotes: []` on a show or season — are normal when the archive has no imported
baseline for that poll on that entity, not a missing-data bug.

TV Time only scraped engagement polls on **episode** and **movie** main pages.
**Show** and **season** have no archived poll options (cast, emotions, star
distribution, watch device/platform, movie interest). The API still accepts
`PUT …/rating` and other engagement writes on every type, so `rating` and
`options.*` can appear after the first native vote.

| Entity type | Archived poll options (`options.*`) | Archived `rating` (0–10) |
| ----------- | ----------------------------------- | ------------------------ |
| `episode`   | emotions, cast, BAD→WOW star poll, watch device, watch platform | none (native 0–10 only) |
| `movie`     | emotions, BAD→WOW star poll, watch platform, movie interest | none (native 0–10 only) |
| `show`      | none | none (native 0–10 only) |
| `season`    | none | none (native 0–10 only) |

**Two ratings, one of them archived.** TV Time did **not** have a 0–10 numeric
score. Users picked one of five worded buckets (BAD → OK → GOOD → GREAT → WOW).
The API exposes that poll and a separate partner 0–10 field. They are different
systems.

1. **`options.starRatings[]`** — the TV Time rating. Each row is a bucket with
   `label`, `stars` (1–5 catalog order — BAD=1 … WOW=5, not a 0–10 score),
   `count`, and `percentage` (`stars_wording_scalev2`). Archived baselines exist
   on **`episode` and `movie` only**. `show` and `season` stay empty unless
   someone writes native poll votes (`PUT …/engagement/star_rating`). Empty
   `starRatings` on a show is expected: TV Time never collected that poll there.
   Native partner votes on this kind add to the same five buckets.

2. **`rating`** — entity-level 0–10 average + count (`rating.average`,
   `rating.count`, split in `rating.votes`). Partner `PUT …/rating` accepts
   **0–10** on every entity type. There is no TV Time data in this field:
   `rating.votes.archived` is `{ average: null, count: 0 }`, and the average is
   native votes only. A title with no partner 0–10 writes reads as unrated even
   when `starRatings[]` is full. TV Time's old headline number was the 0–5
   average of the BAD→WOW poll — the same data as `starRatings[]`, not a second
   score, and not a 0–10.

This **`rating` object** is unrelated to **`comment.rating`** (§3): that field is
a frozen 0–10 snapshot attached to one comment at post time and never updates the
entity average. Archived TV Time comments always have `comment.rating: null`.

**What to display.** Match the field to the control your app already uses. Do
not merge the two numbers, and do not convert between them (`× 2` or `/ 2`).
That mapping is psychologically skewed: a 4.3 on the five-bucket poll is not an
8.6/10, and a 0–10 halved is not a TV Time star.

- If your app is **five stars**, use `starRatings[]`. Render the five BAD→WOW
  buckets as stars (one star through five). Write with
  `PUT …/engagement/star_rating`. Leave entity `rating` alone.
- If your app is **0–10**, use `rating` for the numeric score and
  `PUT …/rating` to write it. If you also show the archive poll, keep it
  visually separate (word labels or emojis), so it does not look like a second
  0–10.
- Showing both is fine when they stay distinct: poll vs numeric score, not two
  versions of the same scale.

Kind names such as `movie_interest` reflect **TV Time legacy** (that poll existed
on movie pages only). But it's not limited to movies: the API still accepts reads
and writes for every kind on every entity type; archived baselines are what differ
in the table above.

You may hide engagement UI for kinds that do not fit your product on a given
entity type — for example omit `movieInterests` on episodes/seasons even
though the API exposes the field, but keep it on movies/shows — as long as
you handle empty arrays and use the routes that match what you show.

`PUT` rating and `PUT` engagement use the same resolve-or-create path as a
comment write. A season of an already-archived show needs no `entity` block; a
new show, episode, or movie needs `entity.title` (and `entity.showTitle` when
the show is also new). `DELETE` never creates: a vote or rating removal on a
reference that does not resolve yet is `422 entity_unresolved`.

`source` is optional, repeatable, and comma-separated, with the same validation as
comment reads. Unknown or inactive slugs are `400 invalid_parameter`.


| Source filter                  | Returned engagement view                                                                                         |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| omitted                        | Combined readable view: frozen TV Time archived counts plus all native partner counts stored in Content rollups. |
| `source=tvtime`                | Frozen TV Time baseline only. Native counts and viewer native votes are not included. `starRatings` (and other polls) are the archive; entity `rating` is empty because TV Time had no 0–10 score. |
| `source=<partner-slug>`        | That partner source's native layer only. Archived counts are zero unless `tvtime` is also included.              |
| `source=tvtime,<partner-slug>` | TV Time archived baseline plus that partner's native layer.                                                      |


If the request includes `X-TVTA-Actor-ID`, read responses include viewer-specific
fields for that actor when the actor can be resolved for the authenticated
client's source: option rows carry `viewerSelected`, and `rating.viewerRating`
contains the actor's current entity rating or `null`. Without an actor header,
`viewerSelected` is `false` and `viewerRating` is `null`; treat those as
anonymous-read defaults, not proof that a signed-in user has not voted.

Example response shape:

```json
{
  "data": {
    "entity": {
      "type": "episode",
      "id": "11111111-1111-4111-8111-111111111111"
    },
    "source": {
      "filter": [],
      "mode": "all"
    },
    "rating": {
      "average": 8,
      "count": 3,
      "votes": {
        "archived": { "average": null, "count": 0 },
        "native": { "average": 8, "count": 3 },
        "total": { "average": 8, "count": 3 }
      },
      "viewerRating": 8.5
    },
    "options": {
      "emotions": [
        {
          "key": "emotion:1",
          "id": 1,
          "name": "Happy",
          "count": 7,
          "votes": { "archived": 4, "native": 3, "total": 7 },
          "viewerSelected": true
        }
      ],
      "starRatings": [],
      "castVotes": [],
      "watchedOnDevices": [],
      "watchedOnPlatforms": [],
      "movieInterests": []
    }
  }
}
```

**Write routes (store new engagement data):**


| Route                                                         | Purpose                                                                                                                                               |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUT` / `DELETE` `/v1/entities/{type}/{id}/rating`            | Per-user entity rating (0–10, native only).                                                                                                           |
| `PUT` / `DELETE` `/v1/entities/{type}/{id}/engagement/{kind}` | Per-user vote for one option (`optionKey` in body). Kinds: `emotion`, `star_rating`, `cast_vote`, `watch_device`, `watch_platform`, `movie_interest`. |


All of these require `X-TVTA-Actor-ID`, use the same author resolution as comments,
and update native counters in `content.entity_engagement_options` (and per-user vote
rows) without changing archived TV Time totals. Writes never accept a `source`
query parameter or body field; the source is implicit from the API key and actor.
On show or season, a write creates native options from zero when no archived row
existed; use the `optionKey` returned on read (or supply your own for a new option; a new
`cast_vote` option takes only a TVDB character key, see **Cast votes** below).
An `optionKey` must be a non-blank 1–255 character string without control
characters. Do not send both `optionKey` and the legacy `key` alias with different
values; that is `400 invalid_body`.

If your app already has its own emotions, ratings, cast voting, or polls, decide
whether to keep that surface local and use the archive only for comments, or
whether to show the shared archive engagement data too.

For emotions, make that choice deliberately. Archived emotion votes use TV
Time's fixed `12_all` set of 12 options. The API can store other native emotion
option keys, but mixing an app's arbitrary emoji set into the same unlabeled
grid can make the combined counts confusing. An app that adopts shared emotions
should use the returned `emotion:<emotion_id>` options and preserve their labels;
an app with a materially different emoji model should keep it local or present it
as a clearly separate surface.

The archive stores the same archived/native/total split for non-discussion TV Time
stats. Catalog resources such as cast actors, characters, series, movies,
networks, and devices are labels only; the counted identity is the option key on
the stat row.
In the read response, each option's `count` is the combined total and the sibling
`votes` object carries the split:


| Field                  | Option key                              | Notes                                                                                                                                   |
| ---------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `emotions[]`           | `emotion:<emotion_id>`                  | The fixed `12_all` grid.                                                                                                                |
| `starRatings[]`        | `rating:<rating_id>`                    | Archived TV Time rating: BAD→WOW poll, not `rating.average`. Episode/movie only; see **Two ratings** above.                             |
| `castVotes[]`          | `character:tvdb-<TVDB v4 character id>` for new votes; archived rows keep `actor:<actor_id>` or label fallback | One vote per role, not per person. Lists voted characters only, not the full cast; see **Cast votes** below. In archived keys, `actor` means a cast/performer option key, not an API user actor. |
| `watchedOnDevices[]`   | `source:<id>`                           | TV Time "how watched" device/source poll.                                                                                               |
| `watchedOnPlatforms[]` | `network:<network_id>` or slug fallback | TV Time "where watched" platform poll.                                                                                                  |
| `movieInterests[]`     | `answer:<uuid>` or label fallback       | TV Time "why this movie?" interest poll; kind name is legacy — archived answers are usually on `movie` only, but read/write accept any entity type. |
| `rating` (top-level)   | entity-level                            | Partner 0–10 average + count. No TV Time values. See **Two ratings** above.                                                             |


**Cast votes.** A cast vote is for a role, not a person. New votes use a TVDB v4
character id as the key: `character:tvdb-<id>`, for example
`character:tvdb-64178863`. A TVDB character record is one person in one role on
one series, movie, or episode: an actor with three roles has three ids, and a
recast role has two. Each user has one cast vote per entity; a new vote replaces
the previous one.

`castVotes[]` lists only the characters someone has voted for on that entity,
including rows whose count has dropped back to 0. It is not the cast list, and
the API does not serve one. To build the cast menu:

1. Take the cast from your own TVDB data (`characters[]` with `type` 3 Actor or
   4 Guest Star): the movie's cast for a movie; the series main cast for a show
   or season; the series main cast plus that episode's guest stars for an
   episode.
2. Join it to `castVotes[]` on `character:tvdb-<characterId>` for `count` and
   `viewerSelected`. A character with no row has 0 votes.
3. When the user taps a character, send `PUT …/engagement/cast_vote` with that key.
4. Archived TV Time rows (`actor:<n>`, `cast:<slug>`) on older episodes stay in
   `castVotes[]` with their names. They cannot be joined to TVDB characters: show
   them separately or not at all. If a legacy row has neither usable display
   metadata nor an identifier your app can resolve, omit it from the cast UI
   rather than inventing a label; keep its raw key unchanged if you retain it
   for viewer state or removal.

The first vote for a character on an entity creates its option, and the server
checks the key against TVDB: the character must exist, be an Actor or Guest Star
credit, and belong to that entity as in step 1 above (a guest star from another
episode of the same show is rejected). For an episode you address as
`tvdb-<show id>-s<N>e<M>`, guest stars are matched on TVDB's season and episode
numbers, so use TVDB numbering. Later votes on an existing option skip the
check, so every `optionKey` a read returns stays votable whatever its shape.

Rows created this way carry ids only: `provider: "tvdb"`, `characterId`, and
`peopleId`, with `name: null`, `role: ""`, `imageUrl: null`, and `actorId: null`.
Resolve names and images from TVDB by id.

```json
{
  "key": "character:tvdb-64178863",
  "actorId": null,
  "provider": "tvdb",
  "characterId": "64178863",
  "peopleId": "252633",
  "name": null,
  "role": "",
  "imageUrl": null,
  "count": 3,
  "votes": { "archived": 0, "native": 3, "total": 3 },
  "viewerSelected": false
}
```

Errors on a `PUT …/engagement/cast_vote` that creates a new option:

| Status | Code                 | What to do |
| ------ | -------------------- | ---------- |
| `400`  | `invalid_option_key` | The key is not `character:tvdb-<id>`. Fix the key; do not retry unchanged. This rule is rolling out: until it is enforced, other keys are still accepted for new options, so switch now. |
| `422`  | `invalid_option_key` | TVDB has no character with that id, it is not an Actor or Guest Star credit, or it does not belong to this entity; `error.message` says which. Do not retry unchanged. |
| `422`  | `invalid_option_key` | *"This entity has no TVDB id, so new cast options cannot be checked against TVDB."* The archived title has no TVDB mapping, so no key can be validated on it. Show a "voting not available for this title" state; do not retry, and do not re-address the title by a TVDB reference to work around it. Existing options on that entity still take votes. Ask the operator to map the title if it matters. |
| `429`  | `quota_exceeded`     | Your key created too many new cast options this minute. The TVDB check has its own per-key, per-minute limit, separate from the write quota. Honour `Retry-After`. |
| `503`  | `tvdb_unavailable`   | TVDB could not be reached to check the new option. Retryable: honour `Retry-After`. Votes on existing options are unaffected. |

**Migrating existing cast votes.** If you already created cast options with keys
you invented (`actor:tvdb-…`, `actor:<peopleId>`, `cast:<name>`, …), nothing you
have breaks; only the *creating* write changes. The enforcement date is announced
separately by the operator.

| What your app does today | After enforcement |
| ------------------------ | ----------------- |
| Votes and unvotes on an `optionKey` a read returned — archived `actor:<n>`, or an option your app or another partner created | **Works**, unchanged. |
| Keeps voting on your own invented keys on entities where those option rows already exist | **Works**, but those counts stay separate from `character:tvdb-` counts. |
| Creates a new option with any key other than `character:tvdb-<id>` — new entity, or a character with no row yet | **Fails** with `400 invalid_option_key`. Until the enforcement date the same write is still accepted, so you have time to switch. |
| Reads `castVotes[].actorId` / `name` / `imageUrl` | Unchanged on existing rows. New rows add `provider`, `characterId`, `peopleId`, and have `actorId`, `name`, `imageUrl` as `null` and `role` as `""` — see **Typed model decoding** below. |

Old and new keys are **not merged**: the same role can appear as two rows with
two counts on one entity, one archived or partner-invented and one
`character:tvdb-<id>`. Show them as two groups if you show both, and do not sum
them into one "role" total. Do not rewrite users' saved votes, and do not
`DELETE` an old vote and `PUT` a new one to "migrate" it — that moves a user's
choice without them asking. Converting old keys is the operator's call.

The public partner `GET /v1/entities/{entityType}` lookup route does not return
engagement payloads. Use `GET /v1/entities/{type}/{id}/engagement` when you need
to render combined totals in-app.

### Typed model decoding

New fields may be added, so your decoder must ignore unknown keys. Missing and `null`
also have different meanings; model both where shown:


| Field                                                                          | Contract                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `comment.createdAt`, `comment.userAvatar`, `comment.media`, `comment.imageUrl` | Present but may be `null`.                                                                                                                                                                                                                                                                                                        |
| `comment.origin`                                                               | Present on every current read; parse defensively anyway. Use `origin.slug` for provenance; ignore comment `source: "archive"`.                                                                                                                                                                                                    |
| `comment.mentions`                                                             | Present but often empty; when non-empty, treat the spans as authoritative. `userId`, `start`, and `end` may individually be `null`.                                                                                                                                                                                               |
| `comment.viewerLiked`, `comment.viewerMarkedSpoiler`                           | Omitted entirely when the request carries no `X-TVTA-Actor-ID`. Model as optional, not as `false`.                                                                                                                                                                                                                                |
| `comment.media.bytes`                                                          | May be `null`, even when `media` is present.                                                                                                                                                                                                                                                                                      |
| `data.languageCounts`                                                          | Omitted unless `include=language_counts` is requested on the comments route. Counts come from pre-aggregated `entity_comment_language_stats` (maintained at import and on native comment writes) — a cheap indexed read, not a scan of every comment. Respects the same `source` filter as the list when source ids are narrowed; ignores `language`. Each row carries `base` — group by it when building a picker (see `/conversation`). |
| `data.sourceCounts`                                                            | Omitted unless `include=source_counts` is requested on the comments route; then always an array with one row per catalog source, zeros included. Visible top-level comments per source slug from the same pre-aggregated counters. Respects the `language` filter and ignores `source`, mirroring `languageCounts`. |
| `grant.url`, `contentType`, `width`, `height`                                  | Present only when available; `url` is expected only for `status: "granted"`.                                                                                                                                                                                                                                                      |


Use optional/nullable model properties rather than defaulting missing values to
empty strings or zero. Treat enum values defensively: handle the documented values
explicitly and retain an unknown fallback.

### `GET /v1/entities/{entityType}/{entityId}/comments/search`

Same path forms as the comments route — TVDB reference or entity id — and the
same response shape. Takes `q` (max 256 chars) and optionally `include=media_urls`.
It costs three `read_unit`, so more expensive than a default sorted comment page.

- It is a case-insensitive substring match over **top-level comments only**,
scoped to that one entity. Replies are not searched.
- It is not paginated: at most 50 matches come back, ordered by combined like
count then recency, with no cursor and no way to request more. `sort` and
`limit` are not accepted here.
- Native partner comments are searched alongside archived ones, and the optional
`source` and `language` filters narrow the set the same way they do on the
list route.
- Queries shorter than two characters and queries with no matches both return
`200` with an empty `comments` array, not a `404`, so better block short queries.
- Only `include=media_urls` is effective; `include=language_counts` is ignored.

Call it on explicit user intent, not on every keystroke.

Search can be temporarily disabled for maintenance. In that case this route returns
`503` with `error.code: "comment_search_unavailable"`. Treat it as a search-only
maintenance state: keep comment lists working, show a small "search is temporarily
unavailable" message when the user attempts search, and do not retry on every
keystroke.

### `GET /v1/comments/{commentId}/replies`

`sort` is `most_recent` (default) or `most_liked`. Query params are `sort`, `limit`,
`cursor`, optional `parent`, optional `source`, and optional `language`.


| Query param | Values                      | Notes                        |
| ----------- | --------------------------- | ---------------------------- |
| `sort`      | `most_recent`, `most_liked` | default `most_recent`        |
| `limit`     | 1–100, default 50           | same cap as comment lists    |
| `cursor`    | opaque string               | from `nextCursor`            |
| `parent`    | comment UUID                | expand a nested reply branch |
| `source`    | source slug                 | same rules as comment list   |
| `language`  | BCP-47-ish tag, repeatable or comma-separated | same rules as comment list   |


```json
{
  "data": {
    "replies": [ /* comment objects */ ],
    "count": 3,
    "total": 3,
    "allTimeTotal": 12,
    "complete": true,
    "sort": "most_recent",
    "nextCursor": null,
    "replyCounts": { "archivedTotal": 12, "archivedStored": 3, "native": 0 },
    "archiveComplete": false
  }
}
```

**This endpoint returns the currently visible replies it has, and never errors on
an incomplete TV Time capture.** Threads were captured to different depths: some
completely, some partially, some not at all. Current visible counts are separated
from all-time/archive diagnostics.

- `count` — active, non-deleted replies in this response. A tombstone can still
appear in `replies` to preserve thread shape, but it does not count.
- `total` — active, non-deleted replies in this thread for the current filters.
This is the number to show in UI.
- `allTimeTotal` — optional historical/debug count. It preserves the older
inclusive meaning: TV Time's reported total, stored archived rows, native reply
counter history, deleted tombstones, and moderation removals can all make it
larger than `total`. Do not use it for badges or expand labels.
- `complete` — `true` when nothing is known to be outstanding and there is no
`nextCursor`. With `source` or `language` filters, `complete` means the filtered
page sequence is finished, not that every reply in the unfiltered thread was
returned.
- `nextCursor` — present when another page is available.
- `replyCounts` — `archivedTotal` / `archivedStored` describe how much of the
reported TV Time thread was captured. It is archive-health metadata. Do not use
it as a live reply count, and do not use `replyCounts.native` to decide whether a
thread has partner replies; look at `origin` on the rows.

So `count: 3, total: 3, allTimeTotal: 12, complete: true` means three active
replies are visible now, while the historical/archive record still knows about a
larger reported or tombstone-inclusive total. Render the three and treat the
thread as complete unless `nextCursor` is present. If you expose archive/debug
details, label `allTimeTotal` and `replyCounts` clearly so users do not mistake
them for missing live replies. A comment with nothing visible returns
`replies: []` with `200` — an empty thread, not an error.

A thread is never closed: a native reply can be added under any archived comment
or archived reply, and it comes back from this route interleaved with the
archived ones under the selected `sort`. Archived replies do not carry media, but
native replies may use the same attachment shape as comments. Fetch replies
lazily, when a user opens a thread — not while rendering a comment list. Reply objects use the same comment shape as top-level
comments, including `parentCommentId`, `rootCommentId`, `depth`, and
`inReplyToCommentId`. When `parentCommentId` and `inReplyToCommentId` differ, keep
the reply visually under `parentCommentId` but attribute the reply action to
`inReplyToCommentId`.

Design the reply UI for one visible nested level under a top-level comment. A
reply can itself have direct replies; asking for those sub-replies is a separate
request using the `parent` parameter. Keep the interface clean by showing a nested
"show replies" affordance only when the reply reports sub-replies, rather than
rendering empty controls on every reply. If your app only supports a flat reply
list or hides images on replies, users will miss nested threads and native reply
attachments — plan UI support for both.

---



## 4. Images

Archived images are stored privately and are only reachable through short-lived
signed URLs. The usual path: fetch a comment or reply page, read each row's
`media` object, then call `POST /v1/media-grants` for visible comment IDs (up to
16 per call) as images enter the viewport. External `media.url` values need no
grant. Three ways to obtain archive signed URLs:

**You do not need to read comments to read media.** If you already hold TV Time
comment UUIDs — for example from your own earlier import, where the text survived
but the images did not — pass them straight to `POST /v1/media-grants` or
`GET /v1/comments/{commentId}/media`. Both are addressed by comment UUID alone and
cost the same whether or not you ever called the comments endpoint. This is the
supported way to backfill images onto comments you already store. `media:read` is
the only scope required.

Comment UUIDs are the archive's identifiers for comments, so an imported UUID
resolves only if it is the original TV Time comment UUID. An ID your own app
generated during import will not match, and there is no way to recover the mapping
after the fact — preserve the upstream UUID on import if you can.

Comments with an image expose it as (`media.kind` describes image hosting, not
comment provenance — see the terminology table above):

```json
"media": {
  "kind": "archive",
  "contentType": "image/jpeg",
  "bytes": 148231,
  "apiUrl": "https://api.commsuni.tv/v1/comments/<id>/media"
}
```

Some comments instead carry an externally hosted media/GIF, which needs no grant and costs nothing extra — load the URL directly:

```json
"media": { "kind": "external", "provider": "tenor", "url": "https://media.tenor.com/....gif" }
```

`media: null` means there is no displayable image, even if `hasImage` is true.

External media hosts are allowlisted per source, and separately for comment media
and for profile avatars. Shared media providers such as Tenor/Klipy/Yandex can be
approved centrally. If your users attach media hosted on your own CDN or another
image/GIF service, tell the archive operator the exact hosts so they can be
registered for your source; an unregistered host is `400 invalid_parameter` on a
comment write and `400 invalid_avatar_url` on a profile write. Partner-hosted URLs
must be stable `https` URLs that your app controls and moderates. Native uploads into the archive's own bucket are not (yet?) offered: store uploads on your existing CDN and the API keeps that URL for every reader once the host is allowed. If you know another widely used GIF/image service that should be shared across partners, propose it rather than routing around the allowlist.

### 4a. Batch grants — `POST /v1/media-grants` (preferred)

```json
{ "commentIds": ["b2c3d4e5-...", "c3d4e5f6-..."] }
```

At most **16 IDs** per call, unique, UUID format.

```json
{
  "data": {
    "requestId": "…",
    "expiresAt": "2026-07-30T12:34:56Z",
    "grants": [
      {
        "commentId": "b2c3d4e5-…",
        "status": "granted",
        "url": "https://media.commsuni.tv/…",
        "contentType": "image/jpeg",
        "width": 1280,
        "height": 720
      },
      { "commentId": "c3d4e5f6-…", "status": "missing" }
    ]
  }
}
```

Use `width` and `height`, when present, to reserve layout space before loading.
The batch-level `expiresAt` applies to its granted URLs.

Request grants **only for images that are about to be displayed** — batch the visible
window as the user scrolls, not the whole page. Each issued URL is charged.
`missing` usually means no image exists, but can also represent a temporary signing failure. Render the comment without an image (have a placeholder), cache the result for hours, and re-check slowly rather than retrying in a loop.

### 4b. Single image — `GET /v1/comments/{commentId}/media`

Returns `302` to a signed URL. `HEAD` is also supported. Useful when you need exactly
one image; wasteful for lists.

**Do not let your HTTP client follow this redirect with the** `Authorization` **header
attached.** The redirect target is a different host and needs no credential. Either
disable automatic redirects and fetch the `Location` yourself, or verify your client
strips auth headers across hosts.

### 4c. Inline — `?include=media_urls`

Adds `signedUrl` and `expiresAt` to every ready `media` object in a comments or search
response, and charges one grant per image in the page whether or not the user ever
sees it. Only use it for small pages you know will be rendered in full.

### Handling signed URLs

- They expire in about **5 minutes**. Treat them as one-shot.
- **Never cache or persist a signed URL**, and never store one in a database row or
ship it into a long-lived client-side model. Cache the *image bytes* in your normal
image cache instead, keyed by comment ID.
- If a URL expired before the image loaded, request a fresh grant — do not retry the
expired URL.
- Delivery URLs may be served from `media.tvtime-archive.com`, `media.commsuni.tv`, or
another archive-operated host. Treat the hostname as opaque: fetch any `https` URL the
API returns for archive `kind` media. Do not hardcode or allowlist a single delivery
host — both domains may be valid during a migration.
- The image objects themselves never change, so once the bytes are cached they can be cached for a very long time. In case they change, operator will tell partners to purge their cache.

---



## 5. Pagination

Always paginate comments and replies. Never try to pull a whole conversation or a
whole reply tree in one request.

- Send `limit` (≤ 100). **Do not assume the response contains exactly** `limit`
**items** — treat the returned array length as the truth and render what you get.
- Advance only with `nextCursor`. Cursors are opaque: do not parse, construct, or
persist them beyond the current browsing session.
- Stop when `complete` is `true` or `nextCursor` is `null`.
- If following a valid `nextCursor` returns `404 not_archived`, the remaining pages
were not captured. Stop and keep all pages already rendered; treat that traversal
as complete.
- A cursor is valid only for the route, entity/comment, `sort`, `source`,
`language`, `limit`, and read snapshot that issued it. When any of those
change, restart from the first page. Because the snapshot is pinned, a
traversal in progress will not show comments written after it began; a fresh
first-page read will.
- **Do not re-sort a fetched page in your app.** Re-ordering the 50 comments you
happen to hold is not sorting the conversation — the server sorts the whole
conversation, archived and native together — and it produces an order that
changes as the user scrolls. Present them in the order returned.
- Do not prefetch more than one page ahead, and cancel in-flight page requests when
the user leaves the screen.

```ts
async function* commentPages(entityType: string, entityId: string) {
  let cursor: string | null = null;
  do {
    let page;
    try {
      // archiveGet validates the envelope and returns response.data.
      page = await archiveGet(
        `/v1/entities/${entityType}/${entityId}/comments`,
        { limit: 50, ...(cursor ? { cursor } : {}) }
      );
    } catch (error) {
      if (cursor && isArchiveError(error, 404, "not_archived")) return;
      throw error;
    }
    yield page.comments;
    cursor = page.complete ? null : page.nextCursor;
  } while (cursor);
}
```

---



## 6. Quotas and rate limits

Successful responses carry:


| Header                | Meaning                                                                             |
| --------------------- | ----------------------------------------------------------------------------------- |
| `RateLimit-Limit`     | Policy description; format varies and may be the literal `policy`. Treat as opaque. |
| `RateLimit-Remaining` | Remaining allowance reported by the active policy; this is the value to monitor.    |
| `RateLimit-Reset`     | Reset hint in seconds; do not treat it as an exact countdown.                       |
| `X-RateLimit-Metric`  | which meter was charged: `read_units`, `media_grants`, or `write_units`             |


Three meters are charged independently:

- `read_units` — one per comment page, reply page, single-comment read,
author-comment page, entity lookup, engagement read, search request,
`GET /v1/sources`, or `POST /v1/media-grants` batch.
- `media_grants` — one per signed image URL issued, by any of the three methods.
- `write_units` — one per native write: comment, reply, profile update, like,
spoiler mark, report, rating, or engagement vote. Each successful write costs
one `write_unit`; a report costs the same as posting a comment. Write limits are
configured per minute and per day, both for the partner key as a whole and per
individual user, so one enthusiastic user cannot exhaust the app's write budget.
Creating a new `cast_vote` option that needs a TVDB check also counts against a
separate per-key, per-minute limit (see **Cast votes** in §3).

A media-grants batch therefore costs one `read_unit` for the request plus one
`media_grant` per URL issued.

Log `RateLimit-Remaining` on your side. When reads trend toward zero, reduce how
often you refetch a conversation rather than retrying harder; when writes trend
toward zero, queue and throttle on your side instead of failing the user's action
outright. Off-peak spam cleanup (`DELETE` or `POST …/reports`) uses the same
`write_units` budget — throttle it locally.

Expose per-user actor-ID limits cleanly in your product. If one user hits an
`actor_rate` / `actor_denied` response, show a local "try again shortly" state for
that action or thread, not a generic broken-screen error and not a global outage.
Do not hide this behind an obscure upstream code; the user needs to understand
that their own recent activity is being limited.

---



## 7. Errors and retries

**Read `error.message`, not just `error.code`.** The code tells you the broad
bucket (`invalid_parameter`, `invalid_body`, …); the message tells you which
field or rule failed. Several distinct validation failures reuse the same code —
for example, `400 invalid_parameter` may mean a legacy `media` field, a missing
`attachments[].provider`, a disallowed attachment host, or an unknown query
parameter. Support and debugging should always include both code and message (and
`X-Request-Id` when present).

```json
{
  "error": {
    "code": "invalid_parameter",
    "message": "attachment provider is invalid."
  }
}
```


| Status | Codes                                                                                                                                                  | What to do                                                                                                                                                              |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `400`  | `invalid_parameter`, `invalid_path`, `invalid_request`, `invalid_content_length`, `malformed_json`, `body_aborted`                                    | Bug in the request, or the body stream ended early. Fix the request; retry `body_aborted` only after checking the transport.                                           |
| `400`  | `invalid_body`, `invalid_text`, `invalid_mentions`, `invalid_reason`, `invalid_detail`, `invalid_rating`, `invalid_created_at`, `invalid_display_name`, `invalid_avatar_url` | Bug in a write request body. Fix the body; do not retry unchanged.                                                                                                      |
| `400`  | `invalid_option_key` | A new `cast_vote` option was sent with a key other than `character:tvdb-<TVDB character id>` (§3 **Cast votes**). Fix the key; do not retry unchanged. |
| `400`  | `unknown_mention`, `reserved_display_name`                                                                                                             | The referenced author or display name cannot be used. Show a specific local validation message.                                                                         |
| `400`  | `actor_required`                                                                                                                                       | A write arrived without `X-TVTA-Actor-ID`. Never retry as a guest.                                                                                                      |
| `400`  | `shared_actor`, `invalid_source`                                                                                                                       | The actor ID is registered as shared, or the key's source cannot write. Do not retry; fix the per-user actor-ID mapping or contact the operator.                        |
| `400`  | `origin_required`                                                                                                                                      | An `OPTIONS` preflight omitted `Origin`; backend proxies should not send preflights.                                                                                    |
| `400`  | `unsupported_author_scope`                                                                                                                             | You tried to list comments for a TV Time anonymized author. Do not build TV Time author pages.                                                                          |
| `408`  | `body_timeout`                                                                                                                                         | A JSON request body timed out. Retry only when the operation is idempotent or carries the same `Idempotency-Key`.                                                       |
| `413`  | `body_too_large`                                                                                                                                       | Reduce the JSON request body; do not retry unchanged.                                                                                                                   |
| `415`  | `unsupported_media_type`                                                                                                                               | Send `Content-Type: application/json` to JSON body routes.                                                                                                              |
| `401`  | `unauthorized`                                                                                                                                         | Key missing, malformed, expired, or revoked. Do not retry; alert.                                                                                                       |
| `403`  | `insufficient_scope`                                                                                                                                   | Your key lacks the scope. Do not retry.                                                                                                                                 |
| `403`  | `source_disabled`                                                                                                                                      | The source linked to the key is disabled and cannot accept writes. Contact the operator; do not retry unchanged.                                                        |
| `403`  | `origin_not_allowed`                                                                                                                                   | Do not forward the app/browser `Origin` header unless it is explicitly allowed.                                                                                         |
| `403`  | `TitleLockedError`                                                                                                                                     | The title is locked and cannot be served. Do not retry or diagnose as a scope failure.                                                                                  |
| `400`  | `idempotency_key_required`, `invalid_idempotency_key`                                                                                                  | A `POST` write omitted or malformed `Idempotency-Key`. Generate one key per user action.                                                                                |
| `409`  | `idempotency_key_reused`                                                                                                                               | The same `Idempotency-Key` was reused for a different target, operation, or `POST` body. Generate one key per user action.                                             |
| `422`  | `entity_unresolved`                                                                                                                                    | First write to an unresolved TVDB reference needs entity title data in the body (`entity.title`, plus `entity.showTitle` when the show is also new). Seasons are named for their number, so a season `PUT`/`POST` can omit `entity.title`. `DELETE` never creates. |
| `422`  | `invalid_option_key` | The TVDB character in a new `cast_vote` key does not exist, is not an Actor or Guest Star credit, or does not belong to the entity — or the entity itself has no TVDB id, so the check cannot run at all (§3 **Cast votes**). Do not retry unchanged; on the last case show a "voting not available for this title" state. |
| `404`  | `not_archived`, `not_found`                                                                                                                            | No archived entity matches yet. Treat as an empty result on a valid entity route or reference; a native write to a valid TVDB reference can turn it into a `200` later. |
| `404`  | `comment_not_found`, `author_not_found`                                                                                                                | The specific comment or non-TV-Time author is unknown, hidden, or excluded by filters.                                                                                  |
| `404`  | `media_not_found`                                                                                                                                      | No image is available for that comment. Respect the response's `no-store` policy and render the comment without an image.                                             |
| `429`  | `quota_exceeded`, `concurrency_limit`                                                                                                                  | Honour `Retry-After`, then exponential backoff with jitter.                                                                                                             |
| `503`  | `enforcement_unavailable`, `access_database_unavailable`, `redis_unavailable`                                                                          | Enforcement or a dependency is unavailable. Serve cache and retry with backoff.                                                                                         |
| `503`  | `archive_writes_maintenance`                                                                                                                           | Write maintenance is active on the archive side; reads keep working. Do not block the composer — accept the action locally, queue the outbound write in your own store (§8), honour `Retry-After`, then drain slowly with the same `Idempotency-Key` and body (§7). |
| `503`  | `write_conflict`, `idempotency_unavailable`                                                                                                            | A write transaction or idempotency claim could not settle after bounded retries. Honour `Retry-After` and retry safely.                                                |
| `503`  | `tvdb_unavailable` | TVDB could not be reached to validate a new `cast_vote` option. Retryable: honour `Retry-After`. Votes on existing options still work. |
| `503`  | `comment_search_unavailable`                                                                                                                           | Search is in maintenance. Keep lists working and show a search-only maintenance message.                                                                                |
| `503`  | `media_signing_unavailable`, `media_metadata_invalid`, `invalid_policy`                                                                                | Media or policy configuration is unavailable. Serve cache and alert if persistent.                                                                                      |
| `5xx`  | `internal_error`                                                                                                                                       | Retry idempotent requests up to ~3 times with backoff.                                                                                                                  |




For `429`, inspect `error.reason` before deciding what to throttle:


| Reason                                       | Response                                                                         |
| -------------------------------------------- | -------------------------------------------------------------------------------- |
| `actor_rate`, `actor_denied`                 | Throttle or deny that user / actor ID, not the whole app.                        |
| `unknown_actor_rate`, `unknown_actor_denied` | Fix the missing actor header; meanwhile throttle the shared unknown-user bucket. |
| `client_rate`                                | Throttle requests for the whole partner key.                                     |
| `daily_budget`                               | Serve cache; short retries will not help before the daily reset.                 |
| `concurrency`                                | Reduce parallel calls and honour `Retry-After`.                                  |


Rules that keep you out of trouble:

- On any `4xx`, surface or log **`error.message`** in your integration tests and
support tooling — do not branch only on status or `error.code`.
- Retry only `429` and `5xx`, and always with jitter. Never retry `4xx` bodies you
caused. `GET` and `POST /v1/media-grants` are safe to retry as-is; a write is
safe to retry only when you resend the **same** `Idempotency-Key` **and the same
body**, which is exactly what the key is for. `PUT` and `DELETE` writes are
idempotent by construction.
- Use a circuit breaker: after repeated failures, stop calling for a cooldown and
serve cached content.
- Set a client timeout (5–10s is reasonable) and cancel abandoned requests.
- Degrade gracefully. A failed archive call should hide the comments section, not
break the screen.
- Log the CORS-exposed `X-Request-Id` when present on enforcement `429` and `503`
responses, and include it in support requests.

---



## 8. Caching and request hygiene

**Caching guidance changed when writes shipped.** The archived TV Time rows are
still immutable, but the conversation built on top of them is not: any partner's
users can add replies, likes, and spoiler marks to any comment at any time, and
those additions change counts, reply totals, and `most_liked` ordering. A long
TTL on a comment page no longer serves stale-but-correct content — it serves a
conversation that has visibly moved on, hides other apps' replies from your users,
and makes your own users' writes look like they did not land. You cannot cache a
conversation once and treat it as complete.

Cache for *deduplication and burst protection*, not for freshness avoidance. The
same short-lived entries may also be served read-only during `503`/`429` outages
or circuit-breaker cooldowns (see §7), but only as degraded fallback — stale
counts, missing recent writes — not instead of refetching when the API is healthy.
Treat comment and reply caches as optional infrastructure around a live product surface:
short enough that users normally see other partners' writes without waiting for a
manual refresh. Seconds to about a minute, not days, for anything that carries
counts, ordering, viewer state, or reply totals. Invalidate (or bypass) that cache
when *any* user of your app writes on a thread, not only when a TTL expires — and
assume other partners' users are writing to the same threads continuously.

The short-TTL rules above apply to cached API read snapshots of **shared** threads
(unfiltered or multi-source). They are burst protection in front of the API, not
your product database.

**Your source layer is still this API.** Comments originated in your app already
live on CommsUni under `source=<your-partner-slug>`. If you keep those rows in
your own database, that store is a **cache of that filtered board**, not a second
canonical comment list. Refresh a thread's copy when a user actually opens it
(navigation, expand, pull-to-refresh) or when one of your users writes there —
never by periodic scraping, catalogue crawls, or background sync of every title.
Do not persist other partners' comments or full cross-app conversations in that
database. The local copy of *your* shared rows is also the continuity fallback if
archive reads are unavailable, and the optimistic/queued write store during
outages (§9).

**If your product supports app-only comments**, they are the exception: a user
choice that never `POST`s to this API. They stay only in your database. Other apps
cannot see them. Do not treat them as a cache of the shared board, and do not
present them as CommsUni comments. If you show them in the same thread as the
shared board, tag them as app-only / not shared (§9).

- **Queue outbound writes during write outages.** When a write returns
`archive_writes_maintenance` or repeated write `503`/`429`s, persist the full
request payload and `Idempotency-Key` in that same local store, show the row
optimistically, and drain the queue after `Retry-After` when the API is healthy.
Throttle drain to respect `write_units` and per-user limits (§6). Other partners
cannot see queued rows until they land.

Partner integrations that always send `X-TVTA-Actor-ID` — as this guide requires —
do not receive `ETag` / `304 Not Modified` on comment pages. Conditional GET is
disabled whenever viewer state is required, so your backend cannot rely on the API
to keep a long-lived page fresh; you must refetch or invalidate locally.

- **Never call the lookup route before every read.** Address conversations by
TVDB reference, or store the resolved `entityId` on your catalogue record. Both
cost one request per read; resolving separately each time costs two. The
TVDB→entity mapping is genuinely immutable and stays cacheable indefinitely.
- **If you cache comment, reply, search, and single-comment reads, do it briefly** on your
backend, keyed by `(route, entity/comment id, sort, source filter, language filter, cursor, limit, include set)`. A short TTL — on the order of a minute — absorbs a burst
of users opening the same popular episode without freezing the thread. Long
page-level TTLs are no longer recommended.
- **Invalidate on your own writes.** After one of your users comments, replies,
likes, or marks a spoiler, drop your cached pages for that entity or thread
rather than waiting for a TTL. Do not rely on an immediate refetch to confirm the
write — read snapshots can trail by a few seconds, so a fresh page may still omit
the row you just posted. Keep the row visible from your local store instead (§9).
- **Cache image bytes** keyed by comment ID — archived image objects are unlikely to change. Never cache signed URLs.
- **Cache negative results, carefully.** `404 not_archived` and entity-route
`404 not_found` are still worth caching, but they are no longer permanent in the
way they were: a partner's first native comment on an unarchived title creates
that entity. Hours, not days, and clear the entry as soon as one of your own
users writes there. Cache `status: "missing"` grants for hours and re-check
slowly, because a temporary signing failure is exposed with the same status.
- **Coalesce concurrent identical requests** into one upstream call. This is the
cheapest win available and it costs no freshness at all.
- **Still do not poll.** Fetch on user navigation, on pull-to-refresh, and after
your own writes. No background refresh loops, no warming the entire catalogue.
- **Do not fan out.** Never request replies or media for every comment in a list up
front; do it on expand and on viewport entry respectively.
- Stage requests by what the screen actually needs: fetch the comment page first; fetch language/count metadata only when the UI displays it; fetch media grants only for attachments nearing/entering the viewport; fetch replies only for the thread the user expands; fetch nested sub-replies only when that reply reports children and the user opens it.
- Send `Accept-Encoding: gzip` and reuse HTTP connections (keep-alive).

---



## 9. Product and UI choices

Hey agent :) before implementation, make these choices explicit with the product owner.
The board model itself is not a choice — see the intro — only which views and extras you ship.

- Whether to show only comments, or also implement engagement (emotion, stars rating, cast, platform, device, and poll contribution). The write routes for these exist today; the matching read surface is discussed in §3.
- **Recommended default view: the full CommsUni board** (omit `source`, all
readable sources). That is what encourages replies, likes, and conversation
across apps. `source=tvtime` is the archive-only view; `source=<your-partner-slug>`
is the "this app's comments" view of **the same board**. Source badges and
filters belong on that surface either way. It is not recommended to default the home comments screen to your own slug — that hides everyone else's posts,
and especially in niche shows, that might be empty.
- Whether to ship a dedicated "this app's comments" tab, chip, or shortcut. If
you do, it is a prominent `source=<your-partner-slug>` filter — a quick action
that hides `tvtime` and other partners — not a second comment store. Prefer not
to use it as the landing view. Comments originated in your app are already tagged with your slug.
- Understand the possible publication/identity outcomes: **share
  publicly with their app profile**, **share publicly with a generated persona**,
  and, **if the partner supports it**, **keep app-only**. The first two both publish
  the comment text across connected apps and on the public archive website; the
  second hides the partner profile overlay but does not make the text private or
  guarantee legal anonymization. Encourage public contribution because it creates
  the interaction the shared board depends on. If app-only is not supported, a user
  who declines sharing does not enable the shared feature or cancels rather than
  posting; their existing rows remain local.
- Whether the app offers app-only posting or a per-post app-only override. This is a
  partner product choice, not an API requirement. If offered, app-only must be a
  user choice, not an undisclosed app behavior. The composer must make the difference
  obvious before send: shared posts go to CommsUni and other apps; app-only posts stay
  in your database and other apps never see them. App-only means far less visibility
  and fewer interactions. Do not backfill app-only rows unless the user later enables
  sharing with consent that covers existing comments.
- If you offer app-only, **how same-app users see them.** Those rows are not in
API responses, so other users of your app only see them if **you** render them.
The recommended pattern is to stitch them into the global (unfiltered) CommsUni
view with a clear **app-only / not shared** tag, so they sit in the same thread
without looking like CommsUni comments. Alternatively keep them only on the
"this app" screen if present, still tagged. Never mix them in unlabelled.
- Whether to show archived TV Time baselines separately from live totals. Optional
product choice: the API already splits frozen TV Time activity from current
cross-partner counts — comment `likes` / `spoilers`, entity engagement
`votes.archived`, conversation `allTime`, comment `replyCountAllTime`, and
reply-list `allTimeTotal` / `replyCounts`. Default UI should show the current
combined totals; historical/all-time values are for labeled archive details or
debugging.
- Sharing consent may cover both future posts and existing original comments/replies
  when that scope is disclosed. App-only posting remains optional for the partner.
  For historical eligibility, consent records, imported-row exclusions, dependency
  handling, timestamps, ordering, retries, and recovery, follow
  **[partner-api-backfill.md](partner-api-backfill.md)**.
- Whether to expose comment search. Search has a higher usage cost profile than a
cached list because every intentional query costs three `read_unit`; do not add
typeahead search unless you can debounce, cache, and cap it.
- Whether signed-out users may see archive-backed content at all. The recommended
choice is no; see §1.
- The first CommsUni prompt must also ask whether a shared user wants their app
  display identity or a generated persona. Store the choice and apply it before
  backfill and later writes. A generated persona can look rough and may surprise
  users, but it is the privacy-preserving shared option and must remain available.
  Keep this identity choice distinct from the decision to share comments.
- Whether to run pre-send moderation on outbound comments and/or optional analysis
of incoming comments in your backend cache (see §10).

Per-comment source display:

- Render `origin.displayName` and/or an icon (recommended) for `origin.slug` on each comment or
at least in the thread header. Archived comments use `tvtime`; partner-written
comments use that partner's source slug, including comments written by apps
other than yours.
- Use the TV Time archive mark, or your local equivalent for
archive comments, and the partner's own icon for partner-written comments.
Clicking or tapping the source mark should reveal the full source name from
`origin.displayName`. It's fair.
- Keep source rendering data-driven. Do not hard-code a boolean like
`isArchiveComment`; model a source object with `slug`, display name, and icon.
- On the shared feed, expose source filtering in the UI. Prefer defaulting the
control to all sources (unfiltered). Your app's own comments are
`source=<your-partner-slug>` (chip or dedicated tab); landing on that filter is
allowed but discouraged. `source=tvtime` gives the historical archive alone. Do
not build those views by fetching an unfiltered feed and discarding rows
client-side.
- Prefer using each source's display name, icon, and accent colour from
`GET /v1/sources` in that filter, rather than text-only controls. Exact styling
is the partner's choice; keep the slug as the request value and the catalog
metadata as presentation.

Author display choices belong to the partner app:

- The archive supplies anonymized `userName`, `userColor`, and `userAvatar`. The
suggested default is to use them as-is. `userAvatar` is ready for display, and
`userColor` is useful for initials, mention chips, or subtle author accents.
- Some generated names may include a uniqueness suffix. You may strip that suffix
for a softer display, but then names are no longer globally unique in the
conversation. If you strip it, keep `userId` for grouping and mention links.
- Do not imply that archive personas are real TV Time accounts. Avoid profile pages
for TV Time archive authors; author pages are intended for non-TV-Time write
authors.
- For partner-written comments, prefer sending the user's chosen display identity
when the user has opted in. If you do not send it, that user appears to other
partners as a generated anonymous persona rather than as their in-app name.
- Make that choice available after onboarding in the app's settings. When an
opted-in user's display name or avatar changes, repeat
`PUT /v1/authors/me/profile` with the new values; use
`DELETE /v1/authors/me/profile` when the user switches back to the generated
anonymous persona. The overlay is resolved when comments are read, so the
updated identity applies to existing as well as future comments.

Comment-surface choices:

- **Publish optimistically; never drop the user's row.** When someone posts a
comment or reply, append it from your local store immediately — do not wait for
the archive round-trip or block the composer on success. On success, merge the
archive `id` and any server fields into that row in place; do not reload or
replace the whole thread, because a fresh read snapshot may still omit the write
you just made. On failure, the comment must not disappear: keep it visible, show a
clear error, and let the user edit, copy, or retry. For transient `429`/`5xx` or
`archive_writes_maintenance`, queue the outbound request with the same
`Idempotency-Key` and body (§7, §8) and drain when healthy. For validation errors
(`4xx` you caused), restore the composer text rather than discarding it, so the
user can always recover their words. The user may edit only this still-local,
unsynced draft; a successfully posted comment has no text-edit operation.
- Show a small "not synced" indicator (or equivalent) on rows that **should** be
on the shared board but exist only in your local store or are still queued —
clear it once the archive `id` arrives. This helps users and support tell
"visible in my app" from "live for everyone" during maintenance or transient
write failures. When app-only posting is supported, intentional **app-only** comments
are not "not synced"; tag them **app-only / not shared** so they are not mistaken for
a failed CommsUni post. If you stitch them into the global thread, keep that tag
visible on the row.
- If your comments UI is top-level-only or image-less on replies, extend it for
nested replies (`parent`, depth-2 flattening) and for `media` on reply rows — otherwise
parts of the archive are simply not shown.
- One comments surface — with source badges and filters always visible. Prefer
the full unfiltered board as the landing view. A control that applies
`source=tvtime` is the archive-only view; a control that applies
`source=<your-partner-slug>` is the "this app" view. Do not implement those as
separate comment stores that can drift from the API. Landing on your-slug is
allowed but discouraged (fewer cross-app replies; niche titles may look empty).
- Whether the composer offers "attach my rating". If your app already holds the
user's 0–10 rating for the title, an opt-in toggle beside "mark as spoiler" is
the intended shape: it costs no extra request, and the score travels with the
comment to every other partner. Leave it off by default so a user never
publishes a score they did not choose to publish.
- Keep "report" and "flag as spoiler" as separate actions. A report is a moderation
workflow; a spoiler mark changes community spoiler state and should not be hidden
behind the same icon or menu item. Automated spam detection should use reports, not
spoiler marks.
- If your app already has emotions, ratings, cast polls, or watch-source polls, ask
the product owner whether to show the shared archive engagement fields too. It is
optional for a comments-only integration; shared engagement accepts writes today.
- **Entity `rating` vs `starRatings[]`:** they are different systems — see §3
**Two ratings**. A five-star app should bind to `starRatings[]` (BAD→WOW as
stars), not to `rating / 2`. A 0–10 app should bind to `rating`. Do not convert
between them.

Mandatory:

Show API-retrieved content with clear, persistent provenance. At the top of any
CommsUni-backed comment/data surface (e.g. comments page, engagement), render
a small banner that includes:
- both platform icons — TV Community Archive and CommsUni
- text saying e.g. `Comments by CommsUni.tv`
- an info button to read more.

Do not hard-code icon URLs. Load them from `GET /v1/sources` and use each row's
`iconUrl`. The two platform catalog entries are stable: `source_id` 1 (TV
Community Archive) and `source_id` 2 (`commsunitv` slug). The response is
ordered by `source_id`; use that order, or match `commsunitv` by slug for the
CommsUni mark. It's recommended to cache the catalog for a day or more.

The info card can use warm product language rather than legal/technical copy.
You can use [CommsUni.tv](https://commsuni.tv) and
[tvtime-archive.com](https://tvtime-archive.com) for reference.
It should introduce both names and how they relate. Here's an example format:

- **CommsUni.tv** is the shared comments platform `your-app` plugs into. Other
  apps read and write in the same conversations, so a comment here can be seen
  in other apps, and you can see others.
  The name comes from Comments + Unity + TV ~ Community of the TV.
- **TV Community Archive** — a community-built cache of TV Time conversations,
  salvaged in July 2026 before its shutdown. TV Time accounts identity was anonymized
  to preserve old discussions while protecting privacy.
  CommsUni grew out of this archive and is built on it.
- both projects are created and maintained by a sole developer.

Indications:
- Include both icons from the sources catalog in the info card, bigger, next to the corresponding section.
- You may include in the card the CommsUni [static](https://commsuni.tv/assets/commsunitv-text.png)
  or [animated](https://commsuni.tv/assets/commsunitv.webm) landscape logos, in addition to the square icons.
  The animated one is a short looped animation with alpha channel, so it should be handled properly (the colors
  of both media are white and yellow, so consider injecting a dark background in light mode to ensure visibility).

Provide **two** visible outbound actions:
- a button that opens `https://commsuni.tv`, preferably yellow (`#ffd31a`),
  inviting users to read more and support the project, e.g. "Support CommsUni.tv"
- a separate link or button to `https://tvtime-archive.com` for the dedicated TV Community Archive page.


## 10. Moderation

Moderation on CommsUni is a **shared effort** between the platform operator,
partner apps, and end users. No single layer catches everything: you police what
your users publish, users can flag individual comments, and operators triage
reports that need archive-wide action.

### Your obligation: pre-send moderation

You are required to moderate comments **from your users before they reach the API**
— the same bar you already apply to comments that stay inside your app alone. The
archive does not filter partner writes at the edge; a successful `POST …/comments`
or `…/replies` stores the row immediately (see §12).

- Block or hold abusive, spam, or policy-violating content on **your backend**
before calling the write routes.
- If something already landed — including from backfill — remove it off-peak with
slow per-comment `DELETE /v1/comments/{id}` calls, using that author's
`X-TVTA-Actor-ID`. There is no bulk-delete route.
- Pick cleanup candidates from your own short-lived backend cache (comments already
fetched for users, plus your write log). **Do not crawl or scrape the API** for
moderation sweeps.

### End-user reports

Expose a normal **Report** action on any comment your UI shows — archive TV Time,
another partner's, or your own when the user is not the author. Keep it separate
from **Flag as spoiler** (community spoiler marks, not moderation).

`POST /v1/comments/{id}/reports` queues operator review (`202`). Supported abuse
reasons: `spam`, `abuse`, `spoiler`, `sexual`, `illegal`, `other`. Optional
`detail` (at most 1000 characters).

Special cases:

- **`mine_hide` / `mine_claim`** — only for **TV Time archive** comments
(`origin.kind` is `tvtime`) that a user says are theirs and cannot `DELETE`. Do
not use on native or other-partner comments; author-delete your own native rows
instead.
- **One report per actor per comment** — a second attempt returns `202` with
`Report-Duplicate: true` and is **not** queued, but still costs one `write_unit`.
Check that header before telling the user their report landed.

Reports do not remove a comment archive-wide immediately. You may hide the row in
**your** UI after a successful `202` — for that user or for all your users — using
your own cache or local suppress list. That does not affect other partners.

Full request shape, idempotency rules, and `mine_hide` / `mine_claim` behaviour are
in §3 (write endpoints table).

### Blocking authors and suspending your users

Give signed-in users a visible **Block author** action and a way to review and undo
their blocks. Blocking and reporting are separate controls: blocking changes what
one user sees in your app, while reporting asks the archive operator to review
content. You may offer a combined **Block and report** flow, but do not silently
file a report when someone only chose to block, or claim that a report blocked the
author.

There is no CommsUni block-list endpoint. Keep each user's block list in your
own account/backend data, keyed by the returned comment/reply `userId`, and apply it
to every CommsUni surface in your app. Once a user blocks an author:

- immediately suppress that author's visible comments and replies for the blocking
  user, including rows already in local caches;
- continue applying the block when later API responses contain that `userId`; and
- persist the preference across sessions and devices, with an **Unblock** control.

This is an app-scoped author block, not an archive-wide ban. It does not delete the
author's content, prevent the author from writing through another app, hide the
content from other partners, prevent that author from seeing the blocking user's
public posts, or tell the archive operator that abuse occurred. A `userId`
identifies the API author represented on that row; it must not be used to infer
that two identities from different partner sources belong to the same person. Use
**Report** when operator review or archive-wide action is needed.

You are also responsible for suspending **your own authenticated users** when they
repeatedly or seriously violate your rules. Enforce that suspension in your own
authentication/backend layer before the API proxy: stop forwarding comments,
replies, likes, ratings, profile changes, and other publishing or engagement writes
for the suspended local account. **Do not disable Report merely because posting is
suspended**: if that user can still view comments, they must still be able to report
abuse. Do not rely on hiding that user's existing rows or on an API error as the
suspension mechanism.

You cannot suspend a user who belongs to another partner. For abusive authors from
the TV Time layer or another partner source, block them in your app and report the
relevant content for operator review. Operator moderation may hide content
archive-wide or restrict future writes, but there is no partner-facing user-ban
route and no partner should present itself as having imposed a global ban.

### Moderation notices to partners

You receive **moderation notices** (out of band from the API — email or a channel
agreed with the operator) when:

- a comment **originated by your source** is acted on archive-wide (hidden, removed,
or otherwise moderated), or
- a comment **visible in your conversations** receives a user report that operators
want you to review.

Use these notices to update local suppress lists, inform affected users if your
product requires it, and tighten pre-send filters when patterns repeat. The API
does not currently push webhooks for moderation events; treat notices plus your own
cache as the integration surface until a machine-readable channel exists (see §12).

### Analyzing incoming comments (optional)

You may run backend jobs over comments **already in your short-lived read cache**
— not by scraping the API — to:

- **Hide locally** comments you do not want shown in your app yet, even before
operator action or user reports. This is partner-scoped UI policy only; the comment
remains visible to other partners until removed archive-wide.
- **Bulk-report** matches back to the archive with `POST /v1/comments/{id}/reports`
and a proper abuse `reason`. Each report costs one `write_unit`, same as posting a
comment. Use `spam`, `abuse`, etc. — never `mine_hide` / `mine_claim` for another
partner's rows.

### Division of labour


| Layer              | Who                 | What                                                                  |
| ------------------ | ------------------- | --------------------------------------------------------------------- |
| Partner pre-send   | You                 | Block bad outbound content; delete your own source's mistakes         |
| End-user block     | Your end users      | Hide one API author throughout your app for that blocking user        |
| Partner suspension | You                 | Stop your own offenders' publishing and engagement writes             |
| User report        | Your end users      | Flag any visible comment for operator review                          |
| Local hide         | You (optional)      | Suppress rows for all your users without waiting for operators        |
| Operator triage    | Archive operator    | Archive-wide moderation on queued reports and partner notices         |


## 11. Write integration notes

Writes are part of `v1` and are enabled server-side when the operator grants
`archive:write` on your key. Gate write UI on a scope/capability check so keys
without the scope stay read-only without an app release; the data-model rules
below apply whether or not your key is write-enabled today.

- Store comments with `id`, `origin` (provenance), `userId`, `parentCommentId`,
`inReplyToCommentId`, `rootCommentId`, `depth`, and `createdAt`, not just text
and like counts.
- Model `rating` as nullable and render it conditionally. It is authored data
frozen with the text, so cache it exactly as long as you cache the text — never
recompute it from your own current rating for that user.
- Gate comment and reply composition on a capability check rather than a build
constant, so enabling the scope does not require an app release.
- Leave room for optimistic native comments whose ids are not TV Time UUIDs, and
track sync state (`pending` / `synced` / `failed`) on locally originated rows.
The row stays in the list through all three states; a `failed` row keeps its text
and offers retry or edit (§9).
- Keep source filters and source icons in the UI even if your users mostly see
`tvtime` today.
- Treat `likes.native`, `spoilers.native`, and native reply counts as live shared
state layered over the frozen archive baseline — written by your users and by
other partners' users alike.
- Do not allow writes from guests, shared per-user actor IDs, or the unknown-user bucket.
Reads can use a tightly controlled signed-out preview if you deliberately allow
it, but writes require a real authenticated user mapped to one stable actor ID.
- Call `PUT /v1/authors/me/profile` before or alongside a user's first visible write
if you want a chosen display name/avatar. The route identifies the user only via
`X-TVTA-Actor-ID` (no author id in the URL or body). The server creates the
underlying author row on the first write (comment, reply, like, rating, etc.) if
needed; profile PUT only sets the display overlay (`displayName`, `avatarUrl`, both
required, latter nullable). `DELETE /v1/authors/me/profile` clears that overlay for
the current actor; comments stay published under the same `userId` with generated
persona display — not bulk deletion.
- Every partner author should still have a generated persona fallback. For
anonymous-looking users or users without a profile image, use the archive-provided
generated avatar. For signed-in users with a profile image, send `avatarUrl`.
In all cases, keep `userColor` as a fallback for initials, generated avatars, and
mention chips.
- You may choose a local colour yourself for your own UI fallback. It can come from
the user's profile picture, a user customization setting, a stable random
assignment, or a fixed palette your app chooses. Keep it stable enough that users
do not appear to change identity between sessions. The current profile endpoint
accepts `displayName` and `avatarUrl`; if you need a shared partner colour in the
API contract, agree that field with the archive operator before depending on it.
- Comment and reply text editing is not part of the write model. Design the UI
without an edit affordance for comments/replies. The author spoiler toggle on
the author's own comment is the narrow exception, but it is not text editing.
Do **not** mimic an edit by deleting the row and posting a replacement (`DELETE`
then `POST`). That is worse than no-edit: replies, likes, spoiler marks, and
reports stay on the tombstone or vanish with it — the conversation's interaction
is gone, and later replies look like they answer nothing. Text edit is omitted
on purpose, not because it is impossible: silent full rewrites (the YouTube
comment pattern) make existing replies nonsense; doing it "properly" would mean
storing edit history, and spoiler status and reports would still be invalidated.
If the author wants different wording, they can post a new comment and leave the
original, or delete only when they truly want that row gone.
- Replies should auto-inject true structured mentions. When the user replies to a
comment or sub-reply, prefill the visible mention text and send the matching
`mentions` entries — `authorId`, `start`, `end`, `text`, at most three — in the
write request. Render returned mentions from the structured `mentions` field
(`userId`/`start`/`end`), not from a regex over the text.
- Preserve one nested reply level in your data model. A reply to a reply is
flattened by the server under the direct parent while `inReplyToCommentId`
records the actual target; this is why both parent fields matter.
- A reply target being an archived TV Time comment changes nothing about the
request. Frozen archived rows accept replies, likes, and spoiler marks exactly
like native ones — do not disable those affordances based on `origin.slug`. The
only actions restricted to a user's own native comments are delete and the
author spoiler toggle.
- If a read response includes a deleted/tombstoned comment to preserve thread
shape, never render its old text, media, or author actions. Show a minimal
placeholder only when it still has replies (`replyCount > 0` or child rows); with
no replies, omit it entirely — no empty card.
- The first comment on a valid but previously unarchived TVDB reference creates
the archive entity server-side as part of that write, rather than through a
separate "create entity" call. Do not build or call an explicit entity-creation
route. If a read returns `404 not_archived`, there is no readable archive content
yet, but your UI should still show the title page and an empty comment section
with an "add comment" composer when your product supports native comments.
- Engagement writes for emotions, cast votes, ratings, polls, and watch-source data
are optional product surfaces. If you choose not to implement them, ignore the
returned fields and do not show dead controls.
- For initial and later per-user historical imports, follow
  [partner-api-backfill.md](partner-api-backfill.md); it is the source of truth for
  backfill consent, eligibility, dependencies, timestamps, and script behavior.
- Pre-send moderation, user reports, partner notices, cleanup, and optional incoming
analysis are covered in §10.

---



## 12. Future improvements and current gaps

These are known limits or likely follow-ups. Design so they can improve without
changing your whole integration.

- **Language for new comments.** If a write request omits `language`, the native
comment is stored in the `unknown` language bucket. That means it appears only
under `language=unknown`, never under a real language filter such as `language=en`.
Asking users to choose a language manually is possible but discouraged for normal
comment composition; it adds friction and is easy to get wrong. Automatic
language detection may be added server-side later. If language filtering matters
to your app before that exists, you can optionally run your own detector on your
backend, such as `lingua-go` (`https://github.com/pemistahl/lingua-go`), and send
the detected BCP-47-ish language code as `language` in the comment body.
Send **one** value and nothing else: the primary language is derived from it
server-side (`pt-BR` is stored as tag `pt-br` with base `pt`), so there is no
separate "base" field to send. Prefer the plain primary tag (`en`, `it`, `pt`)
unless the locale genuinely matters to your users — every distinct locale you
send becomes its own `languageCounts` row for every partner. Case and `_` vs `-`
are normalized (`pt_BR` → `pt-br`). Most locale rows you will see today come from
the TV Time archive, which recorded locales as TV Time stored them.
- **Historical timestamps.** Comment and reply writes accept optional `createdAt`
  with `archive:write`; send the original user-action timestamp for backfills
  and for any delayed live writes. Like/spoiler engagement history is not
  backdated through that path.
- **TMDB identifiers.** The API may support TMDB path references later, but it is
low priority. If your catalogue is keyed by TMDB today, keep your own TMDB-to-TVDB
matching layer and call the archive API with TVDB references.
- `most_relevant`**.** The current relevance ranking is intentionally simple: a
stored rank where one exists, otherwise combined likes then recency. It may
later include replies, source signals, media, language, or other quality inputs.
Always treat the returned order as authoritative and restart pagination when
sort options change.
- **Filtering.** `source` and `language` are the feed-wide comment/reply filters
(already on the list, reply, and search routes — see §3). Pass `language=<tag>`
to filter the feed server-side; do not fetch pages and drop other languages
client-side. `q` exists only on the search route, and `parent` exists only to
expand a reply branch. A "this app's comments" screen is
`source=<your-partner-slug>` on the shared board, not a locally assembled subset
of an unfiltered fetch. Filtering by media presence, date range, spoiler state,
or viewer state is not available. `include=language_counts` and `include=source_counts` are **not** filters:
they return the per-language histogram for the current `source` scope and the
per-source histogram for the current `language` scope, so picker UIs can list
options with counts; applying a choice still uses `language=` / `source=`. Both
filters take several values at once and combine server-side — `source=tvtime,acme&language=it,en`
is one query returning Italian or English comments from either source;
never fetch two filtered lists and intersect them yourself. When you only need
the counts (picker badges before the thread opens), call `/conversation` instead
of a comment page. Group `languageCounts` rows by `base` before rendering: the
stored tags are locale-level (`en`, `en-us`, `en-gb`) while `language=en` matches
them all.
- **Search depth.** Comment search matches top-level comments for one entity, caps
at 50 results, and has no cursor. Cross-entity or reply-inclusive search is not
available; do not build a UI that implies it.
- **Cross-app notifications.** The API does not currently deliver notifications
across partner apps. Do not poll every user's archive threads looking for new
replies or mentions; that is expensive and will burn quota. You can handle
notifications inside your own app normally when one of your users replies to or
mentions another of your users. Cross-app notifications need a separate design;
suggestions are welcome.
- **Per-user activity feeds.** `GET /v1/authors/{authorId}/comments` exists for
non-TV-Time partner authors, but author feeds can become heavy if used as a
background sync primitive. Use them for explicit profile/deep-link surfaces, with
pagination and caching, not to poll every user's comments and replies.
- **Server-side spam filtering.** The API does not filter partner writes before
storage. Partners own pre-send filtering (§10); there is no partner bulk-hide route —
only per-comment author delete or `POST …/reports`.
- **User blocking and suspension.** The API does not store a user's author block
  list and has no partner-facing user-ban route. Partners must persist and apply
  app-scoped blocks themselves, and must stop suspended local users' publishing
  and engagement writes before the API proxy (§10). Blocking an API `userId` does
  not establish or block the same human across different partner sources;
  cross-partner identities are deliberately not linkable through this API.
- **Moderation webhooks.** Partner moderation notices are delivered out of band
today (§10). A machine-readable push channel for report and archive-wide actions
may be added later.
- **Comment ownership / merge.** Archive TV Time comments stay frozen under
anonymized personas. `mine_hide` and `mine_claim` are intake for later operator
review of **those archive rows only**; they do not reassign `author_id`, hide
the row archive-wide, or allow `DELETE` on them. Partners may hide the comment
in their own UI after filing the report. The API does not currently reject these
reasons on native comments — partners must not send them except on comments whose
`origin.kind` is `tvtime`. Nor does it merge intents: the one-report-per-actor row
means a user who already reported a comment for any reason gets `Report-Duplicate:
true` and no queued claim. Until that changes, a user's ownership claim on a
comment they previously flagged has to reach the operator out of band.

---



## 13. Implementation checklist

### Security and request identity

- [ ] API key stored server-side only, loaded from secrets, never in the app bundle.
- [ ] Archive-backed data is not exposed to unauthenticated guests by default; any
  signed-out preview is tiny, backend-cached, and rate-limited before it can
  reach the archive API.
- [ ] `X-TVTA-Actor-ID` sent on every request, derived server-side from your
  authenticated user, opaque, valid, and stable per user across devices and
  sessions.
- [ ] Proxy builds upstream headers from an allowlist and does not forward the
  browser or device `Origin`.

### Product decisions and attribution

- [ ] Comments UI is one shared board (CommsUni). A "this app's comments"
  tab/chip is `source=<your-partner-slug>`; archive-only is `source=tvtime`.
  Neither is a second comment store, and filtering is performed through the API
  rather than by discarding rows from an unfiltered response.
- [ ] Product owner has decided the default source view (unfiltered CommsUni is
  recommended), whether app-only posts are offered, whether search is included,
  and which optional engagement surfaces are adopted. Every adopted capability
  follows its complete contract in this guide. If app-only posts are offered, they
  are a per-user choice and are visibly tagged app-only / not shared in the global
  thread.
- [ ] Source-filter controls use the display names and, preferably, icons and
  accent colours returned by `GET /v1/sources`; exact styling is the partner's
  choice, while source slugs remain the filter values.
- [ ] Comment source/origin rendered with a visible source badge or icon, including
  archive and partner icons that reveal the full source name.
- [ ] Sticky CommsUni.tv attribution banner (both platform icons from
  `GET /v1/sources` — `source_id` 1 archive and `source_id` 2 commsunitv),
  info card explaining TV Community Archive, and outbound links to support CommsUni.tv
  and tvtime-archive.com wherever shared comments are shown.

### Reading and rendering conversations

- [ ] Conversations addressed by TVDB reference, or by an `entityId` resolved once
  and stored — never by calling the lookup route before every read.
- [ ] Comment and reply reads paginated via `nextCursor`, stopping on `complete` or
  absent cursor, with no assumption about how many items a page returns.
- [ ] Product UI shows current visible counts from conversation `comments.total` /
  `replies.total`, comment `replyCount`, and reply-list `count` / `total`.
  `allTime`, `replyCountAllTime`, `allTimeTotal`, and archive-capture fields are
  never used for badges or presented as missing live replies.
- [ ] Sort, source, and language filter changes restart pagination from the first
  page.
- [ ] Replies fetched lazily on thread expand, and all-time/archive gaps
  (`allTimeTotal` or `replyCounts` larger than the active `total`) treated as
  optional archive metadata rather than missing live replies.
- [ ] Nested reply UI supports one visible sub-reply level, shows nested expand
  controls only when a reply reports children, and renders `media` on reply rows
  like top-level comments.
- [ ] Structured `mentions` rendered from API spans, and reply composition prepared
  to send structured mentions rather than relying on text parsing: reads use
  `mentions[].userId` / `start` / `end`, while writes use `authorId` / `start` /
  `end` / `text`.
- [ ] Entity-route `404 not_archived` and `404 not_found` handled as empty states
  distinct from a `200` with zero comments, cached for hours rather than
  forever; cursor-following 404s keep already loaded pages. The UI simply shows
  an empty shared comment section and, when writes are supported, its composer —
  not a confusing "no archived content" message.
- [ ] Deleted/tombstoned comments never show old text/media/actions; a minimal
  placeholder appears only when replies remain, otherwise the row is omitted.
- [ ] Reply, like, and spoiler affordances are enabled on archived TV Time comments,
  not just on native ones; delete and the author spoiler toggle are limited to
  the user's own native comments.

### Writing, profiles, and optimistic UI

- [ ] Write UI has no comment/reply text editing affordance, no delete-then-repost
  "edit" workaround (that drops replies/likes/spoilers/reports), and no guest
  writes. Editing a failed, still-local draft does not imply that a synced comment
  can be edited.
- [ ] Comment composition deliberately decides whether to offer an "attach my
  rating" control. When adopted, it is opt-in, sends the user's current 0–10
  score only when selected, and otherwise omits `rating` or sends `null`; the
  posted rating is understood to be a frozen snapshot, separate from the entity
  rating and not editable later.
- [ ] First writes to valid but unresolved TVDB references include the required
  `entity.title` and, when needed, `entity.showTitle`, allowing the comment,
  rating, or engagement `PUT` to create the entity automatically. No standalone
  entity-create route is called, and `DELETE` is not expected to create one.
- [ ] Users can choose in app settings whether their public display name/avatar are
  shared to CommsUni or replaced by the generated anonymous persona. The choice
  is persisted, can be changed later, and is applied with
  `PUT /v1/authors/me/profile` or `DELETE /v1/authors/me/profile` as appropriate.
- [ ] When a sharing user's username or profile picture changes, the partner calls
  `PUT /v1/authors/me/profile` with the updated `displayName` and `avatarUrl`, so
  the CommsUni identity shown on existing and future comments stays current.
- [ ] Writes carry one `Idempotency-Key` per user action, reused for normal retries
  and write-outage queue delivery only with the same target, operation, and body;
  the key is never reused for another action.
- [ ] User posts stay visible optimistically: success merges the archive id in place
  without reloading the thread; failures keep the row and let the user edit, copy,
  or retry rather than discarding text.
- [ ] Pending, failed, or queued local rows show a clear but unobtrusive not-synced
  indicator until the archive id arrives, with retry available after failure.
- [ ] Cached pages for an entity or thread invalidated after your own users' writes;
  the user's new row stays visible from local state rather than relying on an
  immediate refetch (read snapshots can trail by a few seconds).

### Moderation and user safety

- [ ] Report, flag-as-spoiler, and block-author are distinct user actions. Any
  combined flow explicitly names each effect and never performs one silently as
  a side effect of another.
- [ ] The report UI supports every applicable reason: `spam`, `abuse`, `spoiler`,
  `sexual`, `illegal`, and `other`, plus `mine_hide` and `mine_claim` only for TV
  Time archive comments the reporting user says are theirs. The `mine_*` reasons
  are never offered or sent for native or other-partner comments.
- [ ] Signed-in users can block and unblock an API author; the partner persists the
  block by returned `userId` across sessions/devices and suppresses that author's
  comments and replies throughout its app. The UI does not describe an app-scoped
  block as an archive-wide ban.
- [ ] Repeat and serious offenders from the partner's own authenticated user base
  are suspended in the partner backend before the API proxy, and their further
  publishing and engagement writes are not forwarded. Report remains available
  wherever suspended users can still view comments. Other partners' users are
  blocked locally and reported, not represented as globally suspended.
- [ ] Pre-send moderation on outbound comments; off-peak cleanup and optional incoming
  analysis per §10 — cache only, never scrape the API.
- [ ] Partner moderation notice channel agreed with the operator and wired into your
  internal review flow.

### Media handling

- [ ] Images requested in batches of ≤16 for the visible window via
  `POST /v1/media-grants`; bytes cached, signed URLs never cached.
- [ ] Custom partner CDN hosts registered with the archive operator before writes
  use their URLs — comment-media hosts and avatar hosts are separate lists.
- [ ] Redirects from `/media` not followed with the `Authorization` header.

### Caching, rate limits, and resilience

- [ ] `RateLimit-*` headers logged; `Retry-After` honoured; backoff with jitter;
  circuit breaker on repeated failure.
- [ ] Per-user actor-ID rate limits shown to the affected user as clear local throttling,
  not as a generic obscure error or a whole-app outage.
- [ ] Request coalescing in front of repeated identical upstream reads; any backend
  cache for comments/replies/search/single-comment reads is short-lived and
  treated as optional burst protection, not as source-of-truth storage.
- [ ] Any durable copy of your app's shared comments is a cache of
  `source=<your-partner-slug>`, refreshed on user-driven thread browse (and
  your own writes), never by polling or scraping. Other partners' comments are
  not persisted in that store.
- [ ] No polling, no background crawling, no prefetching beyond one page.

### Data models and forward compatibility

- [ ] Unknown response fields ignored rather than rejected.
- [ ] Typed models distinguish omitted fields from explicit `null` and tolerate
  unknown enum values; `viewerLiked` / `viewerMarkedSpoiler` modelled as
  optional rather than defaulting to `false`.
- [ ] Data model represents partner-written comments and source-filtered views
  without special-casing the archive read path.

### Optional engagement and cast voting

- [ ] New `cast_vote` options are written with `character:tvdb-<TVDB v4 character id>`
  only; no person ids, no `actor:*` keys, no name-derived keys. Existing keys
  returned by a read stay votable and removable, and saved votes are never
  rewritten or delete-and-reposted to migrate them.
- [ ] The cast menu comes from your own TVDB cast data, joined to `castVotes[]` on
  `characterId`, with names and images resolved from TVDB (new rows have null
  `name` / `imageUrl`); `castVotes[]` is never treated as the cast list, and
  legacy or archived rows are shown separately rather than merged into TVDB rows.
- [ ] Cast vote writes handle `400` / `422 invalid_option_key`, `429 quota_exceeded`,
  and `503 tvdb_unavailable`, honouring `Retry-After` on the last two, and show a
  "voting not available" state for an entity with no TVDB id.

### Backfill and launch readiness

- [ ] If historical comments will be imported, complete the consent, eligibility,
  dependency, ordering, retry, and verification checklist in
  [partner-api-backfill.md](partner-api-backfill.md).

---



## 14. What is stable

The archive's internal storage is not the API contract. `v1` is the contract, not a
view of the current schema. Build against these guarantees.

**Stable — safe to persist and to build on:**

- Route shapes, documented query parameters, and the `{ "data": ... }` /
`{ "error": ... }` envelope.
- TVDB references, preferably the dash form such as `tvdb-289590`, `tvdb-289590-s1`
and `tvdb-289590-s1e1`. Addressing content by TVDB identifiers keeps working, and is
the form least coupled to how the archive stores anything. The older colon form
such as `tvdb:289590` and `tvdb:289590:s1e1` remains supported.
- Comment `id` values. These are the TV Time comment UUIDs, they key the media
routes, and they will not change.
- `entityId` values, which stay valid if you choose to store them.
- Documented field names and their meanings, error `code` values, and the
`RateLimit-*` headers.
- The distinction between an empty `200` and `404 not_archived`.
- Source slugs in `origin.slug` for comments that have already been published.
- The immutability of archived TV Time comment text, authorship, timestamps, and
the `archived` halves of the like/spoiler/reply counters.
- A comment's `rating`, which is frozen at write time along with its text. It is
safe to persist beside the text and never needs re-reading on its own.
- Engagement `optionKey` values already returned by a read, including archived
`actor:<n>` cast keys. They stay votable and removable whatever their shape. On
`castVotes[]`, `provider`, `characterId`, and `peopleId` are additive fields on
new TVDB-keyed rows; `actorId`, `name`, and `imageUrl` are nullable and `role`
may be `""`, so model them as optional. Only the **creation** of a new
`cast_vote` option narrows, to `character:tvdb-<id>` (§3).

**Not stable — never persist or infer from:**

- `cursor` and `nextCursor` values. Opaque, and only valid for the route, sort,
source filter, language filter, limit, and request run that produced them.
- How many items a page returns for a given `limit`, and how many requests a full
pass takes.
- Signed media URLs and their host, which expire in minutes.
- Response latency, and the order of anything not explicitly ordered.
- **Counts, ordering, and reply totals.** `likeCount`, `spoilerCount`,
`replyCount`, active `total` fields, the `native` halves of split objects, and a
comment's position under any `sort` all move as other users write. Snapshot them
for display, never as durable truth.

**How changes will arrive:** new fields may be added to existing responses inside
`v1`, so parse leniently and ignore what you do not recognise. New capabilities
arrive as new parameters or routes that are optional to adopt — the write routes
in §3 arrived that way, additively, without a version bump. Anything that would
break a correct integration gets a new version prefix instead.

---



## 15. Quick smoke test

Read smoke (real archived title — replace `<show>` with a TVDB id you already use):

```bash
curl -sS https://api.commsuni.tv/v1/health

curl -sS \
  -H "Authorization: Bearer $TVTA_KEY" \
  -H "X-TVTA-Actor-ID: smoke-test" \
  "https://api.commsuni.tv/v1/entities/episode?tvdbShowId=<show>&season=2&episode=5"

curl -sS -D- \
  -H "Authorization: Bearer $TVTA_KEY" \
  -H "X-TVTA-Actor-ID: smoke-test" \
  "https://api.commsuni.tv/v1/entities/episode/tvdb-<show>-s2e5/comments?limit=50"

curl -sS \
  -H "Authorization: Bearer $TVTA_KEY" \
  -H "X-TVTA-Actor-ID: smoke-test" \
  -H "Content-Type: application/json" \
  -d '{"commentIds":["<comment-uuid>"]}' \
  https://api.commsuni.tv/v1/media-grants
```

Check that the comments call returns `RateLimit-*` headers, and that the media-grants
call returns a `granted` or `missing` status for every requested ID.

Write smoke (shared synthetic title — see **Integration testing** above):

```bash
curl -sS -X POST \
  -H "Authorization: Bearer $TVTA_KEY" \
  -H "X-TVTA-Actor-ID: smoke-test" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"text":"smoke test","entity":{"title":"Pilot","showTitle":"Partner integration test"}}' \
  "https://api.commsuni.tv/v1/entities/episode/tvdb-900000001-s1e1/comments"
```
