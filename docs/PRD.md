# TVWatchTime — Product Requirements Document

> Cross-platform TV/movie tracker. Last updated: 2026-07-05.

## Goals
- Personal source of truth for "what I've watched / what's next"
- Import history from TVTime and other apps
- Rich stats, badges, leaderboards
- Episode reminders (push + in-app)
- Comment system with image support and moderation

## Personas
- **Binge tracker:** wants progress, watch-next, catch-up predictions
- **Stats nerd:** wants time watched, charts, badges, marathon records
- **Migrator:** coming from TVTime with a JSON/CSV export
- **Social watcher:** follows friends, compares watch time, comments
- **Self-hoster:** runs their own backend instance, keeps data private, still gets push via relay

## Feature Modules (current state)

| Module | Status | Notes |
|--------|--------|-------|
| Auth (email + Google/Facebook OAuth) | ✅ Live | Code exchange flow |
| Show/movie tracking | ✅ Live | Episodes, seasons, movies, progress |
| Watch-next + Upcoming | ✅ Live | Recency buckets, specials excluded |
| Import (ZIP/CSV/JSON) | ✅ Live | TVTime v1+v2, 8696+ episodes |
| Stats + charts + badges | ✅ Live | Show/movie/season charts, 10 badges |
| Leaderboard | ✅ Live | Mutuals, shows/movies/combined |
| Notifications (in-app + push) | ✅ Live | Expo push, daily limits, priority |
| Comments (one-level + images) | ✅ Live | Encrypted, moderated, blurhash |
| Admin console | ✅ Live | Full CRUD, hydration jobs, cron, settings |
| Feature flags + settings | ✅ Live | Server-enforced, encrypted secrets |
| Scheduled hydrations | ✅ Live | Recurring TMDb auto-fill |
| Self-hosted backend support | ✅ Live | URL override in SecureStore, push relay, single binary |
| Custom lists | ✅ Backend | UI removed from profile (re-add planned) |
| Social (follows, activity) | ✅ Backend | Mobile UI planned |
| Trakt sync | 🔲 Planned | Credentials in settings |
| Public profiles | 🔲 Planned | Backend ready |
| Deep links | 🔲 Planned | Scheme registered |

## Design Language
- Dark theme (#0F1115), yellow accent (#FFD60A), green watched (#22C55E)
- Large poster/backdrop imagery, smooth scrolling, skeleton loading
- Card-based layout, responsive grids (2-3 per row phones, more on tablets)
- iOS/Android safe areas, accessible touch targets (≥44pt)

## Metrics (proposed)
- D7/D30 retention, episodes/user/week, import completion rate, push opt-in rate
