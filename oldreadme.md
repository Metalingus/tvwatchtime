# TVWatchTime

A cross-platform (iOS + Android) TV/movie tracker inspired by popular watch-tracking apps. Users track shows & movies, manage watchlists, mark episodes/movies watched, import watch history from JSON, get push notifications for upcoming/aired episodes, and explore rich stats, badges, and a profile-centric identity layer.

> Built as an original product. No third-party branding, names, logos, or proprietary assets are used. All design inspiration is implemented with original UI and placeholder imagery.

## Stack (Option A — chosen)

| Layer        | Technology                                            |
| ------------ | ----------------------------------------------------- |
| Mobile       | React Native + Expo (Expo Router, expo-notifications) |
| Shared       | TypeScript types package (`@tvwatch/shared`)          |
| Backend      | NestJS + Prisma ORM                                    |
| Database     | PostgreSQL                                             |
| Cache/Queue  | Redis + BullMQ                                         |
| Notifications| FCM (Android) + APNs (iOS) via firebase-admin          |
| Storage      | S3-compatible (MinIO in dev)                           |
| Deploy       | Docker                                                 |

**Why over Flutter:** TS end-to-end with a shared types package, Expo OTA + EAS store builds, first-class push, and the RN chart/list/animation libs (Victory Native/Skia, FlashList, Reanimated) that this product's Stats and smooth scrollers depend on.

## Repository layout

```
TVWatchTime/
  apps/
    api/         # NestJS backend (@tvwatch/api)
    mobile/      # Expo app (@tvwatch/mobile)
  packages/
    shared/      # @tvwatch/shared types & API contracts
  docs/          # PRD, architecture, API contract, roadmap, ...
  docker-compose.yml
```

## Quick start

```bash
# 1) Install deps
pnpm install

# 2) Start infra (Postgres, Redis, MinIO)
docker compose up -d

# 3) Configure env
cp .env.example .env   # then edit, add TMDb/TVmaze keys when ready

# 4) Database
pnpm db:generate
pnpm db:migrate
pnpm db:seed

# 5) Run
pnpm dev:api        # backend on :4000
pnpm dev:mobile     # Expo dev server
```

When `TMDB_API_KEY` is absent, the backend serves **seeded mock metadata** so the app is fully usable offline. Add the key to switch to live metadata.

## Scripts

| Script             | Description                          |
| ------------------ | ------------------------------------ |
| `pnpm dev:api`     | Run NestJS in watch mode             |
| `pnpm dev:mobile`  | Start Expo                           |
| `pnpm db:migrate`  | Create/apply Prisma migration        |
| `pnpm db:seed`     | Seed dev data                        |
| `pnpm typecheck`   | Typecheck all workspaces             |
| `pnpm lint`        | Lint all workspaces                  |
| `pnpm test`        | Run all tests                        |

See `docs/` for the PRD, architecture, API contract, roadmap, testing & security.
