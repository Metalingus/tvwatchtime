# Multi-Provider Metadata Architecture

TVWatchTime resolves media metadata from several providers, with a clear priority per
content type and a non-blocking enrichment pipeline. This document describes the final,
implemented behavior.

## Providers

| Provider | Role                                                            | Identity namespace                    | Retrieval notes                             |
| -------- | --------------------------------------------------------------- | ------------------------------------- | ------------------------------------------- |
| TMDB     | Primary general provider                                        | `TMDB` `SERIES`/`MOVIE`               | API key required                            |
| TVDB v4  | General fallback **and** first-class source for TVDB-only media | `THE_TVDB` `SERIES`/`MOVIE`/`EPISODE` | API key (+ optional PIN), distributed token |
| Kitsu    | Optional anime enrichment                                       | `KITSU` `ANIME`/`MANGA`               | Alternative titles, subtype, dates, artwork |
| Jikan    | Optional MyAnimeList enrichment                                 | `MYANIME_LIST` `ANIME`/`MANGA`        | Identity is MAL; Jikan is retrieval only    |

A verified external identity is the triple **(provider, providerEntityKind, value)**. Distinct
namespaces never collide: `(TMDB, SERIES, 123)` ≠ `(TMDB, MOVIE, 123)`; `(KITSU, ANIME, 9)` ≠
`(KITSU, MANGA, 9)`; TVDB series/movie/episode ids are in separate tables.

## Provider priority (field-by-field, never whole-record)

| Content                      | Priority                                                                |
| ---------------------------- | ----------------------------------------------------------------------- |
| Anime shows                  | **TMDB identity/classification → TVDB metadata + structure**            |
| Manga publication metadata   | **Kitsu > Jikan/MyAnimeList**                                           |
| General (TMDB↔TVDB verified) | **TMDB when official graphs match; otherwise TVDB official order**      |
| General (TMDB only)          | **TMDB**                                                                |
| TVDB-only general (no TMDB)  | **TVDB** (TMDB optional, attached later if a reliable mapping is found) |

Exactly one of TMDB or TVDB owns a show's **structural** fields (seasons and episodes). Kitsu/Jikan
can enrich anime metadata but never own or switch structure. Manga chapters, volumes, and
serialization are never written onto a screen adaptation.

## Anime workflow (non-circular)

```
TMDB routing profile (identity + genres + keywords + external ids)
→ strict Animation(16) AND anime-keyword decision
OR brand-new TVDB series + TVDB's explicit Anime genre
→ TVDB structure for confirmed anime
→ otherwise compare TMDB with complete TVDB official order
→ equivalent: TMDB metadata + structure; divergent: TVDB metadata + structure
→ optional Kitsu/Jikan field enrichment without routing authority
```

- Existing/TMDB-origin shows require TMDB `Animation` genre and TMDB `anime` keyword together.
- A TVDB series that does not yet exist in the catalog is also automatically **ANIME** when
  TVDB explicitly returns its `Anime` genre (`id=27`, name/slug `anime`). Search, import, and
  identity promotion share the same create-only gate and enqueue one deduplicated full TVDB
  hydration job. This path never changes an already-existing show's authority inline.
- Kitsu/MAL matches, Japanese language/origin/studio, and non-genre TVDB type signals never
  classify or route.
- Movies remain TMDB-owned even when classified as anime; only shows have provider-owned structure.
- Source show/movie category is **never** treated as classification.
- Import-only replacement exception: after every TV Time TVDB SERIES id is proven dead and exact
  local catalog matching misses, a unique TVDB SERIES with a strongly compatible title/alias,
  year, the same complete regular-season range, and enough episodes to contain the watched
  footprint may route directly to TVDB when its full TVDB record explicitly carries the `Anime`
  genre. Exact titles may contain additional unwatched episodes; weaker descriptive-prefix matches
  require exact episode counts. A bounded pre-colon query handles legacy descriptive suffixes. This
  rejects franchise parents without treating a partial final season as the complete provider
  episode count. It bypasses TMDB `/find` only for structure recovery. Separately, ordinary search
  may create and route a previously unknown TVDB series when TVDB itself returns the explicit
  `Anime` genre, as described above.

## TV Time imports

TVDB is **not** resolved externally for every imported row. Order:

1. Raw TVDB ids (`s_id`, `series_id`, `tv_show_id`, `episode_id`) are **preserved**.
2. A **verified local** TVDB mapping is reused with **no external call** (8,000 episode rows of one
   show → one local record, zero requests).
3. Normal local/TMDB matching runs (exact → core → localized JSON → TMDB → archive-language).
4. TVDB **exact** lookup (series/movie/episode) runs **only** for unmatched / needs-review /
   conflicting / ambiguous-episode records. A confident match never triggers a TVDB request merely
   because a raw id exists.
5. A conflicting TVDB id → review conflict (both candidates + evidence), never attached silently.
6. When all exported SERIES ids are confirmed dead, the guarded TVDB-anime replacement exception
   above runs before provider title fallback. It requires exactly one qualifying series with the
   same complete season range (and exact episode counts for a weaker prefix-title relation), then
   persists an explicit `ANIME_TVDB` structure decision; ambiguity or failed hydration stays
   unresolved. Search-hit aliases are rechecked against the candidate's hydrated translations;
   a lightweight no-episode hydrate rejects wrong season ranges before the full structural fetch.
   A suffix-only `OVA(S)`/`Special(s)` legacy collection can reuse one exact-base TVDB Anime series,
   while a deleted OVA with no valid TVDB series may use a uniquely alternative-titled TMDB show
   whose structure contains the archive footprint.

