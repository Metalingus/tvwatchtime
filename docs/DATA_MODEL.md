# Data Model

Source of truth: `apps/api/prisma/schema.prisma`. 52 tables.

See `docs/DOCUMENTATION.md` → Section 4 for the complete table reference.

## Key Relationships
```
User ──1:1──> UserProfile
User ──1:N──> UserAuthProvider (GOOGLE/APPLE/FACEBOOK/EMAIL)
User ──1:N──> Device (push tokens)
User ──M:N──> User (Follows, self-referential)
User ──1:N──> UserShowStatus (watchedCount, totalCount, lastWatchedAt)
User ──1:N──> UserEpisodeStatus (watched bool per episode)
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
MediaItem ──1:N──> ExternalId (TMDB/IMDB/TVDB/TRAKT)
```

## Special Rules
- Special seasons (`isSpecial = true`, S0) excluded from: progress, total counts, watch-next, stats
- `watch_history.runtimeMinutes` drives all time calculations (charts, leaderboard, catch-up prediction)
- `user_show_status` auto-rebuilt after import (not during)
- `notifications` deduped by `@@unique([userId, dedupeKey])`
- `user_stats_summary.stale` invalidated on watch/import/rate/follow events
