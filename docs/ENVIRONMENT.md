# Environment Variables

This document describes every environment variable used by the TVWatchTime stack. Grouped by category. Anything under **Optional** has a documented fallback behavior — the app degrades gracefully rather than crashing.

See [`.env.prod.example`](../.env.prod.example) for a copy-paste template with all variables.

---

## Must-Have (Required)

| Variable | Purpose | Example |
| --- | --- | --- |
| `POSTGRES_USER` | PostgreSQL user | `tvwatch` |
| `POSTGRES_PASSWORD` | PostgreSQL password (use strong random) | `openssl rand -base64 32` |
| `POSTGRES_DB` | Database name | `tvwatch` |
| `POSTGRES_HOST` | PostgreSQL host (Docker internal) | `postgres` |
| `POSTGRES_PORT` | PostgreSQL port | `5432` |
| `DATABASE_URL` | Prisma CLI connection string (URL-encode special chars in password) | `postgresql://tvwatch:pass@postgres:5432/tvwatch?schema=public` |
| `REDIS_HOST` | Redis host | `redis` |
| `REDIS_PORT` | Redis port | `6379` |
| `REDIS_PASSWORD` | Redis password (use strong random) | `openssl rand -base64 32` |
| `JWT_SECRET` | Signs access (15m) and refresh (30d) JWTs | `openssl rand -base64 64` |
| `ENCRYPTION_MASTER_KEY` | 32-byte hex key for comment image + admin settings encryption | `openssl rand -hex 32` |
| `API_PORT` | NestJS listen port | `4000` |
| `CORS_ORIGINS` | Comma-separated allowed origins | `https://admin.tvwatchtime.org` |
| `NODE_ENV` | `production` disables Swagger, gates seed | `production` |

> **Note:** The API reads `POSTGRES_*` and `REDIS_*` vars directly (passwords with special chars like `+`, `/`, `=` are fine). `DATABASE_URL` is only needed for the Prisma CLI (`db push`) — URL-encode special chars there.

---

## Optional — Metadata Providers

| Variable | Default | When Missing |
| --- | --- | --- |
| `TMDB_API_KEY` | — | App serves seeded mock data |
| `TMDB_RPS` | `0` (unlimited) | `0` = no rate limit, automatic backoff on 429 |
| `TMDB_LANGUAGE` | `en-US` | — |
| `TVDB_API_KEY` | — | Search uses TMDb only. With key: queries both TMDb + TVDB for shows |
| `TVDB_RPS` | `0` (unlimited) | `0` = no rate limit |
| `TVMAZE_ENABLED` | `true` | — |
| `TVMAZE_API_KEY` | — | Works without key (lower rate limit) |

> **Rate limit = 0** means unlimited. The client skips the serialize chain entirely but still backs off on HTTP 429 (Retry-After header) and 5xx (exponential with jitter, max 4 retries, 30s cap).

---

## Optional — Storage (S3 / MinIO)

| Variable | Purpose |
| --- | --- |
| `MINIO_ROOT_USER` | MinIO admin user (also used as `S3_ACCESS_KEY_ID`) |
| `MINIO_ROOT_PASSWORD` | MinIO admin password (also used as `S3_SECRET_ACCESS_KEY`) |
| `S3_ENDPOINT` | Internal Docker endpoint: `http://minio:9000` |
| `S3_REGION` | Region. Use `us-east-1` for MinIO |
| `S3_ACCESS_KEY_ID` | Must match `MINIO_ROOT_USER` |
| `S3_SECRET_ACCESS_KEY` | Must match `MINIO_ROOT_PASSWORD` |
| `S3_BUCKET` | General media bucket (`tvwatch-media`) |
| `S3_BUCKET_COMMENT_IMAGES` | Comment images bucket (`tvwatch-comment-images`) |
| `S3_BUCKET_TEMP_UPLOADS` | Temp upload staging bucket (`tvwatch-temp-uploads`) |
| `S3_PUBLIC_BASE_URL` | **CRITICAL**: Public HTTPS URL for user avatar/cover images |

### S3_PUBLIC_BASE_URL — read this carefully

This MUST be a **public HTTPS URL** that browsers can reach. The internal Docker URL (`http://minio:9000`) is NOT accessible from browsers — it causes mixed-content errors and 403s.

**Setup:**
1. Add Caddy proxy: `s3.tvwatchtime.org { reverse_proxy minio:9000 }`
2. Add DNS A-record: `s3 → VPS IP`
3. Set: `S3_PUBLIC_BASE_URL=https://s3.tvwatchtime.org/tvwatch-user-images`

Avatar URLs become: `https://s3.tvwatchtime.org/tvwatch-user-images/avatars/{userId}.webp`

### MinIO Bucket Setup

Three buckets are used:

| Bucket | Purpose | Auto-created? | Public-read? |
|--------|---------|:---:|:---:|
| `tvwatch-user-images` | User avatars + covers (plain WebP) | No — create manually | Yes |
| `tvwatch-comment-images` | Comment images (AES-256-GCM encrypted) | Yes (on API startup) | Yes |
| `tvwatch-temp-uploads` | Temp staging for comment image processing | Yes (on API startup) | Yes |

**Manual setup commands** (run once after first deploy):
```bash
source .env.prod
docker exec tvwatchtime-minio-1 mc alias set local http://localhost:9000 $MINIO_ROOT_USER $MINIO_ROOT_PASSWORD
docker exec tvwatchtime-minio-1 mc mb local/tvwatch-user-images
docker exec tvwatchtime-minio-1 mc anonymous set public local/tvwatch-user-images
docker exec tvwatchtime-minio-1 mc anonymous set public local/tvwatch-comment-images
docker exec tvwatchtime-minio-1 mc anonymous set public local/tvwatch-temp-uploads
```

