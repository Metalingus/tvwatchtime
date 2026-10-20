# Environment Variables

This document describes every environment variable used by the TVWatchTime stack. Grouped by category. Anything under **Optional** has a documented fallback behavior — the app degrades gracefully rather than crashing.

See [`.env.prod.example`](../.env.prod.example) for a copy-paste template grouped by importance.
Self-hosters: start with the ranked guide in [SELF_HOSTING.md](SELF_HOSTING.md#configuration),
which explains what each key gives you and any admin step needed to turn it on.

---

## Must-Have (Required)

| Variable                | Purpose                                                              | Example                                                         |
| ----------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------- |
| `POSTGRES_USER`         | PostgreSQL user                                                      | `tvwatch`                                                       |
| `POSTGRES_PASSWORD`     | PostgreSQL password (use strong random)                              | `openssl rand -base64 32`                                       |
| `POSTGRES_DB`           | Database name                                                        | `tvwatch`                                                       |
| `POSTGRES_HOST`         | PostgreSQL host (Docker internal)                                    | `postgres`                                                      |
| `POSTGRES_PORT`         | PostgreSQL port                                                      | `5432`                                                          |
| `DATABASE_URL`          | Prisma CLI connection string (URL-encode special chars in password)  | `postgresql://tvwatch:pass@postgres:5432/tvwatch?schema=public` |
| `REDIS_HOST`            | Redis host                                                           | `redis`                                                         |
| `REDIS_PORT`            | Redis port                                                           | `6379`                                                          |
| `REDIS_PASSWORD`        | Redis password (use strong random)                                   | `openssl rand -base64 32`                                       |
| `JWT_SECRET`            | Signs access (7d) and refresh (30d) JWTs; keep it stable on restarts | `openssl rand -base64 64`                                       |
| `ENCRYPTION_MASTER_KEY` | 32-byte hex key for integration credentials, images, and settings    | `openssl rand -hex 32`                                          |
| `API_PORT`              | NestJS listen port                                                   | `4000`                                                          |
| `CORS_ORIGINS`          | Comma-separated allowed origins (admin + every web app origin)       | `https://admin.example.com,https://app.example.com`             |
| `NODE_ENV`              | `production` disables Swagger, gates seed                            | `production`                                                    |
| `TVWATCH_MODE`          | `domain` (HTTPS) or `local` (home network, adds `docker-compose.local.yml`) | `domain`                                                 |
| `TVWATCH_DOMAIN`        | Compose only: Caddy site names and the admin console's `API_URL`     | `example.com` (defaults to `tvwatchtime.org` when unset)        |
| `TVWATCH_LOCAL_URL`     | Home-network mode: address browsers use; also the admin `API_URL`    | `http://192.168.1.20`                                           |
| `TVWATCH_HTTP_PORT` / `TVWATCH_ADMIN_PORT` | Home-network mode: published web and admin ports  | `80` / `8080`                                                   |

> **Note:** The API reads `POSTGRES_*` and `REDIS_*` vars directly (passwords with special chars like `+`, `/`, `=` are fine). `DATABASE_URL` is only needed for the Prisma CLI (`prisma migrate deploy`) — URL-encode special chars there.

---

## Optional — Metadata Providers

| Variable                           | Default         | When Missing                                                                                    |
| ---------------------------------- | --------------- | ----------------------------------------------------------------------------------------------- |
| `TMDB_API_KEY`                     | —               | Search falls back to titles already in the database; no live metadata or hydration. Env only: the admin Settings TMDb row doesn't replace it |
| `TMDB_REQUESTS_PER_SECOND`         | `40`            | TMDb request rate (`TMDB_REQUESTS_PER_MINUTE`, `TMDB_CONCURRENCY` default `0` = no limit). `TMDB_RPS` is not read |
| `TMDB_LANGUAGE`                    | `en-US`         | Effectively unused: requests follow each user's app language                                     |
| `TVDB_API_KEY`                     | —               | Search uses TMDb only. With key: queries both TMDb + TVDB for shows                             |
| `TVDB_PIN`                         | —               | Only for TVDB keys tied to a user subscription                                                  |
| `TVDB_REQUESTS_PER_SECOND`         | `2`             | TVDB request rate (`TVDB_REQUESTS_PER_MINUTE` `60`, `TVDB_CONCURRENCY` `2`). `TVDB_RPS` is not read |
| `TVMAZE_ENABLED`                   | `false`         | Retired and ignored; TVmaze remains disabled even if set to true                                |
| `TVMAZE_API_KEY`                   | —               | Works without key (lower rate limit)                                                            |
| `STRUCTURE_REPAIR_ENABLED`         | `false`         | Hydration-triggered cross-media canonicalization stays disabled unless `true`                   |
| `TVDB_SCHEDULE_REFRESH_BATCH_SIZE` | `100`           | Default of the TVDB schedule refresh job's "Shows per run" option (clamped to 1–1000)           |

> Rate limiting is off only when both the per-second and per-minute values are `0`. Clients still back off on HTTP 429 (Retry-After) and 5xx. A changed TVDB key or PIN takes effect when the cached TVDB login token expires (up to 7 days) or fails.

`STRUCTURE_REPAIR_ENABLED=true` is a rollout gate for automatic cross-media canonicalization after
hydration (TMDB season-components folded into a TVDB aggregate). Scheduled structure repair no longer
depends on it: mixed episode graphs are repaired by the `identity_maintenance` job, whose Mode option
(apply / dry-run) is set in Scheduled Jobs.

---

## Optional - WatchForge identity evidence

- `WATCHFORGE_API_KEY`: developer catalog key. Read through ConfigService; never exposed to mobile.
- `WATCHFORGE_ENABLED`: defaults true when the key is present; false disables new lookups.
- **Daily limit:** read from the account's WatchForge `/me` (`rate_limit.per_day`, refreshed
  every 6 h) minus a safety margin of max(10, 2%). A higher tier is therefore picked up
  automatically.
  - `WATCHFORGE_REQUESTS_PER_DAY` (optional) only **caps** it lower. Leave it unset unless you
    deliberately want to spend less. 900 is used only while `/me` has never answered.
  - Spend is counted per UTC day in Redis and mirrored to `watchforge_usage_days`, so a Redis
    flush cannot reset it.
  - When WatchForge's `X-RateLimit-*` headers describe the daily window and show more usage than
    our count, they win.
