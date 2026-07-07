# Roadmap & Milestones

See `docs/To_DO.md` for the complete status tracker.

## Completed
- ✅ Full tracking app (shows, movies, episodes, watchlist, favorites)
- ✅ Stats + badges + leaderboard
- ✅ Import system (TVTime ZIP/CSV/JSON)
- ✅ Notifications (in-app + push via Expo)
- ✅ Comments with encrypted + moderated images
- ✅ Admin console (dashboard, media, users, jobs, cron, settings, hydrations)
- ✅ Feature flags + encrypted settings
- ✅ Scheduled hydrations (recurring TMDb auto-fill)
- ✅ OAuth (Google + Facebook code exchange)
- ✅ TMDb rate limiter (40 RPS, 429 backoff)
- ✅ Self-hosted backend support (URL override in SecureStore)
- ✅ Push relay (`POST /api/push/relay`) for self-hosted instances

## Next Priorities
1. EAS build (app stores) — needs `extra.eas.projectId` confirmed + OAuth redirect at `https://auth.expo.io/@backtoblack/tvwatchtime`
2. Firebase (production push)
3. Trakt sync
4. Public profiles + social feed
5. Deep links from notifications
6. Custom lists UI (re-add to profile)
7. Discover filters UI
8. Unit/e2e tests
9. `MetadataRefreshScheduler` (cron wired, impl pending)
