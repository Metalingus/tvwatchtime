#!/usr/bin/env bash
# TV Watch Time self-hosting helper. See docs/SELF_HOSTING.md.
#
#   bash scripts/selfhost.sh setup            First install: asks a few questions, writes .env.prod,
#                                             starts the stack, applies migrations.
#   bash scripts/selfhost.sh update           Pull new images, back up the database, migrate, restart.
#   bash scripts/selfhost.sh backup           Write a gzipped database dump to ./backups.
#   bash scripts/selfhost.sh reset-password   Set a new password for an account (no email needed).
set -euo pipefail
# Keep errexit inside $(...) so a failed prompt stops the script instead of looping.
shopt -s inherit_errexit 2>/dev/null || true

cd "$(dirname "$0")/.."

ENV_FILE=.env.prod
COMPOSE_FILE=docker-compose.prod.yml
LOCAL_COMPOSE_FILE=docker-compose.local.yml
# Pinned so key generation doesn't change under us.
WEB_PUSH_PACKAGE=web-push@3.6.7

info() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mWarning:\033[0m %s\n' "$*" >&2; }
die() {
  printf '\033[1;31mError:\033[0m %s\n' "$*" >&2
  exit 1
}

require() { command -v "$1" >/dev/null 2>&1 || die "'$1' is required. $2"; }

env_value() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1; }

mode() {
  if [ -f "$ENV_FILE" ] && [ "$(env_value TVWATCH_MODE)" = local ]; then
    echo local
  else
    echo domain
  fi
}

# Home-network mode layers docker-compose.local.yml (plain HTTP, no domain) over the main file.
dc() {
  local files=(-f "$COMPOSE_FILE")
  [ "$(mode)" = local ] && files+=(-f "$LOCAL_COMPOSE_FILE")
  docker compose --env-file "$ENV_FILE" "${files[@]}" "$@"
}

check_docker() {
  require docker "Install Docker Engine: https://docs.docker.com/engine/install/"
  docker compose version >/dev/null 2>&1 ||
    die "The Docker Compose v2 plugin is required: https://docs.docker.com/compose/install/linux/"
  docker info >/dev/null 2>&1 ||
    die "Docker isn't running, or this user can't use it. Start Docker, or run with sudo / add your user to the 'docker' group."
}

require_env_file() {
  [ -f "$ENV_FILE" ] || die "$ENV_FILE not found. Run: bash scripts/selfhost.sh setup"
}

# Values are validated before this is called, so they never contain '|', '&' or '\'.
set_env() {
  local key=$1 value=$2
  if grep -q "^${key}=" "$ENV_FILE"; then
    sed "s|^${key}=.*|${key}=${value}|" "$ENV_FILE" >"$ENV_FILE.tmp"
    cat "$ENV_FILE.tmp" >"$ENV_FILE"
    rm -f "$ENV_FILE.tmp"
  else
    printf '%s=%s\n' "$key" "$value" >>"$ENV_FILE"
  fi
}

ask() {
  local prompt=$1 answer
  read -r -p "$prompt" answer || die "No input. Run this in an interactive terminal."
  printf '%s' "$answer"
}

ask_secret() {
  local prompt=$1 answer
  read -r -s -p "$prompt" answer || die "No input. Run this in an interactive terminal."
  echo >&2
  printf '%s' "$answer"
}

valid_email() { [[ $1 =~ ^[^@[:space:]|\&\\]+@[^@[:space:]|\&\\]+\.[^@[:space:]|\&\\]+$ ]]; }
valid_key() { [[ $1 =~ ^[A-Za-z0-9_-]+$ ]]; }

ask_email() {
  local email
  while :; do
    email=$(ask "$1") || exit 1
    valid_email "$email" && break
    echo "  That doesn't look like an email address. Try again." >&2
  done
  printf '%s' "$email"
}

ask_optional_key() {
  local prompt=$1 key
  while :; do
    key=$(ask "$prompt") || exit 1
    [ -z "$key" ] && break
    valid_key "$key" && break
    echo "  That key has unexpected characters. Paste just the key, or leave it blank." >&2
  done
  printf '%s' "$key"
}