- **Budget lanes** (shares of the daily limit; admin setting or env; normalized if they sum
  above 1):
  - `WATCHFORGE_LANE_INTERACTIVE_SHARE` (0.45): imports and integrations.
  - `WATCHFORGE_LANE_REPAIR_SHARE` (0.25): identity repair, structure authority, movie identity.
  - `WATCHFORGE_LANE_BACKLOG_SHARE` (0.3): the one-time catalog cleanup.
- **Lane rules:**
  - A lane never spends capacity still reserved for a higher-priority lane. Interactive and
    repair may borrow beyond their share.
  - After `WATCHFORGE_BACKLOG_RELEASE_HOUR_UTC` (21), the backlog may use unused reservations.
    Interactive then keeps only 10% of the day protected.
- **Never paying twice:** outcomes are stored per identifier in `watchforge_lookups` (outcome
  and WFDB id only, never the payload). Unmapped answers are kept 30 days, ambiguous 7 days,
  malformed 1 day. A malformed record quarantines only that identifier.
- Existing provider settings conventions apply: `WATCHFORGE_REQUESTS_PER_SECOND` (1),
  `WATCHFORGE_REQUESTS_PER_MINUTE` (50), `WATCHFORGE_CONCURRENCY` (1),
  `WATCHFORGE_TIMEOUT_MS` (10000), `WATCHFORGE_CACHE_TTL_SECONDS` (86400),
  and `WATCHFORGE_NEGATIVE_CACHE_TTL_SECONDS` (3600).
- **No inline retries.** Provider outages and quotas defer the lookup. Auth, 429 and 5xx
  cooldowns are shared across processes. A local concurrency-slot timeout never pauses
  WatchForge. Existing cached successes remain usable during a cooldown.
- **Queued identity repairs** deferred by quota or cooldown wait (as a BullMQ delay) until the
  budget reopens, without consuming retry attempts. They fail normally after 3 days.
- **Creating media never calls WatchForge**, with one exception: the Streaming Top Charts
  scheduled hydration may resolve a new chart series through the `repair` lane (corroborated like any other mapping).
  Otherwise missing crosswalks are left to the identity backlog. Existing media that a user flow
  needs an id for (SIMKL, integrations) may use it, in the interactive lane.
