# TVWatchTime — Project Status & Roadmap

_Last updated: 2026-07-06_

---

## ✅ DONE — Backend (NestJS + Prisma + PostgreSQL + Redis/BullMQ)

### Core
- [x] Auth: email/password + Google/Apple/Facebook OAuth (code exchange flow)
- [x] JWT access (15m) + refresh (30d) tokens with auto-refresh on mobile
- [x] Users: profile (avatar, cover, bio), settings, devices, suspend/unsuspend
- [x] Role system: USER → VIEWER → SUPPORT → CONTENT_MANAGER → MODERATOR → ADMIN → SUPER_ADMIN
- [x] Feature flags: comments, imports, push, public profiles, recommendations (enforced server-side)
- [x] Settings: all env settings editable in admin (encrypted AES-256-GCM for secrets)
- [x] Self-hosted support: mobile app can connect to custom backend URL, push relay for self-hosted users
- [x] Public push relay endpoint (`POST /api/push/relay`) with rate limiting per device token

### Media Metadata
- [x] TMDb provider: search, discover, trending (shows/movies), top-rated, popular, airing today, on the air, upcoming, now playing, single by ID
- [x] TVmaze provider: episode air times (enriched on hydration, nightly refresh)
- [x] Metadata caching: light-upsert on search, full hydrate on detail (seasons, episodes, cast, providers)
- [x] Safe hydration: seasons/episodes upserted (not replaced) — preserves user progress
- [x] Global TMDb rate limiter: configurable RPS (default 40), 429 backoff with Retry-After parsing
- [x] Special seasons (S0) excluded from progress/counts/watch-next

### Tracking
- [x] Watch history: mark/unmark episodes, mark/unmark whole seasons, mark/unmark movies
- [x] User episode status + user movie status + user show status (auto-rebuilt after import)
- [x] Watch-next: grouped by HISTORY (scroll up) → WATCH NEXT (recent 30 days) → NOT_RECENTLY
- [x] Upcoming: past 7 days + future, auto-scroll to Today→Tomorrow→This Week
- [x] Episode labels: Premiere, Finale, Aired (time-aware using airTime)
- [x] Ratings: 1-5 stars per episode/show/movie
- [x] Character votes: favorite character per episode (percentage-based)
- [x] Reactions: 12 mood types per episode
- [x] Swipe-left to mark episode watched (mobile)

### Collections
- [x] Watchlist (shows + movies)
- [x] Favorites (shows + movies, separate from watchlist)
- [x] Custom lists (create, edit, add/remove items, public/private)

### Stats & Gamification
- [x] Stats summary: TV time, movie time, episodes/movies watched, remaining, added counts
- [x] Show stats: charts (watch time, episodes, marathons), top genres/networks, catch-up prediction
- [x] Movie stats: charts, top genres, catch-up prediction
- [x] Season rating charts: per-episode community/user ratings, swipeable seasons, SVG line chart
- [x] Badges: 10 badges with auto-unlock on milestones (watch, marathon, rating, comment, social)
- [x] Leaderboard: watch-time ranking among mutuals, shows/movies/combined, formatWatchTime

### Comments
- [x] One-level replies (no reply-to-reply)
- [x] @mention suggestions (thread participants)
- [x] Likes, reports
- [x] Comment images: client-side compression, OpenAI moderation, Sharp processing (WebP 95%), AES-256-GCM encryption, S3 storage, blurhash thumbnails, full-screen viewer

### Import System
- [x] ZIP/CSV/JSON upload with safe ZIP validation (encryption/nested/path-traversal/bomb rejection)
- [x] TVTime GDPR export support: seen_episode_source, tracking-prod-records (v1+v2), user_tv_show_data, followed_tv_show
- [x] v2 per-episode rows parsed correctly (8696 episodes from tracking-prod-records-v2)
- [x] Title-based matching: DB exact → DB core-title → TMDb search → fuzzy (confidence scored)
- [x] Preview with matched/unmatched/needs_review/duplicate/invalid items
- [x] Infinite scroll preview, entity-type filters, status filters
- [x] Confirm/apply with rollback support
- [x] BullMQ background worker pipeline
- [x] Runtime minutes populated from episode/movie data for accurate stats

