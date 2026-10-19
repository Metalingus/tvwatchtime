# Self-hosting TV Watch Time

Run your own TV Watch Time server with the pre-built Docker images, then use the official iOS,
Android, or web app with it. You don't build or install anything except Docker.

> **License:** self-hosting is for your own personal use. Public, shared, commercial,
> organizational, or managed hosting requires separate written permission. See the
> [README](../README.md#license).

## Before you start

Check each of these first. Most setup problems come from one of them.

- [ ] **A Linux server** (a VPS works well) with at least 2 GB RAM.
- [ ] **Docker Engine and the Compose plugin.** Install them with
      [Docker's guide for your distro](https://docs.docker.com/engine/install/), then check with
      `docker compose version`.
- [ ] **A domain you control.** The examples use `example.com`.
- [ ] **DNS records pointing at the server** (see the table below), created *before* you run
      setup. HTTPS certificates can't be issued until they resolve.
- [ ] **Ports 80 and 443 open** to the internet (in your firewall and at your hosting provider).
      They're used for HTTPS certificates.
- [ ] **A free TMDb API key** from [themoviedb.org/settings/api](https://www.themoviedb.org/settings/api).
      Use the short **API Key**, not the long "API Read Access Token". Without it, the server only
      shows demo data.

| DNS record          | Needed?  | Serves                                           |
| ------------------- | :------: | ------------------------------------------------ |
| `api.example.com`   |   Yes    | The API. This is the URL you enter in the app     |
| `admin.example.com` |   Yes    | Admin console                                    |
| `s3.example.com`    |   Yes    | Avatars and cover images                         |
| `app.example.com`   | Optional | Your own web app build (see [Web app](#web-app)) |
| `example.com`       | Optional | Landing page, privacy policy, and terms          |

Create A records (and AAAA for IPv6) pointing each name at your server's IP address.

## Install

```bash
git clone https://github.com/Metalingus/TVWatchTime.git
cd TVWatchTime
bash scripts/selfhost.sh setup
```

Setup asks for three things: your domain, your admin email, and your TMDb key. It then:

1. Writes `.env.prod` with randomly generated passwords and keys.
2. Pulls the images and starts everything.
3. Sets up the database and the avatar storage.
4. Waits until `https://api.example.com/health` responds.

When it finishes, it prints the URL to enter in the app.

> **Back up `.env.prod` now.** It holds the key that encrypts connected-service credentials and
> comment images. If you lose it, that data can't be recovered.

### Create your account

1. Open TV Watch Time: [iOS](https://apps.apple.com/us/app/tv-watch-time/id6793281668),
   [Android](https://play.google.com/store/apps/details?id=app.tvwatchtime.mobile), or
   [web](https://app.tvwatchtime.org).
2. On the login screen, turn on **Self-hosted backend** and enter `https://api.example.com/api`.
   The URL must end in `/api`.
3. Register with the admin email you gave setup. That account becomes the super admin and is asked
   to set a new password.
4. The admin console is at `https://admin.example.com`. Sign in with the same account.

## Update

```bash
cd TVWatchTime
git pull
bash scripts/selfhost.sh update
```

This pulls the newest images, backs up the database to `backups/`, applies any database
migrations, and restarts. The images are published as `latest`, so updates always move to the
newest release.

## Back up

```bash
bash scripts/selfhost.sh backup
```

This writes a compressed database dump to `backups/`. Keep copies off the server, together with
`.env.prod`. Avatars and comment images live in the `miniodata` Docker volume.

To back up every night, add this to `crontab -e` (adjust the path):

```cron
0 4 * * * cd /path/to/TVWatchTime && bash scripts/selfhost.sh backup >/dev/null 2>&1
```

To restore a dump into a fresh install, run setup first, then:

```bash
alias dc='docker compose --env-file .env.prod -f docker-compose.prod.yml'
dc stop api admin
dc exec -T postgres sh -c 'dropdb -U "$POSTGRES_USER" "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'
gunzip -c backups/tvwatch-YYYYMMDD-HHMMSS.sql.gz | dc exec -T postgres sh -c 'psql -q -U "$POSTGRES_USER" "$POSTGRES_DB"'
dc up -d
```

Restore with the `.env.prod` from the same install; a different `ENCRYPTION_MASTER_KEY` can't read
the encrypted data.

## Push notifications

Push works out of the box. The official app's push tokens belong to the project's Expo account,
so your server sends pushes through the public relay (rate-limited per device):

```env
PUSH_MODE=relay
PUSH_RELAY_URL=https://api.tvwatchtime.org/api
```

Set `PUSH_MODE=none` to keep in-app notifications only. Use `PUSH_MODE=expo` with your own
`EXPO_ACCESS_TOKEN` only if you build and sign the app yourself.

## Web app

- **Hosted web app (easiest):** use [app.tvwatchtime.org](https://app.tvwatchtime.org) with the
  self-hosted toggle. Setup already allows it in `CORS_ORIGINS`.
- **Your own web build:** build the Expo web export from source into `app-web/` in the repo root,
  and Caddy serves it at `app.example.com`. This needs Node 20 and pnpm 9:

  ```bash
  cp apps/mobile/app.example.json apps/mobile/app.json
  # In apps/mobile/app.json, set expo.extra.apiBaseUrl and publicApiUrl to https://api.example.com/api
  pnpm install
  pnpm --filter @tvwatch/shared build
  cd apps/mobile && npx expo export --platform web --output-dir ../../app-web
  ```

## Optional features

Add these to `.env.prod`, then run `bash scripts/selfhost.sh update` (or
`docker compose --env-file .env.prod -f docker-compose.prod.yml up -d`) to apply them. Blank means
off. Missing features are hidden; nothing crashes.

| Feature                             | Set in `.env.prod`                                   |
| ----------------------------------- | ---------------------------------------------------- |
| More shows in search (TheTVDB)      | `TVDB_API_KEY`                                       |
| SIMKL sync                          | `SIMKL_CLIENT_ID`                                    |
| Jellyfin/Plex/Emby on a LAN address | `ALLOW_PRIVATE_INTEGRATION_URLS=true`                |
| Image moderation                    | `OPENAI_API_KEY`                                     |
| Comment/review translation          | `AZURE_TRANSLATOR_KEY`, `AZURE_TRANSLATOR_REGION`    |
| Password-reset and account emails   | `SMTP_*`                                             |
| Web push                            | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`              |
| Google / Facebook / Apple login     | Your own OAuth app credentials (`GOOGLE_*`, `FACEBOOK_*`, `APPLE_*`) |

Email and password login always works. Stremio, Jellyfin, Plex, and Emby need no server-side keys.
Every variable is described in [`ENVIRONMENT.md`](ENVIRONMENT.md).

If you don't create the optional `app.` or bare-domain DNS records, Caddy logs certificate errors
for them and keeps retrying. That's harmless; everything else works.

## Home servers and NAS boxes

The setup above expects a server reachable from the internet on ports 80/443 with a public
domain. If your server sits behind a home router, you have two common options:

- **Forward ports 80 and 443** on your router to the server, and point the DNS records at your
  home IP (use a dynamic-DNS service if it changes).
- **Use a tunnel** such as Cloudflare Tunnel or Tailscale Funnel to publish the `api.`, `admin.`,
  and `s3.` hostnames without opening ports. In that case the tunnel provides HTTPS; route each
  hostname to the matching container (`api:4000`, `admin:3000`, `minio:9000`).

These setups aren't tested by the project, so expect to adapt them. The app always connects over
HTTPS, so a plain `http://192.168.x.x` address won't work from phones.

## Troubleshooting

Run commands from the `TVWatchTime` folder. Logs:
`docker compose --env-file .env.prod -f docker-compose.prod.yml logs -f caddy api`.

| Symptom                                   | Fix                                                                     |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| Setup says Docker isn't running           | Start Docker (`sudo systemctl start docker`), or run with `sudo`        |
| HTTPS/certificate errors                  | DNS isn't pointing at the server yet, or ports 80/443 are blocked. Fix it, then wait a minute; Caddy retries |
| App says it can't reach the server        | The server URL must end in `/api`. Check `https://api.example.com/health` in a browser |
| Only demo shows appear                    | `TMDB_API_KEY` in `.env.prod` is missing or invalid. Fix it, then run `update` |
| Avatars don't load                        | Run `bash scripts/selfhost.sh setup` again; it reapplies the storage setting |
| Web app shows CORS errors                 | Add the web app's origin to `CORS_ORIGINS` in `.env.prod`, then run `update` |
| API logs `table ... does not exist`       | Run `bash scripts/selfhost.sh update`; it applies the database migrations |
| Containers start with empty passwords     | You ran `docker compose` without `--env-file .env.prod`                 |

Running setup again is safe: it keeps your existing `.env.prod` and only restarts things.

## Manual setup (without the script)

The script only wraps standard Docker Compose commands. To do it by hand:

```bash
alias dc='docker compose --env-file .env.prod -f docker-compose.prod.yml'

# 1. Configure: set TVWATCH_DOMAIN, TMDB_API_KEY, BOOTSTRAP_SUPER_ADMIN_EMAIL, every CHANGE_ME
#    value (the Postgres password appears twice, also inside DATABASE_URL), and the example.com URLs.
cp .env.prod.example .env.prod && chmod 600 .env.prod
nano .env.prod

# 2. Start the data services, apply migrations, start everything
dc pull
dc up -d --wait postgres redis minio
dc run --rm --no-deps -T api pnpm -C /app/apps/api exec prisma migrate deploy \
  --schema=/app/apps/api/prisma/schema.prisma
dc up -d

# 3. Allow anonymous read-only access to avatars and covers
dc exec minio sh -c '
  mc alias set local http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" &&
  mc mb --ignore-existing local/tvwatch-user-images &&
  mc anonymous set download local/tvwatch-user-images'
```

Notes:

- Generate secrets with `openssl rand -hex 32`. Hex values need no URL-encoding in `DATABASE_URL`.
- Use `prisma migrate deploy`, never `prisma db push`. Some migrations include data backfills.
- Use `mc anonymous set download`, not `public`. `public` also lets anyone upload files. The
  comment-image and temp buckets stay private; the API reads them with its own credentials.

To build the images from source instead of pulling them, run `dc build` before step 2 and skip
`dc pull`.
