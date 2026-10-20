# Self-hosting TV Watch Time

Run your own TV Watch Time server with the pre-built Docker images, then use the official app with
it. You only need Docker; nothing is built on your machine.

> **License:** self-hosting is for your own personal use. Public, shared, commercial,
> organizational, or managed hosting requires separate written permission. See the
> [README](../README.md#license).

## Choose your setup

|                               | **Domain** (recommended)                     | **Home network**                          |
| ----------------------------- | -------------------------------------------- | ----------------------------------------- |
| Reach it from                 | Anywhere                                     | Devices on your home network              |
| iPhone and Android apps       | Yes                                          | No (they require HTTPS)                   |
| Web app in a browser          | Yes, from your own build (see [Web app](#web-app)) | Yes, from your own build (see [Web app](#web-app)) |
| Browser notifications         | Yes (with your web build)                    | No (browsers require HTTPS)               |
| You need                      | A domain, ports 80/443 open to the internet  | Node.js 20 and pnpm, once, to build the web app |
| Address                       | `https://api.example.com/api`                | `http://192.168.1.20/api` (your machine)  |

The setup script asks which one you want. You can switch later by running setup again with a new
`.env.prod`.

## Before you start

**Both setups:**

- [ ] A Linux machine (a VPS, a home server, or a NAS that runs Docker) with at least 2 GB RAM.
- [ ] Docker Engine and the Compose plugin. Install them with
      [Docker's guide for your distro](https://docs.docker.com/engine/install/), then check with
      `docker compose version`.
- [ ] A free **TMDb API key** from [themoviedb.org/settings/api](https://www.themoviedb.org/settings/api).
      Use the short **API Key**, not the long "API Read Access Token". Without it you can't search
      or add shows.

**Domain setup only:**

- [ ] A domain you control. The examples use `example.com`.
- [ ] DNS records pointing at the server, created *before* you run setup (HTTPS certificates can't
      be issued until they resolve). See the table below.
- [ ] Ports **80 and 443** open to the internet, in your firewall and at your hosting provider.

| DNS record          | Needed?     | Serves                                                     |
| ------------------- | :---------: | ---------------------------------------------------------- |
| `api.example.com`   | Yes         | The API. This is the URL you enter in the app               |
| `admin.example.com` | Yes         | Admin console                                              |
| `s3.example.com`    | Yes         | Avatars and cover images                                   |
| `example.com`       | Recommended | Password-reset and account-deletion pages linked in emails |
| `app.example.com`   | Optional    | Your own web app build (see [Web app](#web-app))           |

Create A records (and AAAA for IPv6) pointing each name at your server's IP address.

## Install

```bash
git clone https://github.com/Metalingus/TVWatchTime.git
cd TVWatchTime
bash scripts/selfhost.sh setup
```

Setup asks:

1. **Domain or home network.**
2. **Your domain**, or for the home network, the machine's address (it suggests one) and ports
   (80 for the web app and 8080 for the admin console by default).
3. **Your admin email.**
4. **Your TMDb key.**
5. **Two optional, recommended keys:** TheTVDB and Movie of the Night (see
   [Configuration](#configuration)). Press Enter to skip.

Then it writes `.env.prod` with randomly generated passwords and keys, pulls the images, sets up
the database and storage, and waits until the server answers. It finishes by printing the
addresses to use.

> **Back up `.env.prod` now.** It holds the key that encrypts connected-service credentials and
> comment images. If you lose it, that data can't be recovered.

### Create your account

**Domain setup:**

1. Install the official TV Watch Time app for
   [iOS](https://apps.apple.com/us/app/tv-watch-time/id6793281668) or
   [Android](https://play.google.com/store/apps/details?id=app.tvwatchtime.mobile).
2. On the login screen, turn on **Self-hosted backend** and enter `https://api.example.com/api`.
   The URL must end in `/api`.
3. Register with your admin email. That account becomes the super admin and is asked to set a new
   password.
4. The admin console is at `https://admin.example.com`.

**Home network:**

1. Build the web app once (see [Web app](#web-app)). Setup prints the exact commands if
   `app-web/` is missing.
2. On any computer, tablet, or phone on your network, open the address setup printed, for
   example `http://192.168.1.20`.
3. Register with your admin email. That account becomes the super admin. If the login screen
   shows **Self-hosted backend**, turn it on and use the same address plus `/api`, for example
   `http://192.168.1.20/api`.
4. The admin console is at the same address on port 8080, for example `http://192.168.1.20:8080`.

## Configuration

Settings live in `.env.prod`. After editing it, apply the change with
`bash scripts/selfhost.sh update`. Setup fills in everything in tier 1. Tiers 2 and 3 are free
unless noted.

### 1. Required

Setup sets all of these. You only touch them to change your domain or replace a key.

| Setting                       | Why                                                                 |
| ----------------------------- | ------------------------------------------------------------------- |
| `TMDB_API_KEY`                | All show and movie information, search, posters, and cast. Without it you can't add anything. Set it in `.env.prod`; the TMDb row on the admin Settings page doesn't replace it |
| `TVWATCH_MODE`, `TVWATCH_DOMAIN` or `TVWATCH_LOCAL_URL` | How the server is reached (domain or home network)        |
| `BOOTSTRAP_SUPER_ADMIN_EMAIL` | The first account registered with this email becomes the admin     |
| `API_BASE_URL`, `CORS_ORIGINS`, `SITE_URL`, `S3_PUBLIC_BASE_URL` | Public addresses, derived from your domain or home-network address |
| `JWT_SECRET`, `ENCRYPTION_MASTER_KEY`, passwords | Generated secrets. Never change `ENCRYPTION_MASTER_KEY` after setup |

### 2. Recommended

Each one makes the app noticeably better.

| Setting | What you get | How to turn it on |
| ------- | ------------ | ----------------- |
| `TVDB_API_KEY` | **Better TV coverage.** Search covers TheTVDB as well as TMDb, so more shows turn up. Anime and other TVDB-tracked shows use its episode lists. An hourly job picks up new episodes and air dates. Character votes get character photos. | Get a key at [thetvdb.com/api-information](https://thetvdb.com/api-information). Add `TVDB_PIN` only if your key is tied to a user subscription. Nothing else to enable. |
| `MOTN_API_KEY` | **"Top on Netflix / Prime Video / Disney+ / Apple TV / HBO Max today"** rows in Explore, refreshed daily. | Free key (1000 requests/month) at [movieofthenight.com/about/api](https://www.movieofthenight.com/about/api). Then in the admin console: **Auto Hydrations → Streaming Top Charts → enable**, and pick up to 6 countries and the services. It's off until you do this. |
| `PUSH_MODE=relay` (default) | **Phone notifications** for new episodes and replies. The official apps can only receive pushes through the public relay, which is rate-limited per device. | Already set. Use `PUSH_MODE=expo` with your own `EXPO_ACCESS_TOKEN` only if you build the app yourself. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | **Browser notifications** for the web app. Domain setup only. | Setup generates them. By hand: `docker run --rm node:20-alpine npx -y web-push@3.6.7 generate-vapid-keys` |
| `SMTP_*` | **Password-reset and account-deletion emails.** | Any SMTP provider (your mail host, Gmail app password, Brevo, Mailgun…). Without it, reset passwords with `bash scripts/selfhost.sh reset-password`. |

### 3. Optional

Only if you want the specific feature.

| Setting | What you get | Notes |
| ------- | ------------ | ----- |
| `SIMKL_CLIENT_ID` | SIMKL sync | Create an app in your SIMKL developer settings. Stremio, Jellyfin, Plex, and Emby need no key. |
| `ALLOW_PRIVATE_INTEGRATION_URLS=true` | Connect Jellyfin, Plex, or Emby running on your home network (`192.168.x.x`) | Home-network setup turns this on. In domain setup, enable it if your media server is local. |
| `OPENAI_API_KEY` | Automatic moderation of comment text and images | Only useful if other people comment. While OpenAI is unreachable, posting comments fails rather than skipping the check. |
| `AZURE_TRANSLATOR_KEY`, `AZURE_TRANSLATOR_REGION` | A Translate button on comments and reviews | Needs both values. Azure's free tier covers personal use. |
| `WATCHFORGE_API_KEY` | Extra ID matching for difficult imports | Needs an approved developer key from [api.watchforge.app](https://api.watchforge.app/). Most people can skip it. |

Anime information from Kitsu and Jikan (MyAnimeList) is built in and needs no key.

### 4. Advanced

The defaults suit a personal server; [`ENVIRONMENT.md`](ENVIRONMENT.md) documents each one.

- **Per-user limits:** push notifications per day, comment image size and count.
- **Performance tuning** for bigger hardware, and provider request rates.
- **Social login** (`GOOGLE_*`, `FACEBOOK_*`, `APPLE_*`): only for your own app build. The official
  apps hide social login when connected to a self-hosted server.

Some settings live in the admin console instead of `.env.prod`. **Settings → Rate Limits** sets
imports per user per day (default 3). **Settings → Notifications** sets the watchlist reminder
timing.

## Everyday commands

Run them from the `TVWatchTime` folder.

| Command | What it does |
| ------- | ------------ |
| `git pull && bash scripts/selfhost.sh update` | Update to the newest version. Backs up the database first, applies database migrations, restarts |
| `bash scripts/selfhost.sh backup` | Save a compressed database backup to `backups/` |
| `bash scripts/selfhost.sh reset-password` | Set a new password for any account. Works without email |
| `bash scripts/selfhost.sh logs` | Follow the API and web server logs |
| `bash scripts/selfhost.sh setup` | Safe to run again: keeps `.env.prod`, restarts, re-applies storage settings |

The images are published as `latest`, so updates always move to the newest release.

### Backups

Keep backups off the server, together with `.env.prod`. Avatars and comment images live in the
`miniodata` Docker volume.

Nightly backups with `crontab -e` (adjust the path):

```cron
0 4 * * * cd /path/to/TVWatchTime && bash scripts/selfhost.sh backup >/dev/null 2>&1
```

To restore a dump, install first (same `.env.prod`), then:

```bash
alias dc='docker compose --env-file .env.prod -f docker-compose.prod.yml'
# Home network: add  -f docker-compose.local.yml  to the alias
dc stop api admin
dc exec -T postgres sh -c 'dropdb -U "$POSTGRES_USER" "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'
gunzip -c backups/tvwatch-YYYYMMDD-HHMMSS.sql.gz | dc exec -T postgres sh -c 'psql -q -U "$POSTGRES_USER" "$POSTGRES_DB"'
dc up -d
```

Restore with the `.env.prod` from the same install; a different `ENCRYPTION_MASTER_KEY` can't read
the encrypted data.

## Web app

The official iOS and Android apps connect to your server as is. For a web app, build your own from
this repository. Your server serves it from `app-web/`: at `app.example.com` in domain setup
(create that DNS record), or at your home-network address.

**Building the web app** (Node.js 20 and pnpm 9, from the repo root). The output goes to `app-web/`,
which Caddy serves at `app.example.com` (domain setup) or at your home-network address:

```bash
cp apps/mobile/app.example.json apps/mobile/app.json
# In apps/mobile/app.json, set expo.extra.apiBaseUrl to your server's /api URL,
# e.g. https://api.example.com/api or http://192.168.1.20/api
pnpm install
pnpm --filter @tvwatch/shared build
(cd apps/mobile && npx expo export --platform web --output-dir ../../app-web)
```

Rebuild it after `git pull` when you update, so the web app matches the server version.

## Home network details

Home-network setup adds `docker-compose.local.yml` and `Caddyfile.local`. One plain-HTTP address
serves everything:

| Address                               | Serves                            |
| ------------------------------------- | --------------------------------- |
| `http://<machine>/`                   | Web app (your build in `app-web/`) |
| `http://<machine>/api`                | API                               |
| `http://<machine>/tvwatch-user-images` | Avatars and covers               |
| `http://<machine>:8080`               | Admin console                     |

- Give the machine a fixed address (a DHCP reservation in your router), or the address saved in
  your browsers stops working.
- To use the phone apps or reach the server away from home, you need HTTPS: switch to the domain
  setup (port forwarding, or a tunnel such as Cloudflare Tunnel or Tailscale Funnel). The project
  doesn't test tunnels, so expect to adapt them.

## Troubleshooting

Start with `bash scripts/selfhost.sh logs`.

| Symptom                                   | Fix                                                                     |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| Setup says Docker isn't running           | Start Docker (`sudo systemctl start docker`), or run with `sudo`        |
| Setup says a port is in use               | Pick another port, or stop the program using it                         |
| HTTPS/certificate errors (domain)         | DNS isn't pointing at the server yet, or ports 80/443 are blocked. Fix it, then wait a minute; Caddy retries |
| App says it can't reach the server        | The server URL must end in `/api`. Open the same address with `/health` instead of `/api` in a browser; it should say `"status":"ok"` |
| Can't search or add shows                 | `TMDB_API_KEY` in `.env.prod` is missing or invalid. Fix it, then run `update` |
| No "Top on Netflix…" rows in Explore      | Set `MOTN_API_KEY`, run `update`, then enable **Auto Hydrations → Streaming Top Charts** in the admin console. Rows appear after its first daily run |
| Avatars don't load                        | Run `bash scripts/selfhost.sh setup` again; it re-applies the storage setting |
| Web app shows CORS errors                 | Add the page's origin (for example `https://app.example.com`) to `CORS_ORIGINS` in `.env.prod`, then run `update` |
| Forgot a password, no email set up        | `bash scripts/selfhost.sh reset-password`                               |
| API logs `table ... does not exist`       | Run `bash scripts/selfhost.sh update`; it applies the database migrations |
| API stops at startup mentioning Apple     | Clear `APPLE_CLIENT_ID` in `.env.prod` (social login needs your own app build), then run `update` |
| Containers start with empty passwords     | You ran `docker compose` without `--env-file .env.prod`                 |

## Manual setup (without the script)

The script only wraps standard Docker Compose commands. To do it by hand:

```bash
alias dc='docker compose --env-file .env.prod -f docker-compose.prod.yml'
# Home network: add  -f docker-compose.local.yml  to the alias

# 1. Configure. Fill in tier 1 (see Configuration): every CHANGE_ME value (the Postgres password
#    also appears inside DATABASE_URL), the example.com addresses, TMDB_API_KEY, and the admin
#    email. Home network: TVWATCH_MODE=local plus TVWATCH_LOCAL_URL and the ports.
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
