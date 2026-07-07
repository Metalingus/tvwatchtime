# Environment Variables

This document describes every environment variable used by the TVWatchTime stack (API, admin, mobile build, push relay). Grouped by category. Anything under **Optional** has a documented fallback behavior — the app degrades gracefully rather than crashing.

> **Convention.** All secrets come from environment variables read via NestJS `ConfigService` (API) or `process.env` at build time (admin). Never hardcode secrets in source.

---

## Must-Have (Required)

The API will not boot correctly without these. Set them in `.env` (API) before `pnpm dev:api`.

| Variable | Required | Purpose | Example |
| --- | --- | --- | --- |
| `DATABASE_URL` | ✅ Required | Prisma connection string for PostgreSQL 16. Used by the API and Prisma CLI. | `postgresql://tvwatch:secret@localhost:5432/tvwatch?schema=public` |
| `REDIS_URL` | ✅ Required | Redis 7 connection string. Used by BullMQ (job queues) and the push relay rate limiter. | `redis://localhost:6379` |
| `JWT_SECRET` | ✅ Required | Secret used to sign access (15m) and refresh (30d) JWTs. Use a long random string. | `change-me-to-a-64-char-random-string` |
| `ENCRYPTION_MASTER_KEY` | ✅ Required | 32-byte master key (hex or base64) wrapping per-image AES-256-GCM data keys for comment images and encrypting sensitive admin settings. | `0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef` |
| `API_PORT` | ✅ Required | Port the NestJS API listens on. | `3000` |
| `CORS_ORIGINS` | ✅ Required | Comma-separated allowlist for the CORS middleware. Include admin origin and any web client. | `http://localhost:3001,https://admin.tvwatchtime.org` |
| `NODE_ENV` | ✅ Required | Runtime mode. `development` enables verbose logs + Swagger; `production` enables helmet, strict validation, cache headers. | `production` |

---

## Optional — Metadata

Metadata providers enrich TV/movie data. The app runs fully without them using seeded mock data.

| Variable | When Missing |
| --- | --- |
| `TMDB_API_KEY` | **No TMDB key = app serves seeded mock data.** No posters, descriptions, or episode counts fetched from TMDb. |
| `TMDB_RPS` | Falls back to a safe default rate limit. Override to tune the global TMDb rate limiter (`tmdb.client.ts`). Default e.g. `8`. |
| `TMDB_LANGUAGE` | Falls back to `en-US`. ISO 639-1 locale code for metadata localization. |
| `TVMAZE_ENABLED` | Defaults to `false`. When `true`, enables air-time lookups. |
| `TVMAZE_API_KEY` | Feature skipped — no episode air dates/times fetched from TVmaze. |

> **Examples:** `TMDB_API_KEY=abc123def456`, `TMDB_RPS=8`, `TMDB_LANGUAGE=en-US`, `TVMAZE_ENABLED=true`, `TVMAZE_API_KEY=xyz789`.

---

## Optional — Storage (S3 / MinIO)

Object storage for comment images and user avatar/cover images.

| Variable | Purpose |
| --- | --- |
| `S3_ENDPOINT` | S3-compatible endpoint. For MinIO set `S3_ENDPOINT=http://minio:9000`. |
| `S3_REGION` | Region string. Use `us-east-1` for MinIO. |
| `S3_ACCESS_KEY_ID` | Access key for S3/MinIO. |
| `S3_SECRET_ACCESS_KEY` | Secret key for S3/MinIO. |
| `S3_BUCKET_*` | Bucket name(s) for comment images / avatars / covers (e.g. `S3_BUCKET_COMMENTS`, `S3_BUCKET_MEDIA`). |

> **MinIO is S3-compatible.** Point the same S3 client at MinIO by setting `S3_ENDPOINT=http://minio:9000` together with your MinIO access/secret keys and bucket names.

> **When no S3/MinIO is configured:** comment images are disabled (uploads return 503), and user avatar/cover images fall back to local server files served at `/uploads/*`.

---

## Optional — Moderation

| Variable | When Missing |
| --- | --- |
| `OPENAI_API_KEY` | **When missing: image moderation is skipped. Images are still processed and stored, but not checked for inappropriate content.** |

---

## Optional — OAuth

Social login providers. Each is independent.

| Variable | When Missing |
| --- | --- |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | The Google login button is hidden in the mobile app. |
| `FACEBOOK_APP_ID` / `FACEBOOK_APP_SECRET` | The Facebook login button is hidden in the mobile app. |
| `APPLE_*` (client ID, team ID, key, etc.) | Sign in with Apple is hidden in the mobile app. |

> Email/password registration always works regardless of OAuth config. Social login is also hidden entirely when self-hosting (no OAuth secrets to leak via the backend URL).

---

## Optional — Push

Push delivery for episode notifications.

| Variable | Purpose |
| --- | --- |
| `EXPO_ACCESS_TOKEN` | Expo Push API token for direct delivery (Expo Go / dev builds). |
| `PUSH_MODE` | `expo` (default, direct to Expo), `relay` (self-hosted instances push via public relay `/api/push/relay`), or `none` (disabled). |
| `PUSH_RELAY_URL` | Public relay URL used by self-hosted instances in `relay` mode. |
| `PUSH_RELAY_ENABLED` | `true`/`false` — whether the public relay endpoint is mounted. |
| `PUSH_RELAY_RATE_LIMIT` | Max relay requests per token within the rate window. Protects the `@Public()` relay endpoint. |
| `PUSH_RELAY_RATE_WINDOW_MINUTES` | Length of the rate-limit window in minutes. |

> **When `EXPO_ACCESS_TOKEN` is unset and `PUSH_MODE` is not `relay`:** push notifications are disabled; users still receive in-app watch-next data, just no device alerts.

---

## Optional — Bootstrap

| Variable | Purpose |
| --- | --- |
| `BOOTSTRAP_SUPER_ADMIN_EMAIL` | **First user who registers with this email becomes `SUPER_ADMIN`.** Set this to your email before first deploy, then remove it or leave it for fresh databases. |

---

## Admin

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_API_URL` | API base URL for the admin console (e.g. `https://api.tvwatchtime.org/api`). **Set at build time** — it is inlined into the Next.js bundle because it is a `NEXT_PUBLIC_` var. |

---

## Feature Degrade Summary

A quick reference for what breaks (or degrades) when an env group is missing.

| Feature | Required Env | When Missing |
| --- | --- | --- |
| Comment images | S3 config (`S3_ENDPOINT` + creds + buckets) | Feature disabled, upload returns **503** |
| User avatars/covers | S3 config (`S3_ENDPOINT` + creds + buckets) | Falls back to **local server files** served at `/uploads/*` |
| Image moderation | `OPENAI_API_KEY` | Moderation **skipped**, images allowed through |
| Google login | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Button **hidden** in app |
| Facebook login | `FACEBOOK_APP_ID` / `FACEBOOK_APP_SECRET` | Button **hidden** in app |
| Push notifications | `EXPO_ACCESS_TOKEN` or `PUSH_MODE=relay` | Push **disabled** |
| TMDb metadata | `TMDB_API_KEY` | **Seeded mock data** served |
| TVmaze air times | `TVMAZE_API_KEY` | Feature **skipped** |
