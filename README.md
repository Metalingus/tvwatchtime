<div align="center">

# TVWatchTime

**Keep your watch history. Keep the community. Keep tracking.**

A cross-platform TV & movie tracking app for the people who refused to let go of TV Time.

[![Discord](https://img.shields.io/badge/Join-Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.gg/g9JBPUeqQV)
[![Platform](https://img.shields.io/badge/Platform-iOS%20%7C%20Android-22C55E?style=for-the-badge)]()
[![Status](https://img.shields.io/badge/Status-Beta%20Soon-FFD60A?style=for-the-badge)]()

</div>

---

## Why TVWatchTime?

I've been using TV Time since the beginning, so when I heard it was shutting down, I honestly couldn't just move on and pretend it didn't matter.

So I decided to build something new — a place for people who still want that same kind of TV/movie tracking experience and community. The goal is to keep the spirit of TV Time alive. All you have to do is import your data from TV Time and the transition should be seamless.

I've kept the main features people rely on: tracking shows and movies, watchlists, watched history, upcoming episodes, notifications, profiles, stats, comments, and more.

It's still in development, but I'm hoping to release a beta in the next couple of days. It will support both **Android and iOS**.

**Feedback, suggestions, feature requests, and bug reports are all welcome.** I really want this to be shaped by the people who will actually miss TV Time.


---

## Screenshots

### App

<table>
  <tr>
    <td width="33%" align="center"><b>Watch List</b></td>
    <td width="33%" align="center"><b>Upcoming</b></td>
    <td width="33%" align="center"><b>Movies</b></td>
  </tr>
  <tr>
    <td align="center"><img src="docs/screenshots/watch-list.jpg" alt="Watch List" width="250"></td>
    <td align="center"><img src="docs/screenshots/upcoming.jpg" alt="Upcoming" width="250"></td>
    <td align="center"><img src="docs/screenshots/movies.jpg" alt="Movies" width="250"></td>
  </tr>
  <tr>
    <td width="33%" align="center"><b>Explore</b></td>
    <td width="33%" align="center"><b>Show Page</b></td>
    <td width="33%" align="center"><b>Show About</b></td>
  </tr>
  <tr>
    <td align="center"><img src="docs/screenshots/explore.jpg" alt="Explore" width="250"></td>
    <td align="center"><img src="docs/screenshots/show_page.jpg" alt="Show Page" width="250"></td>
    <td align="center"><img src="docs/screenshots/show_about.jpg" alt="Show About" width="250"></td>
  </tr>
  <tr>
    <td width="33%" align="center"><b>Episode Details</b></td>
    <td width="33%" align="center"><b>Profile</b></td>
    <td width="33%" align="center"><b>Notifications</b></td>
  </tr>
  <tr>
    <td align="center"><img src="docs/screenshots/episode_details.jpg" alt="Episode Details" width="250"></td>
    <td align="center"><img src="docs/screenshots/profile.jpg" alt="Profile" width="250"></td>
    <td align="center"><img src="docs/screenshots/notifications.jpg" alt="Notifications" width="250"></td>
  </tr>
  <tr>
    <td width="33%" align="center"><b>Comments</b></td>
    <td width="33%" align="center"><b>TV Time Import</b></td>
    <td width="33%"></td>
  </tr>
  <tr>
    <td align="center"><img src="docs/screenshots/comments.jpg" alt="Comments" width="250"></td>
    <td align="center"><img src="docs/screenshots/import.jpg" alt="Import" width="250"></td>
    <td align="center"></td>
  </tr>
</table>

### Admin Console (self-hosters welcome)

<table>
  <tr>
    <td width="33%" align="center"><b>Admin Dashboard</b></td>
    <td width="33%" align="center"><b>User Management</b></td>
    <td width="33%" align="center"><b>Hydration Jobs</b></td>
  </tr>
  <tr>
    <td align="center"><img src="docs/screenshots/admin_dashboard.png" alt="Admin Dashboard" width="250"></td>
    <td align="center"><img src="docs/screenshots/admin_users.png" alt="Admin Users" width="250"></td>
    <td align="center"><img src="docs/screenshots/hydration_jobs.png" alt="Hydration Jobs" width="250"></td>
  </tr>
</table>

---

## Features

### Tracking
- **Shows & movies** — mark episodes, whole seasons, or films as watched
- **Watchlist & favorites** — separate lists for what's next and what you love
- **Watch-next** — smart grouping: history, airing soon, not recently watched
- **Upcoming** — episodes from the last 7 days + future, auto-scrolls to Today
- **Custom lists** — build your own collections

### Import
- **One-tap TV Time import** — upload your GDPR export (ZIP/CSV/JSON)
- **Seamless transition** — watched history, watchlist, favorites all carried over
- **Preview before apply** — review matches, fix unmatched items, rollback anytime
- **Special seasons (S0) excluded** — accurate progress, just like before

### Community
- **Comments with images** — one-level threads, @mentions, encrypted + moderated images
- **Ratings & reactions** — per-episode star ratings and mood reactions
- **Character votes** — pick your favorite character each episode
- **Leaderboards** — compare watch time with friends (shows / movies / combined)

### Insights
- **Stats** — total watch time, episodes/movies, charts by genre & network
- **Season rating charts** — see how every episode ranks (community + your rating)
- **Catch-up predictions** — when will you finish a show at your pace?
- **Badges** — 10 unlockable milestones

### Notifications
- **Episode reminders** — premieres always notified, daily limit respected
- **Push** — works in Expo Go, dev builds (Firebase), and self-hosted (relay)
- **In-app center** — read/unread, mark all, per-category preferences

### Self-Hosted Friendly
- Run your own backend — the same app connects to a public or private instance
- Login screen → **"Self-hosted backend"** → enter your URL → done
- Push notifications still work via the public relay (rate-limited)

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Mobile | React Native + Expo SDK 54 (Expo Router 6, expo-notifications) |
| Backend | NestJS 10 + Prisma 5 + PostgreSQL 16 |
| Cache/Queue | Redis 7 + BullMQ |
| Notifications | Expo Push API / Firebase Admin / Push Relay |
| Storage | S3-compatible (MinIO in dev) |
| Admin | Next.js 14 + Tailwind + Recharts |
| Metadata | TMDb + TVmaze |
| Moderation | OpenAI |
| Deploy | Docker |

---

## Get the App

The beta will be available for **Android and iOS** soon. Star this repo or join Discord to be notified.

<div align="center">

[**Join the Discord**](https://discord.gg/g9JBPUeqQV) · [**Report a bug**](../../issues) · [**Request a feature**](../../issues/new?labels=enhancement)

</div>

---

## Self-Hosting

Want to run your own instance? You keep full control of your data. The entire stack runs in Docker.

### Prerequisites
- A VPS or server with Docker + Docker Compose installed
- A domain name (e.g. `tvwatchtime.org`) with DNS A-records pointing to your server
- A [TMDb API key](https://developer.themoviedb.org/docs) (free)

### Quick deploy

```bash
# 1) Clone the repo
git clone https://github.com/Metalingus/TVWatchTime.git
cd TVWatchTime

# 2) Configure production env
cp .env.prod.example .env.prod
nano .env.prod   # Fill in passwords, JWT secret, TMDb key, BOOTSTRAP_SUPER_ADMIN_EMAIL

# 3) Pull pre-built images from GHCR (or build from source — see below)
docker compose -f docker-compose.prod.yml pull

# 4) Start everything
docker compose -f docker-compose.prod.yml up -d

# 5) Apply database schema
docker compose -f docker-compose.prod.yml exec api \
  pnpm --filter @tvwatch/api prisma db push

# 6) Verify
curl https://api.yourdomain.org/health   # → {"status":"ok"}
```

Set 3 DNS A-records to your server IP:
- `yourdomain.org` → public site (Privacy/Terms)
- `api.yourdomain.org` → API backend
- `admin.yourdomain.org` → admin console

[Caddy](Caddyfile) handles automatic HTTPS via Let's Encrypt — no cert setup needed.

### Create your super admin

Set `BOOTSTRAP_SUPER_ADMIN_EMAIL=you@email.com` in `.env.prod`, then register an account with that email in the mobile app (check "Self-hosted backend" and enter your API URL). You'll be promoted to SUPER_ADMIN and asked to set a new password.

### Build from source (instead of pulling)

```bash
docker compose -f docker-compose.prod.yml build
```

### Push notifications

Self-hosted instances can deliver push without their own Expo token:
- Set `PUSH_MODE=relay` and `PUSH_RELAY_URL=https://api.tvwatchtime.org/api` in `.env.prod`
- Your server sends pushes through the public TVWatchTime relay (rate-limited per device)

### Optional features (leave blank to disable)

| Feature | Required env | When missing |
|---------|-------------|-------------|
| Comment images | S3/MinIO config | Feature disabled |
| User avatars/covers | S3/MinIO config | Falls back to local server files |
| Image moderation | `OPENAI_API_KEY` | Moderation skipped |
| Google login | `GOOGLE_CLIENT_ID/SECRET` | Button hidden in app |
| Facebook login | `FACEBOOK_APP_ID/SECRET` | Button hidden in app |
| Push notifications | `EXPO_ACCESS_TOKEN` | Push disabled (in-app only) |
| TVmaze air times | `TVMAZE_API_KEY` | Feature skipped |

See [`docs/ENVIRONMENT.md`](docs/ENVIRONMENT.md) for the full variable reference.

### Backups

```bash
# Daily Postgres dump (add to crontab)
0 4 * * * docker exec tvwatch-postgres pg_dump -U tvwatch tvwatch \
  | gzip > /backups/tvwatch-$(date +\%Y\%m\%d).sql.gz \
  && find /backups -mtime +7 -delete
```

---

## For Contributors

### Repository layout

```
TVWatchTime/
  apps/
    api/         # NestJS backend (@tvwatch/api)
    mobile/      # Expo app (@tvwatch/mobile)
    admin/       # Next.js admin console (@tvwatch/admin)
  packages/
    shared/      # @tvwatch/shared types & API contracts
  docs/          # PRD, architecture, API contract, roadmap, ...
  public-site/   # Privacy Policy, Terms of Use, landing page
  docker-compose.yml          # Dev infra (Postgres, Redis, MinIO)
  docker-compose.prod.yml     # Production (API, admin, Caddy, MinIO)
  Caddyfile                   # Reverse proxy + auto-HTTPS
```

### Quick start

```bash
# 1) Install deps
pnpm install

# 2) Start infra (Postgres, Redis, MinIO)
docker compose up -d

# 3) Configure env
cp .env.example .env   # then edit, add TMDb/TVmaze keys when ready
cp apps/mobile/app.example.json apps/mobile/app.json   # fill in OAuth/EAS IDs

# 4) Database
pnpm db:generate
pnpm db:migrate
pnpm db:seed

# 5) Run
pnpm dev:api        # backend on :4000
pnpm dev:mobile     # Expo dev server
```

When `TMDB_API_KEY` is absent, the backend serves **seeded mock metadata** so the app is fully usable offline.

### Scripts

| Script | Description |
|--------|-------------|
| `pnpm dev:api` | Run NestJS in watch mode |
| `pnpm dev:mobile` | Start Expo |
| `pnpm --filter @tvwatch/admin dev` | Start admin console (:3000) |
| `pnpm db:migrate` | Create/apply Prisma migration |
| `pnpm db:seed` | Seed dev data |
| `pnpm typecheck` | Typecheck all workspaces |
| `pnpm lint` | Lint all workspaces |
| `pnpm test` | Run all tests |

### Documentation

| Doc | What's inside |
|-----|---------------|
| [`docs/DOCUMENTATION.md`](docs/DOCUMENTATION.md) | Full technical reference (18 sections) |
| [`docs/ENVIRONMENT.md`](docs/ENVIRONMENT.md) | Environment variables + feature degrade guide |
| [`docs/To_DO.md`](docs/To_DO.md) | Project status tracker |
| [`docs/PRD.md`](docs/PRD.md) | Product requirements |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Architecture decisions |
| [`docs/API_CONTRACT.md`](docs/API_CONTRACT.md) | Endpoint reference |
| [`docs/NOTIFICATIONS.md`](docs/NOTIFICATIONS.md) | Notification + push relay design |
| [`docs/SECURITY.md`](docs/SECURITY.md) | Security checklist |
| [`AGENTS.md`](AGENTS.md) | How to work in this repo |

---

## License

This project is source-available, but not open source.

You may download, run, and modify this software only for your own personal use.

You may not:
- host this software for other people;
- provide access to this software as a public, shared, hosted, or managed service;
- use this software for any commercial, business, nonprofit, educational, organizational, or community purpose;
- sell, rent, sublicense, monetize, or otherwise exploit this software;
- redistribute modified or unmodified copies without written permission.

Commercial, public, shared, or organizational use requires a separate written license from the author.

---

<div align="center">

**Made for the community that refused to let TV Time go.**

[Discord](https://discord.gg/g9JBPUeqQV) · [Issues](../../issues)

</div>