> **Public-read is safe:** Comment images are encrypted — unreadable without `ENCRYPTION_MASTER_KEY`. User avatars are already public (shown on profiles).

> **When S3 not configured:** comment images disabled (503), user avatars/covers use local server files at `/uploads/*`.

---

## Optional — Moderation

| Variable | When Missing |
| --- | --- |
| `OPENAI_API_KEY` | Image moderation skipped. Images still processed and stored. |

---

## Optional — OAuth

| Variable | When Missing |
| --- | --- |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google login button hidden in app |
| `FACEBOOK_APP_ID` / `FACEBOOK_APP_SECRET` | Facebook login button hidden in app |
| `APPLE_*` | Sign in with Apple hidden |

---

## Optional — Push Notifications

| Variable | Default | Purpose |
| --- | --- | --- |
| `EXPO_ACCESS_TOKEN` | — | Expo Push API token for direct delivery |
| `PUSH_MODE` | `expo` | `expo` (direct), `relay` (through public server), `none` (disabled) |
| `PUSH_RELAY_URL` | — | Public relay URL for self-hosted `relay` mode |
| `PUSH_RELAY_ENABLED` | `true` | Whether the relay endpoint is mounted |
| `PUSH_RELAY_RATE_LIMIT` | `10` | Max relay requests per token per window |
| `PUSH_RELAY_RATE_WINDOW_MINUTES` | `10` | Rate-limit window length |
| `MAX_PUSH_NOTIFICATIONS_PER_USER_PER_DAY` | `3` | Daily push cap per user |
| `NOTIFICATION_SPREAD_START_HOUR` | `12` | UTC hour to start spreading episode notifications (noon = 12) |

> Episode notifications are spread across the afternoon: 1st at start hour, 2nd +3h, then +1h each. Prevents notification spam when multiple shows air the same day.

---

## Optional — Email (Data Deletion + Password Reset)

| Variable | When Missing |
| --- | --- |
| `SMTP_HOST` | Data deletion + password reset emails not sent |
| `SMTP_PORT` | Defaults to `587` |
| `SMTP_SECURE` | Defaults to `false` (use `true` for port 465) |
| `SMTP_USER` | — |
| `SMTP_PASSWORD` | — |
| `SMTP_FROM` | Defaults to `no-reply@tvwatchtime.org` |
| `SITE_URL` | Defaults to `https://tvwatchtime.org`. Used for deletion + reset email links. |

---

## Optional — Bootstrap

| Variable | Purpose |
| --- | --- |
| `BOOTSTRAP_SUPER_ADMIN_EMAIL` | First user registering with this email becomes `SUPER_ADMIN` with forced password change. |

---

## Performance Tuning

Defaults are safe for small servers (2GB RAM). Increase for larger hardware.

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_CONNECTION_LIMIT` | `20` | Prisma connection pool size |
| `POSTGRES_SHARED_BUFFERS` | `256MB` | PostgreSQL shared buffers (set to ~25% of RAM) |
| `POSTGRES_MAX_CONNECTIONS` | `100` | PostgreSQL max connections |
| `POSTGRES_CACHE_SIZE` | `1GB` | PostgreSQL `effective_cache_size` (set to ~75% of RAM) |
| `POSTGRES_WORK_MEM` | `4MB` | PostgreSQL `work_mem` per sort operation |
| `IMPORT_WORKER_CONCURRENCY` | `2` | Concurrent import processing workers |
| `COMMENT_IMAGE_WORKER_CONCURRENCY` | `2` | Concurrent comment image processing workers |

### Recommended values for large servers (64GB RAM, 32+ threads)

```ini
DATABASE_CONNECTION_LIMIT=50
POSTGRES_SHARED_BUFFERS=16GB
POSTGRES_MAX_CONNECTIONS=300
POSTGRES_CACHE_SIZE=48GB
POSTGRES_WORK_MEM=16MB
TMDB_RPS=0
TVDB_RPS=0
IMPORT_WORKER_CONCURRENCY=10
COMMENT_IMAGE_WORKER_CONCURRENCY=5
```

See [`production-docs/scaling.md`](../production-docs/scaling.md) for multi-instance deployment.

---

## Admin Console

| Variable | Purpose |
| --- | --- |
| `API_URL` | API base URL for the admin console (e.g. `https://api.tvwatchtime.org/api`). Read at **runtime** via server-side injection — no rebuild needed. |

---

## Feature Degrade Summary

| Feature | Required Env | When Missing |
| --- | --- | --- |
| Comment images | S3/MinIO config | Disabled, upload returns 503 |
| User avatars/covers | `S3_PUBLIC_BASE_URL` | Falls back to local server files at `/uploads/*` |
| Image moderation | `OPENAI_API_KEY` | Moderation skipped, images allowed |
| Google login | `GOOGLE_CLIENT_ID/SECRET` | Button hidden |
| Facebook login | `FACEBOOK_APP_ID/SECRET` | Button hidden |
| Push notifications (mobile) | `EXPO_ACCESS_TOKEN` or `PUSH_MODE=relay` | Push disabled (in-app only) |
| Push notifications (web) | `VAPID_PUBLIC_KEY/PRIVATE_KEY` | Web push disabled |
| TMDb metadata | `TMDB_API_KEY` | Seeded mock data served |
| TVDB search | `TVDB_API_KEY` | Search uses TMDb only |
| TVmaze air times | `TVMAZE_API_KEY` | Works without key (lower rate limit) |
| Data deletion email | `SMTP_HOST` | Email not sent (API logs the link instead) |
| Password reset email | `SMTP_HOST` | Email not sent |
| Admin console | `API_URL` (runtime env) | Uses `localhost:4000` fallback |
