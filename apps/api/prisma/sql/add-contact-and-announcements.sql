-- Idempotent additive schema for the announcements + broadcast + contact features.
-- Safe to run on any DB state: every statement uses IF NOT EXISTS.
-- Apply via the postgres service (NOT prisma db push) to avoid the character_votes drift
-- that makes `db push` abort a non-interactive deploy.
-- Usage (prod):
--   docker compose --env-file .env.prod -f docker-compose.prod.yml exec -T postgres \
--     sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' \
--     < apps/api/prisma/sql/add-contact-and-announcements.sql

-- ── Enum values ───────────────────────────────────────────────────────────────
ALTER TYPE "NotificationCategory" ADD VALUE IF NOT EXISTS 'ANNOUNCEMENT';
ALTER TYPE "NotificationCategory" ADD VALUE IF NOT EXISTS 'CONTACT';

DO $$ BEGIN
  CREATE TYPE "ContactReason" AS ENUM ('FEEDBACK','BUG_REPORT','DATA','PERSONAL_INFO','ACCOUNT','OTHER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "ContactThreadStatus" AS ENUM ('OPEN','CLOSED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "ContactMessageAuthor" AS ENUM ('USER','ADMIN');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── announcements ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "announcements" (
    "id"            TEXT                  NOT NULL,
    "revision"      INTEGER               NOT NULL DEFAULT 1,
    "icon"          TEXT                  NOT NULL DEFAULT 'information-circle-outline',
    "title"         JSONB                 NOT NULL,
    "message"       JSONB                 NOT NULL,
    "action_label"  JSONB,
    "action_type"   TEXT                  NOT NULL DEFAULT 'none',
    "action_target" TEXT,
    "action_params" JSONB,
    "placement"     TEXT                  NOT NULL DEFAULT 'shows',
    "active"        BOOLEAN               NOT NULL DEFAULT false,
    "also_push"     BOOLEAN               NOT NULL DEFAULT false,
    "push_sent_at"  TIMESTAMP(3),
    "created_by"    TEXT                  NOT NULL,
    "created_at"    TIMESTAMP(3)          NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"    TIMESTAMP(3)          NOT NULL,
    CONSTRAINT "announcements_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "announcements_active_idx" ON "announcements"("active");

-- ── broadcasts ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "broadcasts" (
    "id"               TEXT                   NOT NULL,
    "title"            JSONB                  NOT NULL,
    "body"             JSONB,
    "category"         "NotificationCategory" NOT NULL DEFAULT 'ANNOUNCEMENT',
    "action_type"      TEXT,
    "action_target"    TEXT,
    "action_params"    JSONB,
    "in_app"           BOOLEAN                NOT NULL DEFAULT false,
    "total_recipients" INTEGER                NOT NULL DEFAULT 0,
    "sent_count"       INTEGER                NOT NULL DEFAULT 0,
    "failed_count"     INTEGER                NOT NULL DEFAULT 0,
    "status"           TEXT                   NOT NULL DEFAULT 'queued',
    "started_at"       TIMESTAMP(3),
    "completed_at"     TIMESTAMP(3),
    "error"            TEXT,
    "created_by"       TEXT                   NOT NULL,
    "created_at"       TIMESTAMP(3)           NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "broadcasts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "broadcasts_status_idx" ON "broadcasts"("status");

-- ── contact_threads ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "contact_threads" (
    "id"              TEXT                   NOT NULL,
    "user_id"         TEXT                   NOT NULL,
    "reason"          "ContactReason"        NOT NULL,
    "subject"         TEXT                   NOT NULL,
    "status"          "ContactThreadStatus"  NOT NULL DEFAULT 'OPEN',
    "admin_replied"   BOOLEAN                NOT NULL DEFAULT false,
    "user_read_at"    TIMESTAMP(3),
    "admin_read_at"   TIMESTAMP(3),
    "closed_at"       TIMESTAMP(3),
    "closed_by"       TEXT,
    "last_message_at" TIMESTAMP(3)           NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at"      TIMESTAMP(3)           NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      TIMESTAMP(3)           NOT NULL,
    CONSTRAINT "contact_threads_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "contact_threads_user_id_idx" ON "contact_threads"("user_id");
CREATE INDEX IF NOT EXISTS "contact_threads_status_idx" ON "contact_threads"("status");
CREATE INDEX IF NOT EXISTS "contact_threads_last_message_at_idx" ON "contact_threads"("last_message_at");
DO $$ BEGIN
  ALTER TABLE "contact_threads"
    ADD CONSTRAINT "contact_threads_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── contact_messages ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "contact_messages" (
    "id"          TEXT                   NOT NULL,
    "thread_id"   TEXT                   NOT NULL,
    "author_role" "ContactMessageAuthor" NOT NULL,
    "author_id"   TEXT                   NOT NULL,
    "body"        TEXT                   NOT NULL,
    "created_at"  TIMESTAMP(3)           NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "contact_messages_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "contact_messages_thread_id_created_at_idx" ON "contact_messages"("thread_id","created_at");
DO $$ BEGIN
  ALTER TABLE "contact_messages"
    ADD CONSTRAINT "contact_messages_thread_id_fkey"
    FOREIGN KEY ("thread_id") REFERENCES "contact_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