- WatchForge is a fallback inside existing identity resolution and Metadata Health repairs.
  There is no separate candidate/report workbench. The daily read-only `identity_audit` job only
  counts defects. Provider configuration alone never launches a catalog repair or import replay.
- Each `identity_maintenance` run first resumes metadata follow-ups of already-committed identity
  repairs. Durable operation receipts are in AdminAuditLog, independent of Redis cache expiry.

## Optional — Streaming charts (Movie of the Night)

Daily official top charts (Netflix, Prime Video, Disney+, Apple TV, HBO Max) for the Explore
"Top on <service> today" sections, from the Movie of the Night Streaming Availability API v4.

- `MOTN_API_KEY`: API key. A value stored in admin settings (API only; there is no form for it) overrides env. Server-only; never sent to clients.
- `MOTN_ENABLED` (true): false stops new calls; existing snapshots keep serving until stale (72 h).
- `MOTN_BASE_URL` (`https://api.movieofthenight.com/v4`).
- Provider conventions apply: `MOTN_REQUESTS_PER_SECOND` (1), `MOTN_REQUESTS_PER_MINUTE` (20),
  `MOTN_CONCURRENCY` (1), `MOTN_TIMEOUT_MS` (15000). Retries are forced to 0: every request,
  including a retry, consumes quota.
- **Quota:** the free plan allows 1000 requests per month as a hard cap (requests are refused
  until the reset, no overage fees). The quota is read from the `x-quota-*` response headers and
  shown on the admin Metadata Providers page.
- **Budget math:** 1 request per service per country per day. 5 services × 1 country × 31 days =
  155/month; the job allows at most 6 countries (5 × 6 × 31 = 930).
- Countries, services, budget and reserve are options of the **Streaming Top Charts** row in
  Admin → **Auto Hydrations** (page title "Scheduled Hydrations"; provisioned **disabled** by migration; daily 06:30 UTC). Saving
  an option set whose monthly projection exceeds the budget is refused, and a run stops before
  calling once the observed remaining quota can't cover it.

## Identity cleanup: no environment variables

