#!/usr/bin/env bash
# Safe API deploy: pull image + apply idempotent additive schema, then restart.
# This avoids `prisma db push`, which does a full schema reconcile and can abort
# a non-interactive deploy on pre-existing drift (e.g. character_votes), leaving
# the API stopped. The additive SQL is IF-NOT-EXISTS, so it's safe on any DB state.
#
# Usage (from repo root):  sudo bash scripts/deploy-api.sh
set -euo pipefail

# Resolve repo root from this script's location (scripts/ -> repo root).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ ! -f .env.prod ]; then
  echo "ERROR: .env.prod not found in $ROOT" >&2
  exit 1
fi

DC="docker compose --env-file .env.prod -f docker-compose.prod.yml"

echo "==> Stopping api…"
$DC stop api

echo "==> Pulling api image…"
$DC pull api

echo "==> Applying additive schema (announcements + broadcasts + contact)…"
$DC exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' \
  < apps/api/prisma/sql/add-contact-and-announcements.sql

echo "==> Starting services…"
$DC up -d

echo "==> Done. Tail logs with:  $DC logs -f api"
