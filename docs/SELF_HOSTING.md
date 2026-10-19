# Self-hosting TV Watch Time

Run your own TV Watch Time backend with the pre-built Docker images, then point the official iOS,
Android, or web app at it. No mobile build is required.

> **License:** self-hosting is for your own personal use. Public, shared, commercial,
> organizational, or managed hosting requires separate written permission. See the
> [README](../README.md#license).

## What you run

| Service    | Image                                    | Purpose                                     |
| ---------- | ---------------------------------------- | ------------------------------------------- |
| `api`      | `ghcr.io/metalingus/tvwatch-api:latest`   | NestJS backend, background jobs             |
| `admin`    | `ghcr.io/metalingus/tvwatch-admin:latest` | Admin console (users, metadata, jobs)       |
| `postgres` | `postgres:16-alpine`                     | Database                                    |
| `redis`    | `redis:7-alpine`                         | Cache and job queues                        |
| `minio`    | `minio/minio`                            | S3-compatible storage for avatars and images |
| `caddy`    | `caddy:2-alpine`                         | Reverse proxy with automatic HTTPS          |

All of it is defined in [`docker-compose.prod.yml`](../docker-compose.prod.yml). The images are
public; you don't need a GitHub login to pull them.

## Requirements

- A Linux server with Docker Engine and the Docker Compose v2 plugin. 2 GB RAM is enough for a
  personal instance.
- Ports **80** and **443** reachable from the internet (Caddy uses them for Let's Encrypt).
- A domain you control. The examples use `example.com`.
- A free [TMDb API key](https://www.themoviedb.org/settings/api). Without it the server only serves
  seeded demo data.

## 1. Clone the repository

You need the compose file, the `Caddyfile`, and the env template from the repo. Nothing is built
locally.

```bash
git clone https://github.com/Metalingus/TVWatchTime.git
cd TVWatchTime
```

Every command below runs from this directory, in the same shell. Set your domain and a short
alias for the compose command:

```bash
DOMAIN=example.com   # your domain
alias dc='docker compose --env-file .env.prod -f docker-compose.prod.yml'
```

> Always pass `--env-file .env.prod`. Compose needs it to fill in the Postgres/Redis/MinIO
> passwords in `docker-compose.prod.yml`.

## 2. DNS records

Create A (and AAAA, if you use IPv6) records pointing at your server:

| Record              | Required | Serves                                         |
| ------------------- | :------: | ---------------------------------------------- |
| `api.example.com`   |   Yes    | The API. This is the URL you enter in the app   |
| `admin.example.com` |   Yes    | Admin console                                  |
| `s3.example.com`    |   Yes    | Public avatar and cover images (MinIO)         |
| `app.example.com`   |    No    | Your own web app build (see [Web app](#web-app)) |
| `example.com`       |    No    | Landing page, privacy policy, terms (`public-site/`) |

## 3. Point the config at your domain

The `Caddyfile` and the admin service's `API_URL` ship with the project's own domain. Replace it
with yours:

```bash
sed -i "s/tvwatchtime\.org/$DOMAIN/g" Caddyfile docker-compose.prod.yml
```

If you skip the optional `app.` or root-domain records, delete those site blocks from the
`Caddyfile` so Caddy doesn't keep retrying certificates for them.

## 4. Create `.env.prod`

```bash
cp .env.prod.example .env.prod

# Replace the placeholder secrets with random values. Hex values need no URL-encoding in
# DATABASE_URL, and the same Postgres password is written to both places it appears.
PG=$(openssl rand -hex 24); RD=$(openssl rand -hex 24); MN=$(openssl rand -hex 24)
sed -i \
  -e "s/CHANGE_ME_STRONG_PASSWORD/$PG/g" \
  -e "s/CHANGE_ME_REDIS_PASSWORD/$RD/g" \
  -e "s/CHANGE_ME_STRONG_MINIO_PASSWORD/$MN/g" \
  -e "s/CHANGE_ME_64_CHAR_RANDOM_STRING/$(openssl rand -hex 48)/" \
  -e "s/CHANGE_ME_32_BYTE_HEX_KEY/$(openssl rand -hex 32)/" \
  -e "s/example\.com/$DOMAIN/g" \
  .env.prod
```

Then open `.env.prod` and set:

| Variable                      | Value                                                                |
| ----------------------------- | -------------------------------------------------------------------- |
| `TMDB_API_KEY`                | Your TMDb key (v3 API key)                                           |
| `BOOTSTRAP_SUPER_ADMIN_EMAIL` | The email you'll register with. That account becomes the super admin |
| `CORS_ORIGINS`                | Keep `https://app.tvwatchtime.org` to use the hosted web app with your server |

Check that these now use your domain: `API_BASE_URL`, `S3_PUBLIC_BASE_URL`, `SITE_URL`.

> **Back up `.env.prod`.** `ENCRYPTION_MASTER_KEY` encrypts connected-service credentials and
> comment images. If you lose it, you can't decrypt them. `JWT_SECRET` must stay the same, or
> everyone is logged out.

Everything else is optional and can be left as is. See [Optional features](#optional-features).

## 5. Start the stack

Start the data services first, apply the database migrations, then start everything:

```bash
dc pull
dc up -d postgres redis minio

dc run --rm --no-deps api \
  pnpm -C /app/apps/api exec prisma migrate deploy \
  --schema=/app/apps/api/prisma/schema.prisma

dc up -d
```

Use `prisma migrate deploy`, not `prisma db push`. Some migrations contain data backfills that
`db push` skips.

## 6. Storage bucket

The API creates its buckets itself. Browsers load avatars and covers straight from MinIO, so that
one bucket needs anonymous **read-only** access:

```bash
dc exec minio sh -c '
  mc alias set local http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" &&
  mc mb --ignore-existing local/tvwatch-user-images &&
  mc anonymous set download local/tvwatch-user-images'
```

Use `download`, not `public`: `public` also lets anyone upload files. The comment-image and
temp-upload buckets stay private. The API reads them with its own credentials.

## 7. Check it works

```bash
curl https://api.example.com/health
# {"status":"ok","ts":"..."}
```

The first start can take a minute while Caddy gets certificates. `dc logs -f caddy api` shows
progress.

## 8. Create your account

1. Open the TV Watch Time app: [iOS](https://apps.apple.com/us/app/tv-watch-time/id6793281668),
   [Android](https://play.google.com/store/apps/details?id=app.tvwatchtime.mobile), or
   [web](https://app.tvwatchtime.org).
2. On the login screen, turn on **Self-hosted backend** and enter
   `https://api.example.com/api`. The URL must end in `/api`.
3. Register with your `BOOTSTRAP_SUPER_ADMIN_EMAIL`. That account is promoted to super admin and
   asked to set a new password.
4. Sign in to the admin console at `https://admin.example.com` with the same account.

## Push notifications

The official app's push tokens belong to the project's Expo account, so a self-hosted server sends
pushes through the public relay. This is the default in `.env.prod.example`:

```env
PUSH_MODE=relay
PUSH_RELAY_URL=https://api.tvwatchtime.org/api
```

The relay is rate-limited per device. Set `PUSH_MODE=none` to keep in-app notifications only. Use
`PUSH_MODE=expo` with your own `EXPO_ACCESS_TOKEN` only if you build and sign the app yourself.

## Web app

You have two options:

- **Hosted web app (easiest):** use `https://app.tvwatchtime.org` with the self-hosted toggle.
  Keep `https://app.tvwatchtime.org` in `CORS_ORIGINS`.
- **Your own web build:** build the Expo web export from source into `app-web/` in the repo root.
  Caddy serves it at `app.example.com`:

  ```bash
  # Needs Node 20 and pnpm 9. Copy the config template first and set
  # expo.extra.apiBaseUrl / publicApiUrl to https://api.example.com/api
  cp apps/mobile/app.example.json apps/mobile/app.json
  pnpm install
  pnpm --filter @tvwatch/shared build
  cd apps/mobile && npx expo export --platform web --output-dir ../../app-web
  ```

  Add `https://app.example.com` to `CORS_ORIGINS` and restart the API.

## Optional features

Leave a value blank to turn the feature off. The app degrades gracefully; nothing crashes.

| Feature                          | Set in `.env.prod`                           |
| -------------------------------- | -------------------------------------------- |
| More shows in search (TheTVDB)   | `TVDB_API_KEY`                               |
| SIMKL sync                       | `SIMKL_CLIENT_ID`                            |
| Jellyfin/Plex/Emby on a LAN address | `ALLOW_PRIVATE_INTEGRATION_URLS=true`      |
| Image moderation                 | `OPENAI_API_KEY`                             |
| Comment/review translation       | `AZURE_TRANSLATOR_KEY`, `AZURE_TRANSLATOR_REGION` |
| Password-reset and account emails | `SMTP_*`                                    |
| Web push                         | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`      |
| Google / Facebook / Apple login  | Your own OAuth app credentials (`GOOGLE_*`, `FACEBOOK_*`, `APPLE_*`) |

Email and password login always works. Stremio, Jellyfin, Plex, and Emby need no server-side keys.
For every variable and its fallback behavior, see [`ENVIRONMENT.md`](ENVIRONMENT.md).

After changing `.env.prod`, run `dc up -d` to recreate the affected containers.

## Updating

The images are published as `latest`. Back up before every update. Then:

```bash
git stash && git pull && git stash pop   # keeps your step 3 domain edits
dc pull
dc stop api
# back up the database (see below)
dc run --rm --no-deps api \
  pnpm -C /app/apps/api exec prisma migrate deploy \
  --schema=/app/apps/api/prisma/schema.prisma
dc up -d --force-recreate api admin
```

Running `migrate deploy` when there's nothing new is safe; it does nothing.

## Backups

What to keep: the database, the `.env.prod` file, and the MinIO volume (avatars and comment
images).

```bash
# Database dump
dc exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' \
  | gzip > backup-$(date +%Y%m%d).sql.gz

# Restore into an empty database (stop the API first)
gunzip -c backup-YYYYMMDD.sql.gz | dc exec -T postgres sh -c 'psql -U "$POSTGRES_USER" "$POSTGRES_DB"'
```

Example nightly cron job (keeps 7 days):

```cron
0 4 * * * cd /path/to/TVWatchTime && docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' | gzip > /backups/tvwatch-$(date +\%Y\%m\%d).sql.gz && find /backups -name 'tvwatch-*.sql.gz' -mtime +7 -delete
```

## Troubleshooting

| Symptom                                   | Fix                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------- |
| API logs `table ... does not exist`       | Run the `prisma migrate deploy` command from step 5                       |
| `migrate deploy` fails with `P1000`       | The password in `DATABASE_URL` doesn't match `POSTGRES_PASSWORD`, or it has unencoded special characters |
| Postgres/Redis start with empty passwords | You ran compose without `--env-file .env.prod`                            |
| App says it can't reach the server        | The server URL must end in `/api`; check `curl https://api.example.com/health` |
| Web app shows CORS errors                 | Add the web app's origin to `CORS_ORIGINS`, then `dc up -d api`            |
| Avatars don't load (403)                  | Re-run the bucket command from step 6; check `S3_PUBLIC_BASE_URL` is `https://s3.<domain>/tvwatch-user-images` |
| Admin console can't log in                | `API_URL` in `docker-compose.prod.yml` must be `https://api.<domain>/api` (step 3) |
| Only demo shows appear                    | `TMDB_API_KEY` is missing or invalid                                      |
| HTTPS certificate errors                  | DNS isn't pointing at the server yet, or ports 80/443 are blocked; see `dc logs caddy` |

## Building the images yourself

Prefer your own builds? Build both images from source instead of pulling them:

```bash
dc build
```

Then continue from step 5, skipping `dc pull`.
