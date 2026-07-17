# TVWatchTime — Project Status & Roadmap

_Last updated: 2026-07-10_

---

## ✅ DONE — Backend (NestJS + Prisma + PostgreSQL + Redis/BullMQ)

### Core
- [x] Auth: email/password + Google/Facebook OAuth (backend callback flow, no Expo proxy)
- [x] Forgot password: email-based reset link (1h expiry), public site reset page
- [x] Force password change on first login (bootstrap super admin)
- [x] Bootstrap super admin via `BOOTSTRAP_SUPER_ADMIN_EMAIL` env var
- [x] JWT access (15m) + refresh (30d) tokens with auto-refresh on mobile
- [x] Users: profile (avatar, cover, bio), settings, devices, suspend/unsuspend
- [x] Role system: USER → VIEWER → SUPPORT → CONTENT_MANAGER → MODERATOR → ADMIN → SUPER_ADMIN
- [x] Rate limiting: `@nestjs/throttler` (60/min global, 10/min auth, 5/min password reset)
- [x] Feature flags: comments, imports, push, public profiles, recommendations (enforced server-side)
- [x] Capability service: graceful degradation (missing config = feature disabled)
- [x] Settings: all env settings editable in admin (encrypted AES-256-GCM for secrets)
- [x] Self-hosted support: mobile app connects to custom backend URL, push relay for self-hosted users
- [x] Public push relay endpoint (`POST /api/push/relay`) with rate limiting per device token
- [x] Data deletion: email-based flow with token, public site form, cascade delete
- [x] Data export: JSON export with download link (24h expiry, hourly cleanup cron)

### Media Metadata
- [x] TMDb provider: search, discover, trending, top-rated, airing today, on the air, upcoming, now playing
- [x] TVDB provider: search + full hydration (seasons, episodes, cast, artwork) — merged with TMDb results
- [x] TVmaze provider: episode air times (enriched on hydration, nightly refresh)
- [x] Merged search: queries TMDb + TVDB in parallel, dedupes by title, TMDb results prioritized
- [x] Rate limiters: configurable RPS (0 = unlimited), 429 backoff with Retry-After, exponential jitter
- [x] Metadata caching: light-upsert on search, full hydrate on detail, Redis search cache (10 min TTL)
- [x] Safe hydration: seasons/episodes upserted (not replaced) — preserves user progress
- [x] Special seasons (S0) excluded from progress/counts/watch-next
- [x] Aired-only progress: unaired episodes excluded from watch-next + show detail progress bars

### Tracking
- [x] Watch history: mark/unmark episodes, mark/unmark whole seasons, mark/unmark movies
- [x] User episode status + user movie status + user show status (auto-rebuilt after import)
- [x] Watch-next: HISTORY → WATCH NEXT (fresh content prioritized) → START_WATCHING → NOT_RECENTLY
- [x] Watch-next: cross-references actual userEpisodeStatus counts (not just stale userShowStatus)
- [x] Watch-next: fresh content detection (next episode aired <30 days → WATCH_NEXT priority)
- [x] Upcoming: past 7 days + future, auto-scroll to Today→Tomorrow→This Week
- [x] Episode labels: Premiere, Finale, Aired (time-aware using airTime)
- [x] Redis cache invalidation on episode mark/unmark (watch-next + upcoming)
- [x] Ratings, character votes, reactions, swipe-to-watch
- [x] Episode voting redesign: icon-based tiles (device/stars/emoji reactions/portrait cast), community percentages revealed after voting
- [x] Multi-select reactions (toggle on/off, independent percentages); device/rating/character single-select
- [x] Favorite-character vote keyed by stable `cast_id` (not character name); list reorders by percentage once voted
- [x] Optimistic voting (per-section cache slices, rollback on error, server reconcile) — `useEpisodeVotes`
- [x] TVDB artwork double-prefix URL fix (idempotent `artwork()` + serve-time normalize)

### Collections
- [x] Watchlist (shows + movies)
- [x] Favorites (shows + movies, separate from watchlist)
- [x] Custom lists: create, edit, add/remove items, public/private
- [x] Custom lists: like, subscribe, bell notifications, share via deep link
- [x] Custom lists: pagination, owner edit mode, non-owner social actions
- [x] Custom lists: responsive grid (3-6 columns based on screen width)

### Social
- [x] Public profiles: view other users by username, follow/unfollow
- [x] Follow notifications: target user receives push + in-app notification
- [x] Followers/following lists: paginated, with follow-back buttons
- [x] User search: by username/displayName with follow toggle
- [x] Block users: hides their comments, auto-unfollows
- [x] Moderation: report comments, images, users — admin console with report counts + delete/dismiss

### Stats & Gamification
- [x] Stats summary, show/movie stats, charts, catch-up predictions
- [x] Movie runtime fallback: uses movie table runtime when watch history has null
- [x] Season rating charts: per-episode ratings, swipeable seasons, SVG line chart
- [x] Season 0 (Specials) label, default scrolls to Season 1
- [x] Badges: 10 badges with auto-unlock on milestones
- [x] Leaderboard: watch-time ranking among mutuals, shows/movies/combined

### Comments
- [x] One-level replies, @mention suggestions, likes, reports
- [x] Comment images: client compression, OpenAI moderation, Sharp WebP, AES-256-GCM, S3
- [x] Real-time polling (15s interval, configurable)
- [x] Sort toggle: Top (most liked) / Most Recent
- [x] Pagination: 20 items default, "Load more"
- [x] Blocked users' comments automatically filtered