### Notifications
- [x] In-app notification center (read/unread, mark all read, delete)
- [x] Push notifications via Expo Push API (working in Expo Go AND dev builds)
- [x] Episode notifications: airs today, season premieres always, 30-day recency filter, daily push limit (configurable)
- [x] Watchlist reminders: shows not watched 14+ days
- [x] Push dispatch: every 5 min, deduped, respects preferences
- [x] Notification preferences per category (push/in-app toggles)
- [x] Badge unlock notifications
- [x] Admin: send test push to any user from user detail page

### Admin Console (Next.js + Tailwind + Recharts)
- [x] Dashboard: 8 stat cards, 4 charts (user growth, watch activity, media added, top shows)
- [x] Analytics: 4 tabs (overview, media, watch, notifications)
- [x] Media browser: searchable table, detail page (seasons, cast, externals, rehydrate button)
- [x] User management: table, detail page (stats, auth providers, devices, recent activity, role editor, suspend, test push)
- [x] Admin management: admin team list, audit trail
- [x] Hydration jobs: 12 job types, pages selector, live progress, cancel/retry
- [x] Scheduled hydrations: recurring auto-fill from TMDb (custom cron per type)
- [x] Scheduled jobs (cron manager): 5 system crons, configurable schedule, run history, enable/disable, run-now
- [x] Settings: all env settings (encrypted secrets with reveal/edit), feature flags toggles, system info
- [x] Audit logs: full audit trail with metadata
- [x] RolesGuard enforced server-side on every admin endpoint

### Database
- [x] 52+ tables
- [x] 1 user, 2,592+ media items, 125,000+ episodes, 8,787+ watch events

---

## ✅ DONE — Mobile (Expo SDK 54 + React Native)

### Navigation
- [x] Bottom tabs: Shows, Movies, Explore, Profile
- [x] Stack navigation: show/[id], movie/[id], episode/[id], stats, notifications, settings, import, more, myshows, list/[id], comments
- [x] Tab re-tap reset (scroll to top / reset to default)
- [x] Safe area support, dark theme

### Screens
- [x] Shows: Watch List (swipe-left + check button, auto-scroll to Watch Next) + Upcoming (auto-scroll to Today)
- [x] Movies: Watchlist/Watched/Favorites grids (responsive: 2/row phones, sticky + expandable headers)
- [x] Explore: search (debounced), discover carousels, clear button
- [x] Profile: banner (icons float over cover), stats carousel, leaderboard, shows/movies/favorites sections
- [x] My Shows: sticky + expandable headers, responsive grid, virtualized FlatList
- [x] Show detail: banner (title top, stats bottom), About (info, cast, community ratings chart, comments) + Episodes (seasons, mark all)
- [x] Movie detail: banner, actions (watched/watchlist/favorite), cast, comments
- [x] Episode detail: spoiler-aware (hides rating/reactions until watched), cast with character votes, comments
- [x] Stats: summary cards, shows/movies tabs with charts, badges grid, leaderboard
- [x] Notifications: center with read/unread, mark all
- [x] Settings: profile edit with image picker (avatar + cover), backend URL editor (self-hosted), account, logout, delete
- [x] Import: file picker, compression, upload, live status, preview review, confirm
- [x] Comments: composer with image picker, processing indicator, one-level replies, @mentions, image display
- [x] Login/Register: self-hosted checkbox → URL input → hides socials

### Features
- [x] Social login: Google + Facebook via expo-auth-session (code exchange)
- [x] Push notifications: expo-notifications with EAS projectId (works in Expo Go + dev builds)
- [x] Self-hosted backend support: checkbox on login, URL stored in SecureStore, editable in settings
- [x] Client-side image compression: expo-image-manipulator (1600px, JPEG 0.8)
- [x] Responsive grids: chunked rows with space-between (no flexWrap/gap bugs)
- [x] Green progress bars when show/movie is 100% watched

### Dev Build (Android)
- [x] expo-dev-client configured
- [x] Firebase google-services.json for FCM push
- [x] google-services gradle plugin applied (app/build.gradle + root build.gradle)
- [x] node-linker=hoisted in .npmrc (fixes Windows CMake path length issues)
- [x] JAVA_HOME set to JDK 18

---

## ✅ DONE — Admin Console (Next.js 14)

