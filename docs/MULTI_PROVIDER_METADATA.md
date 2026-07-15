# Multi-Provider Metadata Architecture

TVWatchTime resolves media metadata from several providers, with a clear priority per
content type and a non-blocking enrichment pipeline. This document describes the final,
implemented behavior.

## Providers

| Provider | Role | Identity namespace | Retrieval notes |
|---|---|---|---|
| TMDB | Primary general provider | `TMDB` `SERIES`/`MOVIE` | API key required |
| TVDB v4 | General fallback **and** first-class source for TVDB-only media | `THE_TVDB` `SERIES`/`MOVIE`/`EPISODE` | API key (+ optional PIN), distributed token |
| Kitsu | Preferred anime/manga | `KITSU` `ANIME`/`MANGA` | Option B gateway/cache to public Kitsu catalogue |
| Jikan | MyAnimeList fallback (retrieval) | `MYANIME_LIST` `ANIME`/`MANGA` | Identity is MAL; Jikan is the retrieval provider. Optional self-host |

A verified external identity is the triple **(provider, providerEntityKind, value)**. Distinct
namespaces never collide: `(TMDB, SERIES, 123)` ≠ `(TMDB, MOVIE, 123)`; `(KITSU, ANIME, 9)` ≠
`(KITSU, MANGA, 9)`; TVDB series/movie/episode ids are in separate tables.

## Provider priority (field-by-field, never whole-record)

| Content | Priority |
|---|---|
| Anime (confirmed/probable) | **Kitsu > Jikan/MyAnimeList > TVDB > TMDB** |
| Manga publication metadata | **Kitsu > Jikan/MyAnimeList** |
| General (TMDB exists) | **TMDB > TVDB** |
| TVDB-only general (no TMDB) | **TVDB** (TMDB optional, attached later if a reliable mapping is found) |

TMDB/TVDB remain authoritative for **structural** fields (seasons, episodes, release structure,
watch history) of an anime/manga-classified adaptation — even when Kitsu/Jikan supply canonical
anime metadata. Manga chapters/volumes/serialization are **never** written onto an adaptation.

## Anime workflow (non-circular)

```
initial local/TMDB/TVDB metadata → detect anime candidate
→ Kitsu matching → Jikan/MyAnimeList fallback
→ final classification (confirmed / probable / general / unknown)
→ field-level metadata merge + provenance
```

- A **candidate** is anything with the TMDB `Animation` genre, a verified Kitsu/MAL anime id,
  strong TVDB anime signals, or a manual flag. `Animation` is a gate, not proof.
- **Confirmed** requires a reliable Kitsu or MAL match.
- **Probable** does NOT require a provider response: Animation + Japanese language/origin/studio
  evidence yields probable anime even when Kitsu/Jikan are unavailable (provider-unavailability is
  distinguished from a genuine no-match; reliable no-match is cached temporarily).
- Western animation with no reliable anime match stays **GENERAL**.
- Source show/movie category is **never** treated as classification.

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

After a confident import match, the same candidate→match→classify→hydrate workflow is enqueued
(deduplicated per local media id; non-blocking to applying watch history).

### TV Time file → known TVDB fields (header-based)

| File | Imported data | Known TVDB fields |
|---|---|---|
| `tracking-prod-records-v2.csv` | Watched episodes + watchlist | `s_id` (series), `episode_id` |
| `tracking-prod-records.csv` | Watched episodes, watchlist, show/movie | `series_id` |
| `show_seen_episode_latest.csv` | Watched episodes | `tv_show_id`, `episode_id` |
| `seen_episode_source.csv` | Watched episodes | `episode_id` |
| `followed_tv_show.csv` | Active show watchlist | `tv_show_id` |

`<nil>` and empty values are treated as null, never zero. Headers are matched by name (not position).

## Search (non-blocking)

1. Return immediate local/cache/TMDB results.
2. **Before returning**, enqueue background work (awaited only for the quick enqueue):
   - `tvdb-search:{query}:{type}:{locale}` — TVDB series **and** movie search, independent of anime
     matching. TVDB-only results are stored as **provisional** Redis candidates (TTL), **not** full
     media rows.
   - `classify-candidate:{mediaId|identity}` — candidate detection on results.
3. Return; never wait for TVDB/Kitsu/Jikan network work.

**Provisional vs permanent:** only *unused* background-search candidates are temporary. Selecting /
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

Same-identity concurrency → one record (namespace-aware lock). Cross-provider duplicates (e.g. a
TMDB id and a TVDB id of the same work) require explicit reconciliation: gather identities + direct
TMDB/TVDB mappings, compare title/year/type/episodes, and if confident, acquire a deterministic lock
derived from the **sorted** identities, then attach all identities to one record. Insufficient
evidence → review (no automatic merge; identities stay separate).

## Rate limiting & resilience

- Redis-backed **fixed-window** limiter (per-second + per-minute, atomic) shared across all
  instances/workers; separate concurrency semaphore with leases. TVDB token refresh is
  single-flighted via a distributed lock.
- Internal throttling returns a retry delay and is **not** a provider failure (does not trip the
  circuit breaker).
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
