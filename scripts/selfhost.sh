#!/usr/bin/env bash
# TV Watch Time self-hosting helper. See docs/SELF_HOSTING.md.
#
#   bash scripts/selfhost.sh setup    First install: asks a few questions, writes .env.prod,
#                                     starts the stack, applies migrations.
#   bash scripts/selfhost.sh update   Pull new images, back up the database, migrate, restart.
#   bash scripts/selfhost.sh backup   Write a gzipped database dump to ./backups.
set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE=.env.prod
COMPOSE_FILE=docker-compose.prod.yml

dc() { docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }

info() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mWarning:\033[0m %s\n' "$*" >&2; }
die() {
  printf '\033[1;31mError:\033[0m %s\n' "$*" >&2
  exit 1
}

require() { command -v "$1" >/dev/null 2>&1 || die "'$1' is required. $2"; }

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

env_value() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1; }

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
  read -r -p "$prompt" answer || die "No input. Run setup in an interactive terminal."
  printf '%s' "$answer"
}

write_env_file() {
  require openssl "Install it with your package manager (for example: sudo apt install openssl)."

  echo
  echo "TV Watch Time setup. This writes $ENV_FILE; you can edit it later."
  echo

  local domain email tmdb
  while :; do
    domain=$(ask "Your domain (e.g. example.com, without api./admin.): ")
    domain=$(printf '%s' "$domain" | tr '[:upper:]' '[:lower:]')
    domain=${domain#http://}
    domain=${domain#https://}
    domain=${domain%/}
    [[ $domain =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$ ]] && break
    echo "  That doesn't look like a domain name. Try again."
  done

  while :; do
    email=$(ask "Email for your admin account (you'll register with it in the app): ")
    [[ $email =~ ^[^@[:space:]|\&\\]+@[^@[:space:]|\&\\]+\.[^@[:space:]|\&\\]+$ ]] && break
    echo "  That doesn't look like an email address. Try again."
  done

  while :; do
    tmdb=$(ask "TMDb API key (v3), or leave blank to add it later: ")
    if [ -z "$tmdb" ]; then
      warn "Without a TMDb key the server only shows demo data. Add TMDB_API_KEY to $ENV_FILE later."
      break
    fi
    [[ $tmdb =~ ^[A-Za-z0-9]+$ ]] && break
    echo "  Use the short 'API Key' from https://www.themoviedb.org/settings/api,"
    echo "  not the long 'API Read Access Token'. Try again."
  done

  cp .env.prod.example "$ENV_FILE"
  chmod 600 "$ENV_FILE"

  # Hex secrets need no URL-encoding in DATABASE_URL.
  local pg_password redis_password minio_password
  pg_password=$(openssl rand -hex 24)
  redis_password=$(openssl rand -hex 24)
  minio_password=$(openssl rand -hex 24)

  local pg_user pg_db
  pg_user=$(env_value POSTGRES_USER)
  pg_db=$(env_value POSTGRES_DB)

  set_env TVWATCH_DOMAIN "$domain"
  set_env POSTGRES_PASSWORD "$pg_password"
  set_env DATABASE_URL "postgresql://${pg_user}:${pg_password}@postgres:5432/${pg_db}?schema=public"
  set_env REDIS_PASSWORD "$redis_password"
  set_env MINIO_ROOT_PASSWORD "$minio_password"
  set_env S3_SECRET_ACCESS_KEY "$minio_password"
  set_env JWT_SECRET "$(openssl rand -hex 48)"
  set_env ENCRYPTION_MASTER_KEY "$(openssl rand -hex 32)"
  set_env BOOTSTRAP_SUPER_ADMIN_EMAIL "$email"
  set_env TMDB_API_KEY "$tmdb"
  set_env API_BASE_URL "https://api.${domain}"
  set_env CORS_ORIGINS "https://admin.${domain},https://app.${domain},https://app.tvwatchtime.org"
  set_env S3_PUBLIC_BASE_URL "https://s3.${domain}/tvwatch-user-images"
  set_env SITE_URL "https://${domain}"
  set_env VAPID_SUBJECT "mailto:noreply@${domain}"
  set_env SMTP_FROM "no-reply@${domain}"

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
  warn "Couldn't configure the avatar bucket. See 'Storage bucket' in docs/SELF_HOSTING.md."
}

wait_for_health() {
  local url="https://api.$1/health" attempt
  command -v curl >/dev/null 2>&1 || return 0
  info "Waiting for $url"
  for attempt in $(seq 1 24); do
    if curl -fsS --max-time 5 "$url" >/dev/null 2>&1; then
      echo "  The API is up."
      return 0
    fi
    sleep 5
  done
  warn "The API isn't reachable over HTTPS yet. Check DNS, ports 80/443, and: docker compose --env-file $ENV_FILE -f $COMPOSE_FILE logs caddy api"
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

  local domain
  domain=$(env_value TVWATCH_DOMAIN)
  [ -n "$domain" ] || die "Set TVWATCH_DOMAIN in $ENV_FILE (for example TVWATCH_DOMAIN=example.com)."
  check_dns "$domain"

  info "Pulling images"
  dc pull
  info "Starting the database, cache, and storage"
  dc up -d --wait postgres redis minio
  migrate
  info "Starting the API, admin console, and web server"
  dc up -d
  allow_avatar_reads
  wait_for_health "$domain"

  cat <<EOF

Done. Next:
  1. Open the TV Watch Time app (iOS, Android, or https://app.tvwatchtime.org).
  2. On the login screen, turn on "Self-hosted backend" and enter:
       https://api.${domain}/api
  3. Register with $(env_value BOOTSTRAP_SUPER_ADMIN_EMAIL). That account becomes the admin.
  4. Admin console: https://admin.${domain}

Update later with:  bash scripts/selfhost.sh update
EOF
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
  local domain
  domain=$(env_value TVWATCH_DOMAIN)
  [ -z "$domain" ] || wait_for_health "$domain"
}

case "${1:-}" in
  setup) cmd_setup ;;
  update) cmd_update ;;
  backup)
    check_docker
    cmd_backup
    ;;
  *)
    echo "Usage: bash scripts/selfhost.sh <setup|update|backup>"
    exit 1
    ;;
esac
