# Testing Strategy

See `docs/DOCUMENTATION.md` for architecture context.

## Backend (Jest)
- **Unit:** services with mocked PrismaService + EventEmitter2
  - `TrackingService` (count math, idempotency, specials exclusion)
  - `StatsService` (charts, durations, catch-up prediction)
  - `ImportService` (parse aliases, matching, apply logic)
  - `NotificationService` (dedup, preferences, daily limit)
  - `crypto.ts` (encrypt/decrypt round-trip)
  - `import.spec.ts` — 20 tests (zip safety + inference/normalization)
- **e2e:** controllers via Test.createTestingModule + supertest

Run: `pnpm --filter @tvwatch/api test`

## Mobile (Jest + React Native Testing Library)
- `timeAgo`, `fmtDuration`, `formatWatchTime`
- API client token refresh logic
- Component rendering (PosterCard, EpisodeCard, WatchButton)

## E2E (Maestro — planned)
Flows: login → track → stats → import → push

## CI Gates
`pnpm typecheck && pnpm lint && pnpm test`

## TODO
- [ ] Add unit tests for tracking, stats, notification scheduler
- [ ] Add e2e tests for auth, import, mark-watched
- [ ] Add `@nestjs/throttler` rate limiting tests