The identity cleanup is configured in Admin → Scheduled Jobs → `identity_maintenance` → Options
(mode, steps, WatchForge use, time budget, repairs per run). See
[METADATA_OPERATIONS.md](METADATA_OPERATIONS.md#scheduled-jobs). The old `IDENTITY_BACKLOG_*`,
`STRUCTURE_BACKFILL_*` and `STRUCTURE_REPAIR_BATCH_SIZE` variables are no longer read.

Every import and integration sync writes a `provider-usage` import log with real provider
requests vs cache hits per provider and the elapsed time. Use it to find what makes imports slow.

## Optional — Inbound Integrations

| Variable                         | Default                              | Purpose                                                                                        |
| -------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `SIMKL_CLIENT_ID`                | —                                    | Enables SIMKL device authorization and inbound sync; create an API client with SIMKL           |
| `SIMKL_APP_NAME`                 | `tvwatch`                            | Stable app identifier sent as SIMKL's required `app-name` query parameter and User-Agent       |
| `SIMKL_APP_VERSION`              | `0.1.0`                              | Deployed app version sent as SIMKL's required `app-version` query parameter and User-Agent     |
| `INTEGRATION_APP_NAME`           | `TVWatch`                            | Product name sent in Plex and Emby client identity headers                                     |
| `INTEGRATION_APP_VERSION`        | `0.1.0`                              | Version sent in Plex and Emby client identity headers                                          |
| `ALLOW_PRIVATE_INTEGRATION_URLS` | `false` in production, `true` in dev | Allows Jellyfin, Plex, and Emby URLs resolving to private addresses for trusted networks       |
| `INTEGRATION_SYNC_BATCH_SIZE`    | `25`                                 | Maximum stale connected accounts refreshed by each scheduled run (clamped to 1–250)            |
| `INTEGRATION_SYNC_STALE_HOURS`   | `6`                                  | Minimum age of a successful sync before the account is eligible again (clamped to 1–168 hours) |

Stremio device authorization needs no server-side secret. Jellyfin and Emby store returned access
tokens—not user passwords—encrypted with `ENCRYPTION_MASTER_KEY`; Plex stores its account token the
same way. In production, media servers must use public HTTPS URLs unless private integration URLs
are explicitly enabled. This is a security-sensitive opt-in because the API server makes requests
to the configured or provider-advertised address.

---

## Optional — Storage (S3 / MinIO)

| Variable                   | Purpose                                                     |
| -------------------------- | ----------------------------------------------------------- |
| `MINIO_ROOT_USER`          | MinIO admin user (also used as `S3_ACCESS_KEY_ID`)          |
| `MINIO_ROOT_PASSWORD`      | MinIO admin password (also used as `S3_SECRET_ACCESS_KEY`)  |
| `S3_ENDPOINT`              | Internal Docker endpoint: `http://minio:9000`               |
| `S3_REGION`                | Region. Use `us-east-1` for MinIO                           |
| `S3_ACCESS_KEY_ID`         | Must match `MINIO_ROOT_USER`                                |
| `S3_SECRET_ACCESS_KEY`     | Must match `MINIO_ROOT_PASSWORD`                            |
| `S3_BUCKET`                | General media bucket (`tvwatch-media`)                      |
| `S3_BUCKET_COMMENT_IMAGES` | Comment images bucket (`tvwatch-comment-images`)            |
| `S3_BUCKET_TEMP_UPLOADS`   | Temp upload staging bucket (`tvwatch-temp-uploads`)         |
| `S3_PUBLIC_BASE_URL`       | **CRITICAL**: Public HTTPS URL for user avatar/cover images |

### S3_PUBLIC_BASE_URL — read this carefully

This MUST be a **public HTTPS URL** that browsers can reach. The internal Docker URL (`http://minio:9000`) is NOT accessible from browsers — it causes mixed-content errors and 403s.

**Setup:**

1. Add Caddy proxy: `s3.example.com { reverse_proxy minio:9000 }` (already in the [Caddyfile](../Caddyfile))
2. Add DNS A-record: `s3 → server IP`
3. Set: `S3_PUBLIC_BASE_URL=https://s3.example.com/tvwatch-user-images`

Avatar URLs become: `https://s3.example.com/tvwatch-user-images/avatars/{userId}.webp`

### MinIO Bucket Setup

Three buckets are used. The API creates all of them on demand (comment and temp buckets on
startup, the user-images bucket on the first avatar/cover upload).

| Bucket                   | Purpose                                   | Anonymous read? |
| ------------------------ | ----------------------------------------- | :-------------: |
| `tvwatch-user-images`    | User avatars + covers (plain WebP)        |       Yes       |
| `tvwatch-comment-images` | Comment images (AES-256-GCM encrypted)    | No (API serves) |
| `tvwatch-temp-uploads`   | Temp staging for comment image processing |       No        |

**One-time setup** after the first start — create the user-images bucket early and allow
anonymous **read-only** access to it:

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml exec minio sh -c '
  mc alias set local http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" &&
  mc mb --ignore-existing local/tvwatch-user-images &&
  mc anonymous set download local/tvwatch-user-images'
```

> Use `download` (read-only), not `public`: `public` also allows anonymous uploads. The API
> reads and writes every bucket with its own credentials.

> **When S3 not configured:** comment images disabled (503), user avatars/covers use local server files at `/uploads/*`.

---

## Optional — Moderation

| Variable                                           | When Missing                                                                          |
| -------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `OPENAI_API_KEY`                                   | Comment text and image moderation skipped. With a key, an OpenAI outage makes comment posting fail (503). |
| `AZURE_TRANSLATOR_KEY` / `AZURE_TRANSLATOR_REGION` | New comment/review translations are unavailable; cached translations still render.    |

### Comment and review translation

| Variable                    | Purpose                                             | Default                                         |
| --------------------------- | --------------------------------------------------- | ----------------------------------------------- |
| `AZURE_TRANSLATOR_KEY`      | Microsoft Azure Translator subscription key         | —                                               |
| `AZURE_TRANSLATOR_REGION`   | Azure resource region sent with Translator requests | —                                               |
| `AZURE_TRANSLATOR_ENDPOINT` | Translator Text API base URL                        | `https://api.cognitive.microsofttranslator.com` |

The public `GET /feature-flags` response exposes `comment_translation`. Keys and complete
provider responses must never be logged.

---

## Optional — OAuth

| Variable                                    | When Missing                        |
| ------------------------------------------- | ----------------------------------- |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google login button hidden in app   |
| `FACEBOOK_APP_ID` / `FACEBOOK_APP_SECRET`   | Facebook login button hidden in app |
| `APPLE_*`                                   | Sign in with Apple hidden. In production, a set `APPLE_CLIENT_ID` without `APPLE_TEAM_ID`, `APPLE_KEY_ID`, and `APPLE_PRIVATE_KEY` stops the API at startup |

---

## Optional — Push Notifications

| Variable                                  | Default | Purpose                                                                                      |
| ----------------------------------------- | ------- | -------------------------------------------------------------------------------------------- |
| `EXPO_ACCESS_TOKEN`                       | —       | Expo Push API token for direct delivery                                                      |
| `PUSH_MODE`                               | `expo`  | `expo` (direct) or `relay` (through the public server). `none` only hides push in feature flags; delivery still goes direct to Expo |
| `PUSH_RELAY_URL`                          | —       | Public relay URL for self-hosted `relay` mode                                                |
| `PUSH_RELAY_ENABLED`                      | `true`  | Whether the relay endpoint is mounted                                                        |
| `PUSH_RELAY_RATE_LIMIT`                   | `10`    | Max relay requests per token per window                                                      |
| `PUSH_RELAY_RATE_WINDOW_MINUTES`          | `10`    | Rate-limit window length                                                                     |
| `MAX_PUSH_NOTIFICATIONS_PER_USER_PER_DAY` | `3`     | Daily push cap per user                                                                      |
| `WATCHLIST_REMINDER_SHOW_COOLDOWN_DAYS`   | `30`    | Days before the same show is reminded again (rotates which show the daily reminder surfaces) |
| `WATCHLIST_REMINDER_STALE_DAYS`           | `14`    | Days since last watch before a show is considered stale and eligible for a reminder          |
| `NOTIFICATION_SPREAD_START_HOUR`          | `12`    | Hour, in each user's own time zone, to start spreading episode notifications (noon = 12)     |

> Episode notifications are spread across the afternoon: 1st at start hour, 2nd +3h, then +1h each. Prevents notification spam when multiple shows air the same day.

---

## Optional — Email (Data Deletion + Password Reset)

| Variable        | When Missing                                                                  |
| --------------- | ----------------------------------------------------------------------------- |
| `SMTP_HOST`     | Data deletion request/completion + password reset emails not sent             |
| `SMTP_PORT`     | Defaults to `587`                                                             |
| `SMTP_SECURE`   | Defaults to `false` (use `true` for port 465)                                 |
| `SMTP_USER`     | —                                                                             |
| `SMTP_PASSWORD` | —                                                                             |
| `SMTP_FROM`     | Defaults to `no-reply@tvwatchtime.org`                                        |
| `SITE_URL`      | Defaults to `https://tvwatchtime.org`. Used for deletion + reset email links. |

---

## Optional — Bootstrap

| Variable                      | Purpose                                                                                   |
| ----------------------------- | ----------------------------------------------------------------------------------------- |
| `BOOTSTRAP_SUPER_ADMIN_EMAIL` | First user registering with this email becomes `SUPER_ADMIN` with forced password change. |

---

## Performance Tuning

Defaults are safe for small servers (2GB RAM). Increase for larger hardware.

| Variable                            | Default | Purpose                                                              |
| ----------------------------------- | ------- | -------------------------------------------------------------------- |
| `DATABASE_CONNECTION_LIMIT`         | `20`    | Prisma connection pool size                                          |
| `POSTGRES_SHARED_BUFFERS`           | `256MB` | PostgreSQL shared buffers (set to ~25% of RAM)                       |
| `POSTGRES_MAX_CONNECTIONS`          | `100`   | PostgreSQL max connections                                           |
| `POSTGRES_CACHE_SIZE`               | `1GB`   | PostgreSQL `effective_cache_size` (set to ~75% of RAM)               |
| `POSTGRES_WORK_MEM`                 | `4MB`   | PostgreSQL `work_mem` per sort operation                             |
| `IMPORT_WORKER_CONCURRENCY`         | `2`     | Concurrent import processing workers                                 |
| `IMPORT_MATCH_CONCURRENCY`          | `8`     | Provider-miss concurrency per import (clamped 1–32)                  |
| `COMMENT_IMAGE_WORKER_CONCURRENCY`  | `2`     | Concurrent comment image processing workers                          |
| `LEADERBOARD_USER_REFRESH_DELAY_MS` | `2000`  | Debounce window for one user's incremental leaderboard score refresh |
| `LEADERBOARD_REBUILD_LOCK_TTL_SEC`  | `600`   | Distributed lock TTL for cold/recovery leaderboard initialization    |
| `PERSONALIZATION_CACHE_TTL_SEC`     | `1800`  | Last-good personalized ranking and shared taste-profile lifetime     |

### Recommended values for large servers (64GB RAM, 32+ threads)

```ini
DATABASE_CONNECTION_LIMIT=50
POSTGRES_SHARED_BUFFERS=16GB
POSTGRES_MAX_CONNECTIONS=300
POSTGRES_CACHE_SIZE=48GB
POSTGRES_WORK_MEM=16MB
IMPORT_WORKER_CONCURRENCY=10
IMPORT_MATCH_CONCURRENCY=8
COMMENT_IMAGE_WORKER_CONCURRENCY=5
```

---

## Admin Console

| Variable  | Purpose                                                                                                                                         |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `API_URL` | API base URL for the admin console (e.g. `https://api.example.com/api`). Read at **runtime** via server-side injection — no rebuild needed. `docker-compose.prod.yml` sets it to `https://api.${TVWATCH_DOMAIN}/api`. |

---

## Feature Degrade Summary

| Feature                      | Required Env                             | When Missing                                                |
| ---------------------------- | ---------------------------------------- | ----------------------------------------------------------- |
| Comment images               | S3/MinIO config                          | Disabled, upload returns 503                                |
| Comment GIF picker           | `app.json` extra `giphyApiKey*` (client) | Picker shows a configuration error                          |
| User avatars/covers          | `S3_PUBLIC_BASE_URL`                     | Falls back to local server files at `/uploads/*`            |
| Image and comment moderation | `OPENAI_API_KEY`                         | Local moderation skipped; no extra outbound moderation gate |
| Google login                 | `GOOGLE_CLIENT_ID/SECRET`                | Button hidden                                               |
| Facebook login               | `FACEBOOK_APP_ID/SECRET`                 | Button hidden                                               |
| Push notifications (mobile)  | `EXPO_ACCESS_TOKEN` or `PUSH_MODE=relay` | Push disabled (in-app only)                                 |
| Push notifications (web)     | `VAPID_PUBLIC_KEY/PRIVATE_KEY`           | Web push disabled                                           |
| TMDb metadata                | `TMDB_API_KEY`                           | Search uses titles already in the database only             |
| TVDB search                  | `TVDB_API_KEY`                           | Search uses TMDb only                                       |
| TVmaze air times             | Retired                                  | Always disabled; no active app or job requests              |
| Data deletion email          | `SMTP_HOST`                              | Email not sent (API logs the link instead)                  |
| Password reset email         | `SMTP_HOST`                              | Email not sent                                              |
| Admin console                | `API_URL` (runtime env)                  | Uses `localhost:4000` fallback                              |
| Streaming top charts         | `MOTN_API_KEY`                           | Run skips; `streaming_charts` flag false; sections hidden   |

### GIPHY GIF picker (mobile/web client-side only)

GIPHY keys live in **`apps/mobile/app.json`** under `expo.extra` (not in the API `.env`):

| `app.json` extra field | Used by        |
| ---------------------- | -------------- |
| `giphyApiKeyAndroid`   | Android client |
| `giphyApiKeyIos`       | iOS client     |
| `giphyApiKeyWeb`       | Web client     |

These are read by the mobile/web app via `expo-constants` (`Constants.expoConfig.extra`) and selected by `Platform.OS`. They are **not** used by the backend — the client calls the GIPHY REST API directly (`trending` / `search`). `apps/mobile/app.json` is gitignored; commit only the placeholder template `apps/mobile/app.example.json`. When a key is missing, the GIF picker shows a configuration error while the rest of comments continues to work. Stored `Comment.gifUrl` values accept public HTTPS URLs from any GIF provider; the picker remains Giphy-based.