After a confident import match, the same candidate→match→classify→hydrate workflow is enqueued
(deduplicated per local media id; non-blocking to applying watch history).

### TV Time file → known TVDB fields (header-based)

| File                           | Imported data                           | Known TVDB fields             |
| ------------------------------ | --------------------------------------- | ----------------------------- |
| `tracking-prod-records-v2.csv` | Watched episodes + watchlist            | `s_id` (series), `episode_id` |
| `tracking-prod-records.csv`    | Watched episodes, watchlist, show/movie | `series_id`                   |
| `show_seen_episode_latest.csv` | Watched episodes                        | `tv_show_id`, `episode_id`    |
| `seen_episode_source.csv`      | Watched episodes                        | `episode_id`                  |
| `followed_tv_show.csv`         | Active show watchlist                   | `tv_show_id`                  |

`<nil>` and empty values are treated as null, never zero. Headers are matched by name (not position).

## Search (non-blocking)

1. Return immediate local/cache/TMDB results.
2. **Before returning**, enqueue background work (awaited only for the quick enqueue):
   - `tvdb-search:{query}:{type}:{locale}` — TVDB series **and** movie search, independent of anime
     matching. TVDB-only results are stored as **provisional** Redis candidates (TTL), **not** full
     media rows.
   - `classify-candidate:{mediaId|identity}` — candidate detection on results.
3. Return; never wait for TVDB/Kitsu/Jikan network work.

**Provisional vs permanent:** only _unused_ background-search candidates are temporary. Selecting /
needing a TVDB-only result promotes it to a **permanent**, fully-hydrated record via a single shared
promotion service (`getOrCreateByIdentity`, deterministic lock + recheck). TMDB is **not** required.
Clients never create media records directly; selection accepts a local id or a provider identity and
the backend promotes.

**Client refresh:** no socket/SSE today — one bounded refetch (refocus/return + a single capped
fixed-delay refetch per `searchRequestId`); no polling.

## Identity-only enrichment

Candidate detection and Kitsu/Jikan matching run on cached provisional metadata **without creating a
DB row**. Cached evidence transfers onto the promoted record (idempotently, verifying the identity).

## Cross-provider reconciliation

Same-identity concurrency → one record (namespace-aware lock). Cross-provider duplicates gather
typed identities, direct mappings, and the complete episode graph before cutover. General-show
graphs that are completely equivalent are TMDB-owned; a missing direct series bridge can be proven
only by a unique full TMDB graph plus a complete TVDB-episode→TMDB-component proof covering every
official season. The whole duplicate/component family copies and verifies in one transaction before
any redirect activates. Insufficient or competing evidence fails closed and all identities remain
visible. Hydration-triggered automatic cutover additionally requires the production rollout gate;
explicit admin dry-run/repair remains available.

For movies, IMDb is the preferred identity bridge. A TVDB movie ID is translated only through
TVDB's `/movies/{id}/extended` remote TMDB/IMDb IDs; TMDB `/find?external_source=tvdb_id` is not a
movie lookup and must not be used. Search, import, discovery, and hydration all converge through
`lightUpsertMovieTvdb`, so a verified bridge reuses the TMDB canonical row and records the TVDB and
IMDb aliases on it. Historical duplicates are merged only by the dry-runnable admin repair, which
preserves user-owned movie relations before deleting the source row.

Every provider alias is entity-kind scoped. A SHOW may consume only SERIES aliases and a MOVIE only
MOVIE aliases; ratings, recommendations, artwork, generic backfill, discovery, and import routing
apply the same gate. Metadata Health reports wrong-kind aliases separately and its repair detaches
one only when a correct-kind identity anchors the row. Multiple same-kind TVDB aliases are not
automatically duplicates: the audited repair fingerprints each set, permanently parks verified
benign aliases, periodically retries unresolved/ambiguous sets, and detaches only aliases proven to
contradict the row's TMDB/IMDb anchor.

## Rate limiting & resilience

- Redis-backed **fixed-window** limiter (per-second + per-minute, atomic) shared across all
  instances/workers; separate concurrency semaphore with leases. TVDB token refresh is
  single-flighted via a distributed lock.
- Internal throttling returns a retry delay and is **not** a provider failure (does not trip the
  circuit breaker).
- TVDB season/episode structure reads paginate to an explicit provider end marker. Structural
  hydration and reconciliation never persist or match against a partial page set; internal
  throttling waits and retries the same page, while an incomplete/upstream failure aborts the
  title without quarantining or convergence-stamping it.
- Per-provider circuit breaker, request coalescing, positive/negative cache, metrics.

## Optional Jikan self-host

Jikan runs as an optional Compose profile (`docker compose --profile metadata up`), internal-only,
no public route, and **never** gates API startup. The multi-day indexer is an explicit operator
action. Public Jikan remains a configurable fallback while local Jikan is unavailable/not ready
(healthy-but-empty ≠ ready).

## Environment variables

See `.env.example` for the full `TVDB_*`, `KITSU_*`, `JIKAN_*` resilience configuration. Precedence:
**validated admin override (admin console) > environment variable > safe default**. Secrets are
encrypted in the DB and never returned through admin responses.

## Admin

`GET /admin/providers` returns per-provider config + circuit-breaker state + daily metrics (secrets
excluded). Provider classification and import-review fields appear in admin/import-review views only
— there is **no** anime/manga badge on user-facing cards.