### Import System
- [x] ZIP/CSV/JSON upload with safe ZIP validation
- [x] TVTime GDPR export support: all CSV variants (v1 + v2)
- [x] Title-based matching: DB → TMDb search → fuzzy
- [x] Batched apply: `createMany` in 5000-row chunks, single transaction — 21k items in <2s
- [x] Preview with matched/unmatched/needs_review, confirm/apply with rollback
- [x] Web-compatible file upload (HTML file input on web, DocumentPicker on native)

### Notifications
- [x] In-app notification center, push via Expo Push API
- [x] Episode notifications: spread across afternoon (noon→3pm→4pm→5pm...)
- [x] Season premiere: "🎬 {Show} is back!" message
- [x] Watchlist reminders: max 1 per user/day, skips fully-watched shows
- [x] List update notifications (subscribed lists with bell ON)
- [x] Push dispatch every 5 min, deduped, respects preferences + daily limit
- [x] Web push via VAPID + service worker (PWA push notifications)

### Admin Console (Next.js 14)
- [x] Dashboard, Analytics, Media, Users, Admins, Jobs, Scheduled Hydrations, Cron, Settings, Logs
- [x] Moderation page: reported comments/images/users with counts + delete/dismiss
- [x] Forgot password link on admin login

### Performance
- [x] Redis caching: search (10 min), watch-next (30s), upcoming (60s)
- [x] Cache invalidation on tracking mutations
- [x] Database connection pool, Postgres tuning (all configurable)
- [x] External API rate limits: 0 = unlimited with backoff
- [x] Configurable worker concurrency

---

## ✅ DONE — Mobile (Expo SDK 54 + React Native)

### Screens (all with pull-to-refresh)
- Shows (Watch List + Upcoming), Movies, Explore, Profile
- Show/Movie/Episode detail, Stats, Notifications, Settings, Import
- My Shows, Comments, Custom Lists (create/detail/my/followed)
- Find Users, User Profile, Follows, Forgot/Change Password
- Login/Register with eye toggle + confirm password + terms checkbox
- Web app (Expo Web) — same screens, PWA with service worker, web push

### Features
- Social login: Google + Facebook (backend OAuth callback)
- Push notifications, self-hosted backend support
- User image upload (avatar + cover), client-side compression
- First-time import popup, periodic Discord popup (every 3 days)
- Discord link in Settings, unaired episodes grayed out, aired-only progress bars

---

## ✅ DONE — Production & Infrastructure
- Docker: API + Admin Dockerfiles, docker-compose.prod.yml, Caddyfile (auto-HTTPS)
- Docker images on GHCR with OCI labels (auto-linked to repo)
- Public site: index, privacy, terms, delete-account, reset-password + Discord button
- GitHub repo: github.com/Metalingus/tvwatchtime (public, clean history)
- README with screenshots, self-hosting guide, TMDB + TVDB attribution
- Production docs: build-images, deploy, updating, scaling, mobile-build
- `.env.prod.example` + `docs/ENVIRONMENT.md` with all variables
- Web app (Expo Web) at `app.tvwatchtime.org` — PWA with service worker
- MinIO S3 storage: 3 separate buckets (user-images, comment-images, temp-uploads)
- S3 public access via Caddy proxy (`s3.tvwatchtime.org`)
- Web push (VAPID) + mobile push (Expo/Firebase)

---

## 🔲 TODO — Remaining Work

### High Priority
1. Deep links from notifications
2. Trakt sync
3. Social feed (activity of followed users)
4. Fix untracked show in upcoming
5. Fix JSON format

### Medium Priority
4. Discover filters (genre/year/status/provider)
5. Search history + autocomplete
6. More badges
7. Stats comparison with friends
8. iOS build + App Store submission

### Technical Debt
- [ ] Unit tests (tracking, stats, import, notifications, crypto)
- [ ] E2E tests (auth, import, mark-watched)
- [ ] `prisma migrate` instead of `db push` for production
- [ ] WebSocket/SSE for real-time comments (currently polling)

---

## 🔑 Configured Services
| Service | Status |
|---------|--------|
| TMDb | ✅ API key set, unlimited RPS |
| TVDB | ✅ API key set, unlimited RPS |
| TVmaze | ✅ Enabled, air times enrichment |
| Google OAuth | ✅ Backend callback flow |
| Facebook OAuth | ✅ Backend callback flow |
| Apple Sign-In | 🔲 Not set |
| Expo Push | ✅ Access token set |
| Firebase (FCM) | ✅ Configured |
| OpenAI Moderation | ✅ API key set |
| S3/MinIO | ✅ Running |
| Email (SMTP) | ✅ Configured |
| Trakt | 🔲 Not set |

---

## 🔧 Key Technical Notes

### Rate Limiting
- Global: 60 req/min per IP
- Auth: 10/min (login, register, social)
- Password: 5/min (change, forgot, reset)
- External APIs: 0 = unlimited, automatic backoff on 429

### Graceful Degradation
- No `OPENAI_API_KEY` → moderation skipped
- No S3/MinIO → comment images disabled, user images use local files
- No `TMDB_API_KEY` → seeded mock data
- No `TVDB_API_KEY` → search uses TMDb only
- No `EXPO_ACCESS_TOKEN` → push disabled (in-app only)
- No OAuth credentials → social login buttons hidden

### Import Optimization
- Batched apply: `createMany` in 5000-row chunks, single transaction
- 21k items in <2 seconds (was 25s with sequential inserts)

### Notification Spreading
- Episode notifications spread per user: noon, 3pm, 4pm, 5pm...
- Configurable via `NOTIFICATION_SPREAD_START_HOUR` (default 12 UTC)
- Watchlist reminders skip fully-watched shows
