---
paths:
  - "apps/api/src/notifications/**"
  - "apps/mobile/hooks/usePushNotifications.ts"
  - "apps/mobile/hooks/useWebPush.ts"
  - "apps/mobile/hooks/useNotificationNavigation.ts"
  - "apps/mobile/hooks/useReleaseClock.ts"
  - "apps/mobile/lib/release-*.ts"
  - "apps/mobile/app/notifications.tsx"
---

# Notifications and push

- **Read `docs/PUSH_DELIVERY.md` first** (registration, scheduling, timezone spread). Also
  `docs/NOTIFICATIONS.md` and `docs/RELEASE_DATES.md` (airDate/airTime semantics, frequency).
  Background: `DOCUMENTATION.md` §12 and §23.
- `notification.scheduler.ts` covers episode and watchlist notifications plus export cleanup. Its
  methods are decorator-free: they run only through `CronManagerService`. Never add `@Cron`.
- Known broadcast instants (`airDate` + `airTime`) are eligible at the real instant regardless of
  viewer timezone. Date-only provider values keep their calendar date; never treat UTC midnight as
  a broadcast instant.
- Special seasons and unaired episodes are excluded (see the domain invariants in AGENTS.md).
- `PUBLIC_API_URL` (`app.json` extra) is the push relay endpoint.
- Sending real pushes or broadcasts to users is an external action. Ask first.