### Pages
| Route | Purpose |
|-------|---------|
| `/login` | Admin auth |
| `/` | Dashboard: 8 stat cards + 4 charts |
| `/analytics` | Overview, media, watch, notifications tabs |
| `/media` | Browse all shows/movies (searchable, filterable) |
| `/media/[id]` | Detail: seasons, cast, externals, rehydrate button |
| `/users` | User table (clickable rows → detail page) |
| `/users/[id]` | Full profile: stats, auth, devices, activity, role editor, suspend, test push |
| `/jobs` | TMDb hydration jobs: 12 types, pages selector, live progress, cancel/retry |
| `/scheduled-hydrations` | Recurring auto-fill schedules with custom cron |
| `/cron` | System cron manager: enable/disable, edit schedule, run-now, history |
| `/admins` | Admin team list + audit trail |
| `/logs` | Audit logs with metadata |
| `/settings` | All settings (encrypted secrets with reveal/edit), feature flags, system info |

---

## 🔲 TODO — Remaining Work

### High Priority
1. **Trakt sync** — two-way watched history sync (credentials in settings)
2. **Public profiles** — mobile screen to view other users, follow/unfollow
3. **Social feed** — activity feed of followed users
4. **Deep links** — `tvwatchtime://show/:id` from notifications opens correct screen
5. **Custom lists UI** — re-add to profile, create/manage screen

### Medium Priority
6. **Discover filters** — genre/year/status/runtime/provider filter UI
7. **Search history + autocomplete**
8. **More badges** — full catalog, scoped (per-show) badges
9. **Stats comparison** — compare with followed users
10. **Weekly digest push**

### Low Priority
11. **2FA/MFA** for admin accounts
12. **Log export** — CSV/JSON from admin
13. **Duplicate media merge** — Super Admin only
14. **Maintenance mode** — feature flag

### Technical Debt
- [ ] Add unit tests for: tracking, stats, import inference, notification scheduler, crypto
- [ ] Add e2e tests for: auth flow, import flow, mark-watched flow
- [ ] Add rate limiting on all API endpoints (@nestjs/throttler)
- [ ] Migrate from `prisma db push` to proper `prisma migrate` for production
- [ ] Add log retention policy
- [ ] Add orphan cleanup job for temp import files

---

## 🔑 Configured Services
| Service | Status |
|---------|--------|
| TMDb | ✅ API key set, 40 RPS |
| TVmaze | ✅ Enabled, air times enrichment |
| Google OAuth | ✅ Client ID/Secret set |
| Facebook OAuth | ✅ App ID/Secret set |
| Apple Sign-In | 🔲 Credentials not set |
| Expo Push | ✅ Access token set, working in dev build |
| Firebase (FCM) | ✅ google-services.json configured, dev build working |
| OpenAI Moderation | ✅ API key set |
| S3/MinIO | ✅ Running locally |
| Trakt | 🔲 Credentials not set |

---

## 📊 Database Stats (last verified)
| Metric | Count |
|--------|-------|
| Users | 1 |
| Media items | 2,592 |
| Episodes | 125,165 |
| Watch events | 8,787 |
| Notifications | 285+ |
| DB tables | 52+ |

---

## 🔧 Key Technical Notes

### Windows Build Setup
- Use `node-linker=hoisted` in `.npmrc` to avoid CMake path length issues on Windows
- Set `JAVA_HOME=C:\Program Files\Java\jdk-18.0.2` as a User environment variable
- Firebase requires `google-services.json` in `android/app/` + gradle plugin in both `build.gradle` files
- SDK 54 (not 57) to avoid react-native-worklets CMake dependency

### Push Notifications
- Expo Go: works via Expo Push API with EXPO_ACCESS_TOKEN
- Dev Build: requires Firebase google-services.json for Android FCM
- Self-hosted: can use push relay (`PUSH_MODE=relay`) to send through public server
- Rate limited: configurable per-user-per-day and relay-per-token-per-window

### Import System
- `tracking-prod-records-v2.csv` contains 8,696 per-episode watched rows (no type column)
- v2 rows with season+episode are treated as WATCHED_EPISODE (not watchlist)
- After import confirm, `rebuildShowStatuses` runs to populate user_show_status
- Runtime minutes are fetched from episode/movie data during apply (not from import)
- Special seasons (S0) excluded from all counts and progress

### Mobile Grid Layouts
- Use chunked-row FlatList pattern (NOT numColumns, NOT flexWrap/gap)
- `justifyContent: space-between` on row + filler Views for alignment
- `marginRight: 0` override on PosterCard via style prop in grids

### Mobile Swipe-to-Watch
- EpisodeCard wrapped in Swipeable from react-native-gesture-handler
- No wrapper View around Swipeable (causes layout issues)
- Green action panel behind card on left swipe
