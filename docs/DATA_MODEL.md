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
User ──1:N──> Comment ──1:1──> current CommentImage (encrypted)
                     └─1:N──> retained CommentImage snapshots for shared URLs
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

Four single-user, multi-aggregate voting categories per episode (device / rating / reaction / character).
For provider semantics, read [Entity engagement fields](commsuni-api-integration.md#entity-engagement-fields);
for what is actually connected, see [current TVWatch support](COMMSUNI_INTEGRATION.md#current-engagement-support-2026-09-12).

- **device** — single-select, lives on `user_episode_status.device` (WatchDevice enum).
- **rating** — single-select, one `ratings` row per user+episode (1–5). Shared star counts use `options.starRatings[]`, the BAD→WOW five-bucket poll. The provider's separate numeric `rating` is not converted into this column.
- **reaction** — **multi-select**: one `reactions` row per user+episode+reaction (`@@unique([userId, episodeId, reaction])`); the live UI toggles rows on/off. Imported historical multi-emotions are all retained + counted. When verified CommsUni aggregates are displayed, `aggregateSource: commsuni` marks the source and `totalKind: selections` prevents interpreting an option-count total as distinct people. Local selections are preserved; the archive is not copied into these tables.
- **character** — single-select, one `character_votes` row per user+episode, keyed by **`cast_id`** (FK → `media_cast.id`, `onDelete: Cascade`). Movie character votes use the same table with one row per user+movie. A database check requires exactly one of `episode_id` or `media_id`. Never key votes by character name.

Local aggregates are computed on read via `groupBy`. Shared star/reaction counts instead use the
mapped provider totals plus all local MANUAL votes, deducting acknowledged native counterparts
using `CommsUniVoteReceipt`. `countedUserVote`/`countedUserVotes` identify the viewer's included manual
contribution for optimistic updates; imports never decrement the frozen archive. The same rule now
covers mapped device and character choices. Unmapped counted cast options carry separate display
metadata rather than fake local cast IDs.

**Percentages are derived client-side** using largest-remainder rounding. Single-select categories
sum to 100; reactions use each option's share of total selections and also sum to 100 when nonempty.
The local reaction `total` counts distinct voters; shared reaction `totalKind: selections` identifies
a selection count instead. No voter identities are exposed.

## CommsUni delivery receipts

`commsuni_vote_receipts` is additive acknowledgement storage keyed by partner actor scope,
opaque actor digest, entity reference/type, and engagement kind. The last provider option keys and
outbox sequence prevent acknowledged manual votes from being added twice. Reference/UUID aliases
are resolved to the latest receipt per actor and kind on read. The table has no User/Identity FK,
so credential cleanup cannot reintroduce duplicates in preserved anonymous vote totals. It contains
neither a raw actor credential nor downloaded archive populations. The migration must be applied
before vote delivery is enabled; current read-only operation has a guarded pre-migration fallback.

## Special Rules

- App-review scheduling is account-level: `users.created_at` is the registration
  anchor; `app_review_prompted_at` and `app_review_prompt_count` coordinate
  platform-specific prompt timing across devices.
- Positive season-wide watch/rewatch actions require a known air date through
  now; undated episodes remain individually editable and keep the existing
  progress semantics.
- An active full-show rewatch is anchored by
  `user_show_status.rewatch_started_at`. Distinct `watch_history` episode rows
  after that timestamp drive its cursor and progress; completion or explicit
  stop clears only the anchor.

- Special seasons (`isSpecial = true`, S0) excluded from: progress, total counts, watch-next, stats
- `watch_history.runtimeMinutes` drives all time calculations (charts, leaderboard, catch-up prediction)
- `user_show_status` auto-rebuilt after import (not during)
- Dropped shows keep their watchlist row and progress, remain excluded from Watch Next/upcoming/episode notifications, and appear only in the Dropped My Shows bucket until restored.
- `notifications` deduped by `@@unique([userId, dedupeKey])`
- `user_stats_summary.stale` invalidated on watch/import/rate/follow events
- Voting sections render only for watched episodes/movies; writes are upsert-style (one active vote per user+target+category, except multi-select reactions)
- Account deletion preserves community aggregates under a unique non-login deleted-user ghost: only comments needed as ancestors of another account's replies remain, while comments without surviving replies are deleted. Ratings, reactions, character votes, and device votes remain. Retained episode/movie device rows are cleared to `watched=false`, `watchedAt=null`, and `watchCount=0`; all private tracking/list/account data is deleted with the original user.
- `POST /movies/:id/reassign` (user-facing, movie→movie only): moves ONE user's engagement to a different movie row — `user_movie_status` (merge-on-conflict: watched OR, earliest watched_at, max watch_count), `watch_history`, media-scoped `ratings` (newest updated_at wins), `reactions` (dedupe per type), `watchlist_items`, `favorites`, `custom_list_items` (scoped via list ownership — no user_id column), the user's OWN comments, and a movie character vote only when a provider role alias or compatible provider-namespaced person proves the target role. Unproven votes stay on the source and are reported unresolved. Ends with `StatsService.invalidate({userId})`. `added_count` is NOT adjusted (known gap, same as the admin merge). Show→show is intentionally unsupported (needs episode-level mapping).


## Mobile compatibility metadata

Comment.hasLocalRevision marks a local-only edit of imported/captured/shared content.
Comment.clientRequestHash retains the original create-request identity independently of later
local edits. A partial thread index covers locally revised rows for shared-page overlays. Both fields are additive and are not required inputs from existing clients.

CommentImage.commentId remains unique for the current attachment but is nullable after detachment.
CommentImage.retainedCommentId keeps captured/public images and retired attachment metadata owned
by the original Comment. Check constraints require an owner and require both owner references to
agree when both are present. Retained rows cascade with their comment; current and retained image
userId values follow a preserved comment during account anonymization. Public serving checks the
owning comment's visibility regardless of which relation is active.
