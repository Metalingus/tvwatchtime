# Data Model

Source of truth: `apps/api/prisma/schema.prisma`. 52 tables.

See `docs/DOCUMENTATION.md` → Section 4 for the complete table reference.

## Key Relationships

```
User ──1:1──> UserProfile
User ──1:N──> UserAuthProvider (GOOGLE/APPLE/FACEBOOK/EMAIL)
User ──1:N──> Device (push tokens)
User ──M:N──> User (Follows, self-referential)
User ──1:N──> UserShowStatus (progress plus mutually exclusive paused/dropped states)
User ──1:N──> UserEpisodeStatus (watched bool + device per episode)
User ──1:N──> UserMovieStatus (watched bool per movie)
User ──1:N──> WatchHistory (append-only, runtimeMinutes for time calc)
User ──1:N──> WatchlistItem / Favorite / Rating / Reaction / CharacterVote
User ──1:N──> Comment ──1:1──> CommentImage (encrypted)
User ──1:N──> Notification / PushNotificationJob
User ──1:N──> Import ──1:N──> ImportItem (match status)
User ──1:N──> CustomList ──1:N──> CustomListItem

MediaItem ──1:1──> Show ──1:N──> Season ──1:N──> Episode
MediaItem ──1:1──> Movie
MediaItem ──M:N──> Genre (via MediaGenre)
MediaItem ──M:N──> WatchProvider (via MediaWatchProvider)
MediaItem ──M:N──> CastMember (via MediaCast, with character + sortOrder)
MediaCast ──1:N──> MediaCastExternalId (title-scoped provider role aliases)
MediaItem ──1:N──> ExternalId (TMDB/IMDB/TVDB/TRAKT)
```

## Episode Interaction Voting

Four single-user, multi-aggregate voting categories per episode (device / rating / reaction / character):

- **device** — single-select, lives on `user_episode_status.device` (WatchDevice enum).
- **rating** — single-select, one `ratings` row per user+episode (1–5).
- **reaction** — **multi-select**: one `reactions` row per user+episode+reaction (`@@unique([userId, episodeId, reaction])`); the live UI toggles rows on/off. Imported historical multi-emotions are all retained + counted.
- **character** — single-select, one `character_votes` row per user+episode, keyed by **`cast_id`** (FK → `media_cast.id`, `onDelete: Cascade`). Movie character votes use the same table with one row per user+movie. A database check requires exactly one of `episode_id` or `media_id`. Never key votes by character name.

Aggregates (per-option counts + total voters) are computed on read via `groupBy`; **percentages are derived client-side** (largest-remainder → sums to 100 for single-select categories; independent rounding for multi-select reactions). No voter identities are exposed.

## Special Rules

- Special seasons (`isSpecial = true`, S0) excluded from: progress, total counts, watch-next, stats
- `watch_history.runtimeMinutes` drives all time calculations (charts, leaderboard, catch-up prediction)
- `user_show_status` auto-rebuilt after import (not during)
- Dropped shows keep their watchlist row and progress, remain excluded from Watch Next/upcoming/episode notifications, and appear only in the Dropped My Shows bucket until restored.
- `notifications` deduped by `@@unique([userId, dedupeKey])`
- `user_stats_summary.stale` invalidated on watch/import/rate/follow events
- Voting sections render only for watched episodes/movies; writes are upsert-style (one active vote per user+target+category, except multi-select reactions)
- Account deletion preserves community aggregates under a unique non-login deleted-user ghost: only comments needed as ancestors of another account's replies remain, while comments without surviving replies are deleted. Ratings, reactions, character votes, and device votes remain. Retained episode/movie device rows are cleared to `watched=false`, `watchedAt=null`, and `watchCount=0`; all private tracking/list/account data is deleted with the original user.
- `POST /movies/:id/reassign` (user-facing, movie→movie only): moves ONE user's engagement to a different movie row — `user_movie_status` (merge-on-conflict: watched OR, earliest watched_at, max watch_count), `watch_history`, media-scoped `ratings` (newest updated_at wins), `reactions` (dedupe per type), `watchlist_items`, `favorites`, `custom_list_items` (scoped via list ownership — no user_id column), the user's OWN comments, and a movie character vote only when a provider role alias or compatible provider-namespaced person proves the target role. Unproven votes stay on the source and are reported unresolved. Ends with `StatsService.invalidate({userId})`. `added_count` is NOT adjusted (known gap, same as the admin merge). Show→show is intentionally unsupported (needs episode-level mapping).
