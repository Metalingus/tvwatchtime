# API Contract

Base: `/api`. Auth: `Authorization: Bearer <accessToken>`.
Paginated: `{ items, page, pageSize, total, hasMore }`.
Errors: `{ statusCode, message, path, timestamp }`.

Full endpoint reference: see `docs/DOCUMENTATION.md` → Section 8.

## Quick Reference

**Auth:** `/auth/register` · `/auth/login` · `/auth/social` · `/auth/refresh`

**Profile:** `GET/PATCH/DELETE /me` · `POST /devices/register`

**Search:** `/search` · `/discover/shows` · `/discover/movies` · `/trending/*` · `/discover/sections`

**Shows:** `/shows/:id` · `/shows/:id/episodes` · `/episodes/:id` · `/episodes/:id/watched` · `/seasons/:id/watched`

**Episode voting:** `PUT /episodes/:id/vote/device` · `PUT /episodes/:id/vote/rating` · `PUT /episodes/:id/vote/reaction` (toggle) · `PUT /episodes/:id/vote/character` — each upserts one active vote and returns the recomputed section (`{ userVote|userVotes, total, options }`). Reaction is multi-select (toggle on/off); the others are single-select.

**Movies:** `/movies/:id` · `/movies/:id/watched` · `/movies/:id/watchlist` · `/movies/:id/favorite`

**Library:** `/me/watch-next` · `/me/upcoming` · `/me/history` · `/me/shows/progress`

**Stats:** `/me/stats/summary` · `/me/stats/shows` · `/me/stats/movies` · `/me/stats/leaderboard`

**Collections:** `/me/watchlist` · `/me/favorites/shows` · `/me/favorites/movies`

**Notifications:** `/me/notifications` · `/me/notification-preferences`

**Import:** `/imports/upload` · `/imports/:id` · `/imports/:id/items` · `/imports/:id/confirm` · `/imports/:id/rollback`

**Comments:** `/comments` · `/comments/:id/like` · `/comments/:commentId/image` · `/comment-images/:id`

> `POST /comments` accepts an optional `gifUrl` (final GIPHY media URL, https, `*.giphy.com`). Comment responses include `gifUrl`. A comment may carry at most one attachment: an uploaded image XOR a GIPHY gif.

**Admin:** `/admin/stats` · `/admin/media` · `/admin/users` · `/admin/jobs/hydrate` · `/admin/cron` · `/admin/settings` · `/admin/feature-flags` · `/admin/scheduled-hydrations` · `/admin/audit-logs`

**Public:** `GET /feature-flags` · `GET /health` · `GET /comment-images/:id` · `GET /comment-images/:id/thumbnail` · `POST /push/relay`