ask_port() {
  local prompt=$1 default=$2 port
  while :; do
    port=$(ask "$prompt [$default]: ") || exit 1
    port=${port:-$default}
    if [[ $port =~ ^[0-9]+$ ]] && [ "$port" -ge 1 ] && [ "$port" -le 65535 ]; then
      if command -v ss >/dev/null 2>&1 && ss -ltnH "sport = :$port" 2>/dev/null | grep -q .; then
        echo "  Port $port is already in use on this machine. Pick another one." >&2
        continue
      fi
      break
    fi
    echo "  Enter a port number between 1 and 65535." >&2
  done
  printf '%s' "$port"
}

detect_lan_address() {
  local address=''
  address=$(hostname -I 2>/dev/null | awk '{print $1}') || true
  if [ -z "$address" ] && command -v ip >/dev/null 2>&1; then
    address=$(ip -4 route get 1.1.1.1 2>/dev/null |
      awk '{for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit }}') || true
  fi
  printf '%s' "$address"
}

ask_domain() {
  local domain
  while :; do
    domain=$(ask "Your domain (e.g. example.com, without api./admin.): ") || exit 1
    domain=$(printf '%s' "$domain" | tr '[:upper:]' '[:lower:]')
    domain=${domain#http://}
    domain=${domain#https://}
    domain=${domain%/}
    [[ $domain =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$ ]] && break
    echo "  That doesn't look like a domain name. Try again." >&2
  done
  printf '%s' "$domain"
}

ask_lan_host() {
  local detected host
  detected=$(detect_lan_address)
  while :; do
    if [ -n "$detected" ]; then
      host=$(ask "Address other devices use to reach this machine [$detected]: ") || exit 1
      host=${host:-$detected}
    else
      host=$(ask "Address other devices use to reach this machine (e.g. 192.168.1.20): ") || exit 1
    fi
    host=$(printf '%s' "$host" | tr '[:upper:]' '[:lower:]')
    [[ $host =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] && break
    echo "  Enter an IP address or host name, without http:// or a port." >&2
  done
  printf '%s' "$host"
}

# Web push needs VAPID keys. Generated with the standard web-push tool in a throwaway container.
generate_vapid_keys() {
  local json public private
  json=$(docker run --rm node:20-alpine npx -y "$WEB_PUSH_PACKAGE" generate-vapid-keys --json 2>/dev/null) ||
    return 1
  public=$(printf '%s' "$json" | sed -n 's/.*"publicKey":"\([A-Za-z0-9_-]*\)".*/\1/p')
  private=$(printf '%s' "$json" | sed -n 's/.*"privateKey":"\([A-Za-z0-9_-]*\)".*/\1/p')
  [ -n "$public" ] && [ -n "$private" ] || return 1
  set_env VAPID_PUBLIC_KEY "$public"
  set_env VAPID_PRIVATE_KEY "$private"
}

write_env_file() {
  require openssl "Install it with your package manager (for example: sudo apt install openssl)."

  cat <<'EOF'

TV Watch Time setup. This writes .env.prod; you can edit it later.

How will you reach this server?
  1) From anywhere, with my own domain (HTTPS). Works with the iPhone and Android apps.
  2) Only on my home network, without a domain (plain HTTP). Web browser only, and you build
     the web app yourself (needs Node.js 20 and pnpm; see docs/SELF_HOSTING.md#web-app).

EOF
  local choice
  while :; do
    choice=$(ask "Choose 1 or 2 [1]: ") || exit 1
    choice=${choice:-1}
    [ "$choice" = 1 ] || [ "$choice" = 2 ] && break
    echo "  Enter 1 or 2." >&2
  done

  local domain='' host='' http_port=80 admin_port=8080 base_url
  if [ "$choice" = 1 ]; then
    domain=$(ask_domain)
    base_url="https://api.${domain}"
  else
    host=$(ask_lan_host)
    http_port=$(ask_port "Port for the web app" 80)
    while :; do
      admin_port=$(ask_port "Port for the admin console" 8080)
      [ "$admin_port" != "$http_port" ] && break
      echo "  The admin console needs a different port than the web app." >&2
    done
    base_url="http://${host}"
    [ "$http_port" = 80 ] || base_url="${base_url}:${http_port}"
  fi

  local email tmdb tvdb motn
  email=$(ask_email "Email for your admin account (you'll register with it in the app): ")

  echo
  echo "TMDb provides show and movie information. Get a free key at"
  echo "https://www.themoviedb.org/settings/api (use the short 'API Key', not the long token)."
  tmdb=$(ask_optional_key "TMDb API key (required; leave blank to add it later): ")
  [ -n "$tmdb" ] || warn "Without a TMDb key you can't search or add shows. Add TMDB_API_KEY to $ENV_FILE later."

  echo
  echo "Optional, recommended. Press Enter to skip; you can add them to $ENV_FILE later."
  echo "  TheTVDB: more shows in search, better episode lists and air dates, character photos."
  echo "  Key: https://thetvdb.com/api-information"
  tvdb=$(ask_optional_key "TheTVDB API key: ")
  echo "  Movie of the Night: the 'Top on Netflix / Prime Video / Disney+ ... today' rows in Explore."
  echo "  Free key (1000 requests/month): https://www.movieofthenight.com/about/api"
  motn=$(ask_optional_key "Movie of the Night API key: ")

  cp .env.prod.example "$ENV_FILE"
  chmod 600 "$ENV_FILE"

  # Hex secrets need no URL-encoding in DATABASE_URL.
  local pg_password redis_password minio_password pg_user pg_db
  pg_password=$(openssl rand -hex 24)
  redis_password=$(openssl rand -hex 24)
  minio_password=$(openssl rand -hex 24)
  pg_user=$(env_value POSTGRES_USER)
  pg_db=$(env_value POSTGRES_DB)

  set_env POSTGRES_PASSWORD "$pg_password"
  set_env DATABASE_URL "postgresql://${pg_user}:${pg_password}@postgres:5432/${pg_db}?schema=public"
  set_env REDIS_PASSWORD "$redis_password"
  set_env MINIO_ROOT_PASSWORD "$minio_password"
  set_env S3_SECRET_ACCESS_KEY "$minio_password"
  set_env JWT_SECRET "$(openssl rand -hex 48)"
  set_env ENCRYPTION_MASTER_KEY "$(openssl rand -hex 32)"
  set_env BOOTSTRAP_SUPER_ADMIN_EMAIL "$email"
  set_env TMDB_API_KEY "$tmdb"
  set_env TVDB_API_KEY "$tvdb"
  set_env MOTN_API_KEY "$motn"
  set_env API_BASE_URL "$base_url"
  set_env VAPID_SUBJECT "mailto:${email}"

  if [ "$choice" = 1 ]; then
    set_env TVWATCH_MODE domain
    set_env TVWATCH_DOMAIN "$domain"
    set_env CORS_ORIGINS "https://${domain},https://admin.${domain},https://app.${domain}"
    set_env S3_PUBLIC_BASE_URL "https://s3.${domain}/tvwatch-user-images"
    set_env SITE_URL "https://${domain}"
    set_env SMTP_FROM "no-reply@${domain}"
    info "Generating web push keys"
    generate_vapid_keys || warn "Couldn't generate web push keys; browser notifications stay off. See docs/SELF_HOSTING.md."
  else
    local origins="${base_url},http://${host}:${admin_port},http://localhost:${admin_port}"
    if [ "$http_port" = 80 ]; then origins="${origins},http://localhost"; else origins="${origins},http://localhost:${http_port}"; fi
    set_env TVWATCH_MODE local
    set_env TVWATCH_DOMAIN ''
    set_env TVWATCH_LOCAL_URL "$base_url"
    set_env TVWATCH_HTTP_PORT "$http_port"
    set_env TVWATCH_ADMIN_PORT "$admin_port"
    set_env CORS_ORIGINS "$origins"
    set_env S3_PUBLIC_BASE_URL "${base_url}/tvwatch-user-images"
    set_env SITE_URL "$base_url"
    # Media servers on the same network use private addresses.
    set_env ALLOW_PRIVATE_INTEGRATION_URLS true
  fi

  info "Wrote $ENV_FILE"
  echo "  Keep a copy of it somewhere safe. ENCRYPTION_MASTER_KEY can't be recovered if lost."
}

check_dns() {
  local domain=$1 host missing=0
  command -v getent >/dev/null 2>&1 || return 0
  for host in "api.$domain" "admin.$domain" "s3.$domain"; do
    if ! getent hosts "$host" >/dev/null 2>&1; then
      warn "$host doesn't resolve yet. Create a DNS record pointing it at this server."
      missing=1
    fi
  done
  if [ "$missing" = 1 ]; then
    echo "  HTTPS certificates are issued once DNS works; Caddy keeps retrying until then."
  fi
}

migrate() {
  info "Applying database migrations"
  dc run --rm --no-deps -T api \
    pnpm -C /app/apps/api exec prisma migrate deploy \
    --schema=/app/apps/api/prisma/schema.prisma
}

allow_avatar_reads() {
  info "Allowing public read-only access to avatars and covers"
  local attempt
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    if dc exec -T minio sh -c '
      mc alias set local http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null &&
      mc mb --ignore-existing local/tvwatch-user-images >/dev/null &&
      mc anonymous set download local/tvwatch-user-images >/dev/null'; then
      return 0
    fi
    sleep 3
  done
  warn "Couldn't configure the avatar bucket. See 'Troubleshooting' in docs/SELF_HOSTING.md."
}

health_url() {
  if [ "$(mode)" = local ]; then
    printf '%s/health' "$(env_value TVWATCH_LOCAL_URL)"
  else
    local domain
    domain=$(env_value TVWATCH_DOMAIN)
    [ -z "$domain" ] || printf 'https://api.%s/health' "$domain"
  fi
}

wait_for_health() {
  local url attempt
  url=$(health_url)
  [ -n "$url" ] || return 0
  command -v curl >/dev/null 2>&1 || return 0
  info "Waiting for $url"
  for attempt in $(seq 1 24); do
    if curl -fsS --max-time 5 "$url" >/dev/null 2>&1; then
      echo "  The API is up."
      return 0
    fi
    sleep 5
  done
  if [ "$(mode)" = local ]; then
    warn "The API isn't answering yet. Check: bash scripts/selfhost.sh logs"
  else
    warn "The API isn't reachable over HTTPS yet. Check DNS and ports 80/443, then: bash scripts/selfhost.sh logs"
  fi
}

print_next_steps() {
  local email
  email=$(env_value BOOTSTRAP_SUPER_ADMIN_EMAIL)
  if [ "$(mode)" = local ]; then
    local url admin_port host
    url=$(env_value TVWATCH_LOCAL_URL)
    admin_port=$(env_value TVWATCH_ADMIN_PORT)
    host=${url#http://}
    host=${host%%:*}
    if [ ! -f app-web/index.html ]; then
      cat <<EOF

The server is running, but there's no web app build in ./app-web yet. Build it once
(needs Node.js 20 and pnpm), then open $url:

  cp apps/mobile/app.example.json apps/mobile/app.json
  # In apps/mobile/app.json, set expo.extra.apiBaseUrl to  $url/api
  pnpm install
  pnpm --filter @tvwatch/shared build
  (cd apps/mobile && npx expo export --platform web --output-dir ../../app-web)
EOF
    fi
    cat <<EOF

Next:
  1. On any computer, tablet, or phone on your network, open:  $url
  2. Register with $email. That account becomes the admin.
     (If the login screen shows "Self-hosted backend", turn it on and use $url/api)
  3. Admin console: http://$host:$admin_port

Home-network mode works in web browsers only; the iPhone and Android apps need a domain (HTTPS).
EOF
  else
    local domain
    domain=$(env_value TVWATCH_DOMAIN)
    cat <<EOF

Done. Next:
  1. Open the TV Watch Time app on iPhone or Android.
  2. On the login screen, turn on "Self-hosted backend" and enter:
       https://api.${domain}/api
  3. Register with $email. That account becomes the admin.
  4. Admin console: https://admin.${domain}

Want it in a browser too? Build your own web app: docs/SELF_HOSTING.md#web-app
EOF
  fi
  cat <<'EOF'

Update later with:     bash scripts/selfhost.sh update
Forgot a password?     bash scripts/selfhost.sh reset-password
More options:          docs/SELF_HOSTING.md
EOF
}

cmd_backup() {
  require_env_file
  mkdir -p backups
  local file
  file="backups/tvwatch-$(date +%Y%m%d-%H%M%S).sql.gz"
  info "Backing up the database to $file"
  if ! dc exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' | gzip >"$file"; then
    rm -f "$file"
    die "Backup failed. Is the postgres container running?"
  fi
}

cmd_setup() {
  check_docker
  if [ -f "$ENV_FILE" ]; then
    info "$ENV_FILE already exists; using it as is"
  else
    write_env_file
  fi

  if [ "$(mode)" = local ]; then
    [ -n "$(env_value TVWATCH_LOCAL_URL)" ] ||
      die "Set TVWATCH_LOCAL_URL in $ENV_FILE (for example TVWATCH_LOCAL_URL=http://192.168.1.20)."
  else
    local domain
    domain=$(env_value TVWATCH_DOMAIN)
    [ -n "$domain" ] || die "Set TVWATCH_DOMAIN in $ENV_FILE (for example TVWATCH_DOMAIN=example.com)."
    check_dns "$domain"
  fi

  info "Pulling images"
  dc pull
  info "Starting the database, cache, and storage"
  dc up -d --wait postgres redis minio
  migrate
  info "Starting the API, admin console, and web server"
  dc up -d
  allow_avatar_reads
  wait_for_health
  print_next_steps
}

cmd_update() {
  check_docker
  require_env_file
  info "Pulling new images"
  dc pull
  info "Stopping the API"
  dc stop api
  cmd_backup
  migrate
  info "Restarting with the new images"
  dc up -d
  wait_for_health
}

# Uses the normal reset flow: request a reset, read the one-hour token from the database, and
# redeem it inside the API container. Works without email (SMTP) configured.
cmd_reset_password() {
  check_docker
  require_env_file
  local email password confirm token
  email=$(ask_email "Account email: ")
  while :; do
    password=$(ask_secret "New password (at least 8 characters): ") || exit 1
    if [ "${#password}" -lt 8 ]; then
      echo "  Too short. Try again." >&2
      continue
    fi
    confirm=$(ask_secret "Repeat the new password: ") || exit 1
    [ "$password" = "$confirm" ] && break
    echo "  The passwords don't match. Try again." >&2
  done

  printf '%s' "$email" | dc exec -T api node -e "
    let email = '';
    process.stdin.on('data', (c) => (email += c)).on('end', async () => {
      const r = await fetch('http://localhost:4000/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (!r.ok) { console.error(await r.text()); process.exit(1); }
    });
  " || die "The API didn't accept the reset request. Is it running? (bash scripts/selfhost.sh logs)"

  token=$(printf '%s\n' "SELECT token FROM password_resets WHERE email = lower(:'email') AND user_id IS NOT NULL AND used_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 1;" |
    dc exec -T postgres sh -c 'psql -q -t -A -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v email="$1"' sh "$email") ||
    die "Couldn't read the reset token from the database."
  token=$(printf '%s' "$token" | tr -d '[:space:]')
  [ -n "$token" ] || die "No account uses $email."

  printf '%s' "$password" | dc exec -T api node -e "
    let newPassword = '';
    process.stdin.on('data', (c) => (newPassword += c)).on('end', async () => {
      const r = await fetch('http://localhost:4000/api/auth/reset-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: process.argv[1], newPassword }),
      });
      if (!r.ok) { console.error(await r.text()); process.exit(1); }
    });
  " "$token" || die "The password wasn't changed."

  info "Password updated for $email"
}

case "${1:-}" in
  setup) cmd_setup ;;
  update) cmd_update ;;
  backup)
    check_docker
    cmd_backup
    ;;
  reset-password) cmd_reset_password ;;
  logs)
    check_docker
    require_env_file
    dc logs --tail 200 -f api caddy
    ;;
  *)
    cat <<'EOF'
Usage: bash scripts/selfhost.sh <command>

  setup            First install (asks a few questions, then starts everything)
  update           Update to the newest version (backs up the database first)
  backup           Save a database backup to ./backups
  reset-password   Set a new password for an account
  logs             Follow the API and web server logs
EOF
    exit 1
    ;;
esac
