# TVWatchTime — Complete Technical Documentation

_Comprehensive knowledge base. Last updated: 2026-07-09._

## Table of Contents
1. [Product Overview](#1-product-overview)
2. [Architecture](#2-architecture)
3. [Monorepo Structure](#3-monorepo-structure)
4. [Database Schema](#4-database-schema)
5. [Backend Modules](#5-backend-modules)
6. [Mobile App](#6-mobile-app)
7. [Admin Console](#7-admin-console)
8. [API Reference](#8-api-reference)
9. [Auth & Security](#9-auth--security)
10. [Metadata System](#10-metadata-system)
11. [Import System](#11-import-system)
12. [Notifications](#12-notifications)
13. [Comments & Images](#13-comments--images)
14. [Stats & Gamification](#14-stats--gamification)
15. [Background Jobs](#15-background-jobs)
16. [Admin System](#16-admin-system)
17. [Environment Variables](#17-environment-variables)
18. [Deployment](#18-deployment)

---

## 1. Product Overview

Cross-platform (iOS + Android) TV/movie tracker. Users track watched episodes/movies, manage watchlists, import history from TVTime, get push notifications for new episodes, view rich stats, badges, leaderboards, and comment on content.

**Stack:** Expo (React Native) + NestJS + PostgreSQL + Redis/BullMQ + S3/MinIO + Next.js admin.

---

## 2. Architecture

```
┌─────────────┐    ┌──────────────────────────────────────────┐    ┌─────────────┐
│  Expo App   │───▶│  NestJS API (port 4000)                  │───▶│ PostgreSQL  │
│  (mobile)   │◀───│  ┌─────────────────────────────────────┐ │    │ (port 5432) │
└─────────────┘    │  │ Auth · Tracking · Stats · Import    │ │    └─────────────┘
                   │  │ Notifications · Comments · Admin    │ │    ┌─────────────┐
┌─────────────┐    │  └─────────────────────────────────────┘ │───▶│ Redis       │
│ Admin Web   │───▶│  ┌─────────────────────────────────────┐ │    │ (port 6379) │
│ (Next.js    │◀───▶│  │ BullMQ Workers                      │ │    └─────────────┘
│  port 3000) │    │  │ Import · Push · Hydration           │ │    ┌─────────────┐
└─────────────┘    │  └─────────────────────────────────────┘ │───▶│ MinIO (S3)  │
                   │  External APIs: TMDb · TVmaze · OpenAI  │    │ (port 9000) │
                   └──────────────────────────────────────────┘    └─────────────┘
```

**Key rules:**
- Mobile **never** calls third-party APIs directly. All media data flows through backend.
- Backend normalizes + caches external metadata in PostgreSQL.
- Heavy work (import, push, image processing, hydration) runs in BullMQ workers.
- Secrets encrypted with AES-256-GCM (comment images, admin settings).
- All admin actions audit-logged.

---

## 3. Monorepo Structure

```
TVWatchTime/
├── apps/
│   ├── api/                    # NestJS backend (@tvwatch/api)
│   │   ├── prisma/schema.prisma # Source of truth data model
│   │   ├── prisma/seed.ts      # Demo user + seeded shows
│   │   └── src/
│   │       ├── admin/          # Admin module (roles, settings, hydration jobs, cron)
│   │       ├── auth/           # JWT + OAuth (Google/Apple/Facebook)
│   │       ├── badges/         # Auto-unlock badge system
│   │       ├── collections/    # Watchlist + favorites
│   │       ├── comment-images/ # Image upload pipeline (moderation → Sharp → encrypt → S3)
│   │       ├── common/         # Prisma, Redis, guards, decorators, feature flags, settings
│   │       ├── config/         # Env configuration
│   │       ├── import/         # ZIP/CSV/JSON import pipeline (BullMQ worker)
│   │       ├── library/        # Watch-next, upcoming, history
│   │       ├── lists/          # Custom lists
│   │       ├── media-metadata/ # TMDb + TVmaze providers, matching, discovery
│   │       ├── movies/         # Movie detail + watched/watchlist/favorite
│   │       ├── notifications/  # In-app + push + scheduler + cron manager
│   │       ├── shows/          # Show detail + episodes + seasons + character votes
│   │       ├── social/         # Comments, likes, follows, activity
│   │       ├── stats/          # Summary, shows, movies, leaderboard
│   │       ├── tracking/       # Mark/unmark watched (episodes, seasons, movies)
│   │       └── users/          # Profile, devices, account
│   ├── mobile/                 # Expo app (@tvwatch/mobile)
│   │   ├── app/                # Expo Router file-based routes
│   │   ├── components/         # Reusable UI (PosterCard, EpisodeCard, charts, etc.)
│   │   ├── context/            # AuthContext
│   │   ├── hooks/              # useSocialAuth, usePushNotifications, useTabPressReset
│   │   ├── api/                # HTTP client + React Query hooks
│   │   └── theme/              # Colors, spacing, typography
│   └── admin/                  # Next.js admin console (@tvwatch/admin)
│       ├── app/                # Admin pages (dashboard, media, users, jobs, settings)
│       ├── components/         # StatCard, ChartCard, Table, Badge, Pagination
│       └── lib/                # API client (axios), auth context
├── packages/
│   └── shared/                 # @tvwatch/shared — TypeScript types for both apps
└── docker-compose.yml          # PostgreSQL + Redis + MinIO
```

---

## 4. Database Schema

**52 tables** in PostgreSQL. Key relationships:

### User Data
| Table | Purpose |
|-------|---------|
| `users` | Core account (email, username, passwordHash, role, isSuspended) |
| `user_profiles` | 1:1 — displayName, bio, avatarUrl, coverUrl, isPrivate |
| `user_auth_providers` | OAuth links (GOOGLE/APPLE/FACEBOOK/EMAIL + providerUid) |
| `devices` | Push notification tokens per device |
| `follows` | Self-referential (follower → target) |
| `user_stats_summary` | Cached JSON stats (invalidated on watch events) |

### Media Metadata
| Table | Purpose |
|-------|---------|
| `media_items` | Polymorphic SHOW/MOVIE (title, poster, backdrop, status, popularity, addedCount) |
| `shows` | 1:1 with media_item — yearStart/End, network, runtime, seasonsCount, nextAirDate |
| `movies` | 1:1 — releaseDate, runtime, country, language |
| `seasons` | Belongs to show — number, title, isSpecial (S0), episodeCount |
| `episodes` | Belongs to season — number, title, airDate, airTime, runtimeMinutes, isFinale |
| `external_ids` | TMDb/IMDb/TVDB/Trakt IDs for dedup + import matching |
| `genres` / `media_genres` | Genre catalog + many-to-many |
| `watch_providers` / `media_watch_providers` | Where to watch (Netflix, etc.) |
| `cast_members` / `media_cast` | Actor catalog + many-to-many with character + sortOrder |

### User Tracking
| Table | Purpose |
|-------|---------|
| `user_show_status` | watchedCount, totalCount (excl. specials), lastWatchedAt — drives watch-next |
| `user_episode_status` | Per-episode watched bool + watchedAt + device (WatchDevice) |
| `user_movie_status` | Per-movie watched bool + watchedAt |
| `watch_history` | Append-only log — drives stats, charts, leaderboards (runtimeMinutes for time calc) |
| `watchlist_items` | Shows/movies user wants to watch |
| `favorites` | Favorite shows/movies (separate from watchlist) |
| `ratings` | 1-5 stars per episode (single-select vote) |
| `reactions` | 12 mood types per episode — **multi-select** (one row per user+episode+reaction) |
| `character_votes` | Favorite character per episode — keyed by `cast_id` (FK → `media_cast.id`) |

### Import System
| Table | Purpose |
|-------|---------|
| `imports` | Job record (sourceType, status, counts, storageKey) |
| `import_files` | Per-file detection (type, entity, headers, rowCount) |
| `import_items` | Per-row match status (MATCHED/UNMATCHED/NEEDS_REVIEW/DUPLICATE) |
| `import_applied_records` | For rollback — records what was created/updated |
| `import_logs` | Processing logs |

### Notifications
| Table | Purpose |
|-------|---------|
| `notifications` | In-app notifications (deduped by userId+dedupeKey) |
| `notification_preferences` | Per-category push/in-app toggles + quiet hours |
| `push_notification_jobs` | Queued push delivery (status, scheduledFor, attempts) |

### Admin
| Table | Purpose |
|-------|---------|
| `admin_audit_logs` | Every admin action |
| `app_settings` | Key-value settings (encrypted for secrets) |
| `feature_flags` | Toggle features (comments, imports, push, etc.) |
| `cron_jobs` / `cron_job_runs` | DB-managed cron schedule + run history |
| `hydration_jobs` / `hydration_job_items` | TMDb fill jobs with progress |
| `scheduled_hydrations` | Recurring auto-fill schedules |

### Other
| Table | Purpose |
|-------|---------|
| `comments` | Threaded comments (1 level deep, parentId) |
| `comment_images` | Encrypted image metadata (AES-256-GCM, storage keys) |
| `comment_likes` | Like table |
| `reports` | Comment moderation reports |
| `custom_lists` / `custom_list_items` | User-created lists |
| `activity` | User activity feed |
| `badges` / `user_badges` | Gamification |
| `user_stats_snapshots` | Historical stats |

**Special seasons (S0)** are excluded from: progress calculation, watch-next queries, total counts, and stats.

---

## 5. Backend Modules

### Auth (`auth/`)
- `JwtStrategy` — validates access tokens, checks user exists
- `AuthService` — register, login, social login (code exchange), refresh, issueSession
- Social flow: mobile gets authorization code → backend exchanges with provider (Google/Facebook) → verifies → creates/finds user
- `JwtAuthGuard` — default guard, checks `IS_PUBLIC_KEY`
- `OptionalJwtAuthGuard` — for public endpoints that personalize (search, discover)

### Tracking (`tracking/`) — Global
- `TrackingService.markEpisodeWatched` — upserts status, creates watch_history, bumps show count, emits `watch.episode` event
- `TrackingService.unmarkEpisodeWatched` — reverses all of the above
- `markSeasonWatched` / `markMovieWatched` / `unmarkMovieWatched`
- Ratings persist regardless of watched transition; reactions (multi-select) + character-vote are handled by the dedicated vote endpoints below
- `bumpShowCount` excludes specials and aired-only episodes

### Episode Interaction Voting (`shows/`) — Global
Icon-based voting on watched episodes across four categories. Percentages are hidden until the user votes in a category, then shown for every option (largest-remainder rounding, sums to 100 for single-select; independent for multi-select reactions).
- `ShowsService.getEpisodeDetail` returns an `interactions` object: `{ device, rating, reaction, character }` — each with the user's selection, `total` voters, and per-option `count`s (no voter identities). Cast members carry a stable `creditId` (`media_cast.id`) + `votes`.
- `voteDevice` / `voteRating` — single-select upsert (one active vote per user+episode).
- `voteReaction` — **multi-select toggle**: creates a `reactions` row if absent, deletes it if present. `getReactionSection` returns `userVotes[]` (array) + `total` (distinct users who reacted).
- `voteFavoriteCharacter` — single-select upsert keyed by `cast_id`; validates the cast belongs to the show's `media_cast`.
- Each vote endpoint returns the recomputed section so the client reconciles optimistically.
- `packages/shared/src/vote-math.ts` — `computePercentages` (largest-remainder) + `applyVoteChange` (optimistic count recompute), shared by API tests + mobile.

### Media Metadata (`media-metadata/`)
- `TmdbClient` — central HTTP client with global RPS limiter + 429 backoff (serialized calls across all consumers)
- `TmdbProvider` — normalizes TMDb responses → `Normalized*` objects
- `TvmazeProvider` — enriches air times by TVDB/IMDb lookup
- `MediaMetadataService` — persists normalized data (transaction-safe upsert), `ensureShowFull` / `ensureMovieFull`, `ensureAirtimes` (skips if already hydrated)
- `DiscoveryService` — search, discover, trending, recommendations (uses watch-history genres)
- `ImportMatcher` — title-based matching with confidence scoring

### Import (`import/`)
- `ImportProcessor` — BullMQ worker: upload → extract → parse → normalize → dedupe → match → preview
- `ImportService` — upload, confirm (apply), rollback, rebuild show statuses
- `lib/inference.ts` — TVTime + generic CSV entity detection
- `lib/matcher.ts` — DB exact → DB core-title → TMDb search, with per-show caching
- `lib/zip-validator.ts` — safe ZIP (encryption/nested/path-traversal/bomb rejection)
- `lib/csv.ts` — streaming CSV parser with delimiter detection
- Daily limit configurable via `IMPORT_DAILY_LIMIT`

### Notifications (`notifications/`)
- `NotificationService` — creates in-app + schedules push, respects preferences + global push kill-switch + daily push limit
- `PushService` — Firebase Admin SDK (production) or Expo Push API (Expo Go), cron every 5 min
- `NotificationScheduler` — hourly episode scan (today only, recency filter, premiere override), daily watchlist reminders, nightly TVmaze refresh

### Admin (`admin/`)
- `RolesGuard` — hierarchy-based role check (USER < VIEWER < SUPPORT < CONTENT_MANAGER < MODERATOR < ADMIN < SUPER_ADMIN)
- `CronManagerService` — DB-driven cron scheduling with run history, pause/resume, run-now
- `AdminService` — stats, charts, media management, user management, hydration jobs, settings
- `ScheduledHydrations` — recurring auto-fill from TMDb

### Common
- `FeatureFlagService` — 30s cached flag checks, enforced server-side
- `SettingService` — AES-256-GCM encrypted settings, 10s cache, `.env` fallback
- `PrismaService` / `RedisService` — global singletons

---

## 6. Mobile App

### Navigation (Expo Router)
```
(auth)/login.tsx          → Email + Google + Facebook
(auth)/register.tsx       → Email + social
(tabs)/shows.tsx          → Watch List (swipe-to-watch) + Upcoming (auto-scroll Today)
(tabs)/movies.tsx         → Watchlist + Watched + Favorites grids
(tabs)/explore.tsx        → Search (debounced) + Discover carousels
(tabs)/profile.tsx        → Banner + Stats + Leaderboard + Shows/Movies/Favorites
show/[id].tsx             → About (info, cast, ratings chart, comments) + Episodes
movie/[id].tsx            → Detail + actions + cast + comments
episode/[id].tsx          → Spoiler-aware (hides until watched) + icon-based voting (device/rating/reactions/favorite-character with community %) + comments
stats.tsx                 → Shows/Movies charts + badges + leaderboard
myshows.tsx               → To watch / Not started / Finished (virtualized, sticky headers)
notifications.tsx         → Center with read/unread
settings.tsx              → Profile edit + account
import.tsx                → File picker → compress → upload → review → confirm
comments.tsx              → Composer + image picker + one-level replies + @mentions
```

### Theme
- Background: `#0F1115`, Surface: `#171A21`, Accent: `#FFD60A` (yellow), Watched: `#22C55E` (green), Danger: `#EF4444`
- Progress bars: yellow when partial, green when 100%

### Responsive Grids
- `PosterCard` — accepts `style` prop (default marginRight, overridable to 0 in grids)
- Grids use chunked rows with `justifyContent: space-between` (no flexWrap/gap)
- `minCardWidth` prop: 110px (shows, 3/row) or 160px (movies, 2/row)
- Tablets auto-scale (more columns)

### Push Notifications
- `usePushNotifications` hook — requests permission, generates Expo push token, registers with backend
- Requires EAS projectId in `app.json → extra.eas.projectId`
- Skip silently if no projectId configured

---

## 7. Admin Console

### Pages
| Route | Purpose |
|-------|---------|
| `/` | Dashboard: 8 stat cards + 4 charts |
| `/analytics` | Overview, media, watch, notifications tabs |
| `/media` | Browse all shows/movies (searchable, filterable) |
| `/media/[id]` | Detail: seasons, cast, externals, rehydrate button |
| `/users` | User table with search, role badges, suspend |
| `/users/[id]` | Full user profile: stats, auth, devices, activity, role editor |
| `/jobs` | TMDb hydration jobs: 12 types, pages selector, live progress, cancel/retry |
| `/scheduled-hydrations` | Recurring auto-fill schedules with custom cron |
| `/cron` | System cron manager: enable/disable, edit schedule, run-now, history |
| `/admins` | Admin team list + audit trail |
| `/logs` | Audit logs with metadata |
| `/settings` | All settings (encrypted secrets, feature flags, system info) |

### Role Matrix
| Action | Viewer | Support | Content Mgr | Admin | Super Admin |
|--------|--------|---------|-------------|-------|-------------|
| View dashboard | ✅ | ✅ | ✅ | ✅ | ✅ |
| View media | ✅ | ✅ | ✅ | ✅ | ✅ |
| Trigger hydration | — | — | ✅ | ✅ | ✅ |
| View users | — | ✅ | ✅ | ✅ | ✅ |
| Manage users (role/suspend) | — | — | — | ✅ | ✅ |
| Edit settings | — | — | — | ✅ (masked) | ✅ (full) |
| Manage admins | — | — | — | ✅ | ✅ |
| Reveal secrets | — | — | — | — | ✅ |

---

## 8. API Reference

All endpoints under `/api`. Auth: `Authorization: Bearer <token>`.

### Auth
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/auth/register` | — | Email register |
| POST | `/auth/login` | — | Email login |
| POST | `/auth/social` | — | OAuth (provider + authorizationCode + redirectUri) |
| POST | `/auth/refresh` | — | Refresh token |

### Profile & Devices
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/me` | Current user |
| PATCH | `/me` | Update profile |
| DELETE | `/me` | Delete account |
| POST | `/devices/register` | Register push token |
| DELETE | `/devices/:id` | Remove device |

### Search & Discover (public, optional auth)
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/search?q=&type=` | Search shows/movies |
| GET | `/discover/shows` | Discover with filters |
| GET | `/discover/movies` | Discover movies |
| GET | `/trending/shows` | Trending |
| GET | `/trending/movies` | Trending |
| GET | `/discover/sections` | Home sections |

### Shows & Episodes
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/shows/:id` | Detail (auto-hydrates) |
| GET | `/shows/:id/episodes` | Seasons + episodes |
| GET | `/episodes/:id` | Episode detail (includes `interactions` aggregates) |
| POST/DELETE | `/episodes/:id/watched` | Mark/unmark |
| PUT | `/episodes/:id/vote/device` | Single-select device vote → section |
| PUT | `/episodes/:id/vote/rating` | Single-select 1–5 rating → section |
| PUT | `/episodes/:id/vote/reaction` | Multi-select reaction toggle → section |
| PUT | `/episodes/:id/vote/character` | Single-select favorite (by castId) → section |
| POST/DELETE | `/seasons/:id/watched` | Mark whole season |
| POST/DELETE | `/shows/:id/watchlist` | Watchlist toggle |
| POST/DELETE | `/shows/:id/favorite` | Favorite toggle |

### Movies
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/movies/:id` | Detail |
| POST/DELETE | `/movies/:id/watched` | Mark/unmark |
| POST/DELETE | `/movies/:id/watchlist` | Watchlist toggle |
| POST/DELETE | `/movies/:id/favorite` | Favorite toggle |

### Library
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/me/watch-next` | Watch next (grouped by recency) |
| GET | `/me/upcoming` | Upcoming calendar (past 7d + future) |
| GET | `/me/history` | Watch history (paginated) |
| GET | `/me/shows/progress` | Shows by status (watching/notStarted/finished) |

### Collections
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/me/watchlist?type=` | Watchlist |
| GET | `/me/favorites/shows` | Favorite shows |
| GET | `/me/favorites/movies` | Favorite movies |

### Stats & Badges
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/me/stats/summary` | Summary (cached) |
| GET | `/me/stats/shows` | Detailed show stats |
| GET | `/me/stats/movies` | Detailed movie stats |
| GET | `/me/stats/leaderboard?type=` | Watch-time ranking |
| GET | `/badges` | All badges |
| GET | `/me/badges` | User badges + progress |

### Lists
| Method | Path | Purpose |
|--------|------|---------|
| GET/POST | `/me/lists` | List operations |
| GET/PATCH/DELETE | `/lists/:id` | Manage list |
| POST/DELETE | `/lists/:id/items` | Add/remove items |

### Notifications
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/me/notifications` | List (paginated) |
| PATCH | `/me/notifications/:id/read` | Mark read |
| POST | `/me/notifications/mark-all-read` | Mark all |
| GET/PATCH | `/me/notification-preferences` | Preferences |

### Import
| Method | Path | Purpose |
|--------|------|---------|
| POST | `/imports/upload` | Upload ZIP/CSV/JSON |
| GET | `/imports/:id` | Status |
| GET | `/imports/:id/items?status=&entity=` | Preview (infinite scroll) |
| PATCH | `/imports/:id/items/:itemId` | Manual fix |
| POST | `/imports/:id/confirm` | Apply |
| POST | `/imports/:id/cancel` | Cancel |
| POST | `/imports/:id/rollback` | Undo |
| DELETE | `/imports/:id` | Cleanup |

### Comments & Social
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/comments?threadType=&threadId=` | List comments |
| POST | `/comments` | Create (one-level replies) |
| GET | `/comments/participants` | @mention suggestions |
| GET | `/comments/:id/replies` | Replies |
| POST/DELETE | `/comments/:id/like` | Like/unlike |
| POST | `/comments/:id/report` | Report |
| POST/DELETE | `/users/:id/follow` | Follow/unfollow |
| POST | `/comments/:commentId/image` | Upload image |
| GET | `/comment-images/:id` | Serve decrypted image |
| GET | `/comment-images/:id/thumbnail` | Serve thumbnail |
| DELETE | `/comment-images/:id` | Delete image |

### Feature Flags
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/feature-flags` | Public | All flags |

### Admin (all require JWT + role)
| Method | Path | Min Role |
|--------|------|----------|
| GET | `/admin/stats` | VIEWER |
| GET | `/admin/charts` | VIEWER |
| GET | `/admin/media` | VIEWER |
| GET | `/admin/media/:id` | VIEWER |
| GET | `/admin/users` | SUPPORT |
| PATCH | `/admin/users/:id` | ADMIN |
| GET | `/admin/admins` | ADMIN |
| POST | `/admin/jobs/hydrate` | CONTENT_MANAGER |
| GET | `/admin/jobs` | VIEWER |
| POST | `/admin/jobs/:id/cancel` | CONTENT_MANAGER |
| POST | `/admin/jobs/:id/retry` | CONTENT_MANAGER |
| CRUD | `/admin/scheduled-hydrations` | ADMIN |
| GET | `/admin/cron` | VIEWER |
| PATCH | `/admin/cron/:name` | ADMIN |
| POST | `/admin/cron/:name/trigger` | CONTENT_MANAGER |
| GET | `/admin/settings` | ADMIN |
| PATCH | `/admin/settings/:key` | SUPER_ADMIN |
| GET | `/admin/settings/:key` (decrypted) | SUPER_ADMIN |
| GET/PATCH | `/admin/feature-flags` | ADMIN |
| GET | `/admin/audit-logs` | ADMIN |

---

## 9. Auth & Security

### JWT Flow
1. Mobile sends email/password or OAuth code → `/auth/login` or `/auth/social`
2. Backend returns `{ accessToken (15m), refreshToken (30d), user }`
3. Mobile stores both in `expo-secure-store`
4. On 401 → mobile auto-refreshes via `/auth/refresh`
5. Refresh fails → redirect to login

### OAuth Code Exchange
- Mobile opens browser via `expo-auth-session` with PKCE
- User authenticates at Google/Facebook
- Redirects back with authorization code
- Mobile sends code to backend `/auth/social`
- Backend exchanges code for tokens using client secret (server-side only)
- Verifies ID token / access token → creates/finds user

### Roles & Permissions
- Stored on `users.role` enum
- `RolesGuard` checks hierarchy: any role ≥ required minimum passes
- Enforced server-side on every admin endpoint

### Encryption
- **Comment images:** AES-256-GCM envelope encryption (random data key per image, wrapped by master key)
- **Admin settings:** AES-256-GCM for sensitive values (API keys, secrets)
- **Master key:** `ENCRYPTION_MASTER_KEY` env (32 bytes)
- Encrypted data never sent to mobile app

### Image Moderation
- OpenAI `omni-moderation-latest` API
- Text + image sent together
- Rejects: sexual, violence, self-harm, hate, illicit
- Borderline → `needs_manual_review`
- Never publishes unmoderated images

---

## 10. Metadata System

### TMDb Integration
- **Endpoints used:** `/search/tv`, `/search/movie`, `/tv/{id}`, `/movie/{id}`, `/discover/tv`, `/discover/movie`, `/trending/*`, `/tv/popular`, `/tv/top_rated`, `/tv/airing_today`, `/tv/on_the_air`, `/movie/popular`, `/movie/top_rated`, `/movie/upcoming`, `/movie/now_playing`, `/genre/*`
- **Rate limiting:** Global serialized call chain, configurable RPS (default 40), 429 backoff with Retry-After + exponential + jitter
- **Image URLs:** `https://image.tmdb.org/t/p/{size}{path}` — stored in DB, mobile loads directly from TMDb CDN

### Hydration Flow
1. **Light upsert** (search/discover): creates stub MediaItem + external_ids, no seasons
2. **Full hydrate** (detail view, admin jobs, import matching): fetches show + all seasons + episodes + cast + providers + externals
3. **Upsert by (seasonId, number)**: preserves user progress across refreshes
4. **Special seasons (S0):** stored but excluded from counts/progress/watch-next
5. **TVmaze enrichment:** per-show, skips if already hydrated, nightly cron for RETURNING shows with upcoming episodes

### Matching (Import)
1. DB exact normalized title match (0.9 confidence)
2. DB core-title (strip parentheticals) match (0.85)
3. DB contains + normalized (0.8)
4. TMDb exact-title search → light upsert (0.75)
5. TMDb fuzzy → light upsert (0.5 → needs_review)
6. Per-show dedup: one lookup, all episodes resolved locally

---

## 11. Import System

### Supported Sources
- **ZIP** containing CSV files (TVTime GDPR export)
- **Standalone CSV** (generic)
- **Standalone JSON** (flexible schema)

### TVTime Files Processed
| File | Entity | Rows |
|------|--------|------|
| `seen_episode_source.csv` | Watched episodes | 1,380 |
| `tracking-prod-records.csv` (v1) | Watched episodes + watchlist + movies | 675 watch events |
| `tracking-prod-records-v2.csv` | Watched episodes (per-episode rows) + watchlist | 8,696 episodes |
| `user_tv_show_data.csv` | Watchlist + favorites | 422 |
| `followed_tv_show.csv` | Watchlist (active shows) | 355 |

### Pipeline (BullMQ Worker)
1. `uploaded` → `queued` → `extracting` (safe ZIP inspection)
2. `parsing` (CSV with delimiter detection)
3. `normalizing` (entity inference + field mapping)
4. `matching` (title-based, deduped, cached per show)
5. `ready_for_review` (preview persisted in DB)
6. User confirms → `importing` (batched apply)
7. `completed` (rebuilds user_show_status, invalidates stats)

### Apply Logic
- Episodes: upsert `user_episode_status` + create `watch_history` (with runtimeMinutes)
- Movies: upsert `user_movie_status` + create `watch_history`
- Watchlist: skip if already exists
- Favorites: skip if already exists
- Post-apply: rebuild `user_show_status` (watched/total counts excluding specials)

---

## 12. Notifications

### Types
| Category | Trigger | Channel |
|----------|---------|---------|
| EPISODE_TODAY | Episode airs today, show watched ≤30d or premiere | In-app + Push |
| WATCHLIST_REMINDER | Show not watched 14+ days | In-app + Push |
| BADGE | Milestone unlocked | In-app + Push |
| FOLLOW | New follower | In-app + Push |
| COMMENT_LIKE | Comment liked | In-app + Push |
| COMMENT_REPLY | Reply received | In-app + Push |

### Push Rules
- Max pushes per user per day: configurable (`MAX_PUSH_NOTIFICATIONS_PER_USER_PER_DAY`, default 3)
- Priority: season premieres first, then most recently watched
- Deduped per (user, episode, day)
- Watchlist reminders fire daily but rotate across shows: a show isn't reminded again until `WATCHLIST_REMINDER_SHOW_COOLDOWN_DAYS` (default 30) elapses, so a different show surfaces each day
- Global kill switch: `push_notifications` feature flag
- Per-category user preferences respected

### Delivery
- **Expo Go:** Expo Push API (`https://exp.host/--/api/v2/push/send`) with `EXPO_ACCESS_TOKEN`
- **Dev Build:** Firebase google-services.json in `android/app/` + gradle plugins in both `build.gradle` files. Requires `JAVA_HOME` set. Firebase auto-initializes at app startup.
- **Production:** Firebase Admin SDK (FCM for Android, APNs for iOS via FCM)
- **Self-hosted backends:** Can use push relay mode (`PUSH_MODE=relay`) — sends through the public instance's `POST /api/push/relay` endpoint (rate-limited per device token)
- Dispatch cron: every 5 minutes

### Push Modes (for self-hosted backends)
| Mode | Config | How it works |
|------|--------|-------------|
| `expo` (default) | `EXPO_ACCESS_TOKEN` set | Backend sends directly via Expo Push API |
| `relay` | `PUSH_MODE=relay` + `PUSH_RELAY_URL=https://public-server/api` | Backend sends to public relay → public server delivers via Expo |
| `none` | `PUSH_MODE=none` | No push delivery (in-app only) |

### Push Relay (public instance)
- `POST /api/push/relay` — public, no auth
- Accepts: `{ token, title, body, data }`
- Rate limited per token via Redis: `PUSH_RELAY_RATE_LIMIT` (default 10 per `PUSH_RELAY_RATE_WINDOW_MINUTES` default 10 min)
- Self-hosted backends call this when they don't have their own Expo token
- Self-hosted users still get push because the mobile app registers its Expo token with whatever backend it connects to

### Scheduled Jobs (DB-managed)
| Job | Schedule | Purpose |
|-----|----------|---------|
| `episode_notifications` | Hourly | Scan today's episodes, create notifications |
| `push_dispatch` | Every 5 min | Send due push jobs |
| `watchlist_reminders` | Daily 3 AM | Stale show reminders |
| `tvmaze_airtimes` | Daily 3 AM | Enrich missing air times |
| `scheduled_hydrations` | Hourly | Run enabled auto-fill schedules |

---

## 13. Comments & Images

### Comment System
- One level deep: top-level + replies (no reply-to-reply)
- Thread types: SHOW, MOVIE, EPISODE (threadId = media or episode ID)
- @mention suggestions: distinct participants in thread
- Likes, reports (SPAM, ABUSE, OFF_TOPIC, OTHER)
- Image support: one image per comment

### Image Pipeline
```
Mobile: expo-image-picker → expo-image-manipulator (resize 1600px, JPEG 0.8) → upload
Backend: → temp S3 (quarantine) → magic bytes validation → Sharp decode → OpenAI moderation
  → Sharp process (resize, strip metadata, WebP 95%, thumbnail 480px 85%) → blurhash
  → AES-256-GCM encrypt (per-image data key, wrapped by master key) → private S3
  → delete temp → mark ready
Delivery: backend fetches encrypted from S3 → decrypts → streams WebP to mobile
```

---

## 14. Stats & Gamification

### Stats Caching
- `user_stats_summary` — JSON cache, invalidated on: watch/unwatch, import, rate, follow, badge unlock
- Recomputed lazily on next read

### Stats Content
- **Summary:** TV time (months/days/hours), movie time, episodes/movies watched, remaining, added
- **Shows:** time chart, episodes chart, biggest marathons, top genres/networks, ratings, comments, catch-up speed + prediction, remaining episodes
- **Movies:** time chart, movies chart, top genres, ratings, comments, remaining, catch-up prediction
- **Season ratings:** per-episode ratings, swipeable seasons, SVG line chart (0-5 scale, user ratings only, unrated = 0, TMDb fallback configurable via `USE_API_FOR_EPISODES_CHART`)

### Badges (10)
| Badge | Category | Threshold |
|-------|----------|-----------|
| First Steps | WATCH | 1 episode |
| Getting Into It | WATCH | 10 episodes |
| Marathoner | MARATHON | 100 episodes |
| Cinephile | WATCH | 25 movies |
| Movie Buff | WATCH | 100 movies |
| Big Marathon | MARATHON | 6 episodes in 1 day |
| Critic | RATING | 10 ratings |
| Voice | COMMENT | 5 comments |
| Social Butterfly | FOLLOW | 5 follows |
| Welcome Aboard | APP_USAGE | First sign-in |

### Leaderboard
- Watch-time ranking among mutuals (users you follow who follow you back)
- Types: shows, movies, combined
- Top 10 + user's position (if outside top 10, separator + highlighted row)
- Time format: `1y 8mo 11d 12h`

---

## 15. Background Jobs

### BullMQ Queues
| Queue | Worker | Purpose |
|-------|--------|---------|
| `imports` | `ImportProcessor` | Parse + match + preview |
| `comment-images` | `CommentImageProcessor` | Validate → moderate → process → encrypt → upload |
| (inline) | `AdminService.processHydrationJob` | TMDb hydration per item |

### NestJS Schedule Crons
| Cron | Schedule | Purpose |
|------|----------|---------|
| `PushService.dispatchDue` | Every 5 min | Send due push jobs |
| `NotificationScheduler.scheduleEpisodeNotifications` | Hourly | Today's episode notifications |
| `NotificationScheduler.watchlistReminders` | Daily 3 AM | Stale show reminders |
| `NotificationScheduler.refreshAirtimes` | Daily 3 AM | TVmaze enrichment |
| `CronManagerService` (DB-driven) | Configurable | 5 system jobs + scheduled hydrations |

---

## 16. Admin System

### Feature Flags
Stored in `feature_flags` table. Enforced via `FeatureFlagService` (30s cache):
- `comments_enabled` — blocks POST /comments
- `imports_enabled` — blocks upload + mobile shows disabled state
- `push_notifications` — global push kill switch
- `public_profiles` — ready for profile visibility
- `recommendations` — ready for "Top For You"

### Settings
Stored in `app_settings` (encrypted for secrets). Enforced via `SettingService` (10s cache, `.env` fallback):
- TMDb: API key, language, RPS
- TVmaze: enabled, API key
- Trakt: client ID/secret
- Push: Expo access token
- Limits: import daily, push per user/day, image uploads/day, worker concurrency
- Images: max long edge, WebP quality, thumbnail settings

### Hydration Jobs
12 types: trending shows/movies, popular shows/movies, top-rated shows/movies, upcoming/now-playing movies, airing today, on the air, single show/movie by ID.

### Scheduled Hydrations
Recurring auto-fill: pick type + pages + cron schedule → runs automatically → tracks last run + job ID.

---

## 17. Environment Variables

See `.env.example` for full list. Key categories:
- **Core:** `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `CORS_ORIGINS`
- **OAuth:** `GOOGLE_CLIENT_ID/SECRET`, `FACEBOOK_APP_ID/SECRET`, `APPLE_*`
- **TMDb:** `TMDB_API_KEY`, `TMDB_RPS` (default 40), `TMDB_LANGUAGE`
- **TVmaze:** `TVMAZE_ENABLED`, `TVMAZE_API_KEY`
- **Push:** `EXPO_ACCESS_TOKEN`, `FIREBASE_*`, `APNS_*`
- **Push Relay:** `PUSH_RELAY_ENABLED`, `PUSH_RELAY_RATE_LIMIT`, `PUSH_RELAY_RATE_WINDOW_MINUTES`
- **Self-hosted push:** `PUSH_MODE` (expo|relay|none), `PUSH_RELAY_URL`
- **Storage:** `S3_ENDPOINT`, `S3_BUCKET_*`, `S3_ACCESS_KEY_ID/SECRET`
- **OpenAI:** `OPENAI_API_KEY`, `OPENAI_MODERATION_MODEL`
- **Encryption:** `ENCRYPTION_MASTER_KEY` (32+ chars)
- **Limits:** `IMPORT_DAILY_LIMIT`, `MAX_PUSH_NOTIFICATIONS_PER_USER_PER_DAY`, `MAX_COMMENT_IMAGE_UPLOAD_MB`
- **Jobs:** `METADATA_REFRESH_CRON`, `NOTIFICATIONS_DISPATCH_CRON`

### Mobile Config (`app.json → extra`)
| Key | Purpose | Default |
|-----|---------|---------|
| `apiBaseUrl` | Default backend URL (public instance) | `http://192.168.1.239:4000/api` |
| `publicApiUrl` | Public instance URL for push relay (constant, never changes) | `https://api.tvwatchtime.org/api` |
| `googleClientId` | Google OAuth Web Client ID | (set) |
| `facebookAppId` | Facebook App ID | (set) |
| `eas.projectId` | EAS project ID for push tokens | (set in local app.json) |

When user checks "Self-hosted backend" on login, `apiBaseUrl` is overridden by SecureStore. `publicApiUrl` always stays constant (push relay uses it).

All settings (except core connection strings) can be overridden via the admin console.

---

## 18. Deployment

### Development
```bash
docker compose up -d          # PostgreSQL + Redis + MinIO
pnpm install
pnpm db:generate && pnpm db:migrate && pnpm db:seed
pnpm dev:api                  # Backend :4000
pnpm dev:mobile               # Expo dev server
pnpm --filter @tvwatch/admin dev  # Admin :3000
```

### Self-Hosted Support
The mobile app supports connecting to either the public backend or a self-hosted instance:
- Login screen has a "Self-hosted backend" checkbox
- When checked: shows URL input, hides social login (email/password only)
- URL stored in SecureStore, editable in Settings
- API client reads from SecureStore via `getBaseUrl()`, falls back to `app.json` default
- `PUBLIC_API_URL` (from `app.json → extra.publicApiUrl`) is constant — used only for push relay
- Same app binary works for both public and self-hosted users

### Dev Build (Android)
Prerequisites: Android Studio + SDK 36, JDK 18, Firebase project
```bash
# 1. Configure
cp .env.example .env
# 2. Add google-services.json to apps/mobile/android/app/
# 3. Create android/local.properties with sdk.dir path
# 4. Build
cd apps/mobile
npx expo prebuild --platform android --clean
npx expo run:android
```
Windows notes:
- Use `node-linker=hoisted` in `.npmrc`
- Set `JAVA_HOME` as User environment variable
- SDK 54 recommended (SDK 57+ requires react-native-worklets CMake build)

### Production
- **Backend:** Docker container (Node.js)
- **Database:** Managed PostgreSQL
- **Redis:** Managed Redis
- **Storage:** AWS S3 (or compatible)
- **Mobile:** EAS Build → App Store / Play Store
- **Admin:** Vercel / Netlify / Docker

### Build
```bash
eas build --platform all      # Mobile standalone builds
eas submit --platform all     # Submit to stores
```

---

## 19. TVDB Integration

### Overview
TVDB (thetvdb.com) is a second metadata provider alongside TMDb. TVDB has a larger database for some shows.

### Architecture
```
DiscoveryService.search()
  ├── TmdbProvider.searchShows() → TMDb API
  ├── TmdbProvider.searchMovies() → TMDb API
  └── TvdbProvider.searchShows() → TVDB API (shows only)
      ↓
  Merge + dedupe by MediaItem ID (title-based matching links TVDB to existing TMDb shows)
      ↓
  Redis cache (10 min TTL)
```

### Configuration
| Var | Default | Purpose |
|-----|---------|---------|
| `TVDB_API_KEY` | — | Enables TVDB search + hydration |
| `TVDB_RPS` | `0` (unlimited) | Rate limit (0 = unlimited) |

### TVDB API Client (`tvdb.client.ts`)
- JWT auth: `POST /login` with `{ apikey }` → token cached 7 days
- Rate limiting: same serialize/chain pattern as TMDb
- `rps = 0` skips rate limiting entirely
- Automatic re-auth on 401, retry on 429

### TVDB Provider (`tvdb.provider.ts`)
- `searchShows(query)` — TVDB `/search?query=...&type=series`
- `getShow(tvdbId)` — TVDB `/series/{id}/extended` → full seasons, episodes, artworks, cast
- Maps TVDB data to `NormalizedShow` format (same as TMDb provider)
- Artwork via `TvdbClient.artwork()` — prefixes `https://artworks.thetvdb.com/banners/` only for **relative** paths (idempotent: skips already-absolute URLs). `mapper.util.normalizeImageUrl()` additionally heals any previously double-prefixed URLs at serve time.

### Hydration
- Shows with TVDB ID only (no TMDb) hydrate from TVDB via `ensureShowFullTvdb()`
- `ShowsService.getShow()` checks for TMDB first, falls back to TVDB

---

## 20. Moderation System

### Report Types
| Type | Target | Endpoints |
|------|--------|-----------|
| COMMENT | Comment | `POST /comments/:id/report` |
| IMAGE | Comment image | `POST /images/:id/report` |
| USER | User profile | `POST /users/:id/report` |

### Block System
- `POST /users/:id/block` — blocks user, auto-unfollows
- Blocked users' comments are filtered out in `CommentsService.list()` and `.replies()`
- `GET /me/blocked` — list blocked users

### Admin Moderation
| Endpoint | Role | Purpose |
|----------|------|---------|
| `GET /admin/moderation/reported-comments` | MODERATOR+ | Comments with report counts + reasons |
| `GET /admin/moderation/reported-images` | MODERATOR+ | Images with report counts |
| `GET /admin/moderation/reported-users` | MODERATOR+ | Users with report count + deleted comment count |
| `DELETE /admin/moderation/comments/:id` | MODERATOR+ | Admin-delete comment (hides + resolves reports) |
| `POST /admin/moderation/dismiss` | MODERATOR+ | Dismiss reports for a target |

### Schema
- `Report` model: `reporterId`, `targetType` (COMMENT/IMAGE/USER), `commentId`, `commentImageId`, `reportedUserId`, `reason`, `status`
- `Block` model: `blockerId`, `blockedId` (unique together)
- `Comment.adminDeleted` — tracks admin-deleted comments

---

## 21. Data Export & Deletion

### Data Export
- `POST /me/export-request` — generates JSON with user's data, returns download URL
- `GET /me/export-download?token=xxx` — serves the file (public, token-based)
- Expires in 24h, hourly cron deletes expired files
- Export includes: profile (no email/password), watch history, ratings, watchlist, favorites, comments, badges

### Data Deletion
- `POST /data-deletion/request` (public) — email input, creates token, sends email
- `GET /data-deletion/confirm?token=xxx` (public) — validates, cascade-deletes user, redirects to success page
- Public site form at `tvwatchtime.org/delete-account`

### Password Reset
- `POST /auth/forgot-password` (public) — email input, creates reset token (1h expiry), sends email
- `POST /auth/reset-password` (public) — token + new password
- Public site form at `tvwatchtime.org/reset-password`

---

## 22. Performance Tuning

### Redis Caching
| Data | TTL | Invalidated by |
|------|-----|----------------|
| Search results | 10 min | TTL expiry |
| Watch Next feed | 30 sec | Episode mark/unmark |
| Upcoming episodes | 60 sec | Episode mark/unmark |
| Feature flags | 30 sec | TTL expiry |
| Settings | 10 sec | TTL expiry |

### Database
- `DATABASE_CONNECTION_LIMIT` — Prisma pool size (default 20)
- Postgres tuning: `POSTGRES_SHARED_BUFFERS`, `POSTGRES_MAX_CONNECTIONS`, `POSTGRES_CACHE_SIZE`, `POSTGRES_WORK_MEM`
- All configurable for any server size

### External API Rate Limits
- `TMDB_RPS=0` — unlimited (automatic backoff on 429)
- `TVDB_RPS=0` — unlimited
- Both implement: Retry-After header parsing, exponential with jitter, max 4 retries, 30s cap

### Worker Concurrency
- `IMPORT_WORKER_CONCURRENCY` — import processing workers (default 2)
- `COMMENT_IMAGE_WORKER_CONCURRENCY` — image processing workers (default 2)

See `production-docs/scaling.md` for multi-instance deployment + recommended values by server size.

---

## 23. Notification System (Detailed)

### Episode Notifications
- **Schedule**: hourly cron finds episodes airing today
- **Eligibility**: users who watched ≥1 episode (cross-referenced with `userEpisodeStatus`)
- **Series premiere** (S1E1): notifies watchlist users only
- **Season premiere** (S2+E1): "🎬 {Show} is back!" message, priority sort
- **Spreading**: per-user push times spread across afternoon (noon→3pm→4pm→5pm...)
- **Configurable**: `NOTIFICATION_SPREAD_START_HOUR` (default 12 UTC)

### Watchlist Reminders
- **Schedule**: daily at 6 PM UTC (`0 22 * * *`)
- **Max 1 per user per day** — picks the most recently watched show with remaining episodes
- **Skips fully-watched shows** — checks for remaining unwatched aired episodes before sending

### TVmaze Air Time Refresh
- **Schedule**: daily at 3 AM UTC (`0 7 * * *`)
- Only RETURNING shows tracked by users with upcoming episodes missing air times
