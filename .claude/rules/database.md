---
paths:
  - "apps/api/prisma/**"
---

# Prisma / database rules

The core DB rules and approval gates are in AGENTS.md. Additional details:

- `schema.prisma` is the data-model source of truth (~90 models). Migrations live in
  `prisma/migrations/<timestamp>_<name>/migration.sql` and are checked in. Review generated SQL
  before proposing to apply it, especially drops, renames (Prisma emits drop+add), and NOT NULL
  columns without defaults on populated tables.
- Creating a migration (`prisma migrate dev --create-only`) touches the local DB/shadow DB. Ask
  first, and confirm the target is the local docker Postgres.
- Data transforms go in migration SQL or idempotent scripts (`prisma/backfill-*.ts`, run via
  `pnpm --filter @tvwatch/api db:backfill-*`). Running a backfill anywhere shared is gate #2.
- `prisma/sql/` holds one-off historical SQL. It is not a migration path; don't add to it.
- After editing the schema or after `pnpm install`: `pnpm db:generate`.
- Windows: `prisma generate` may fail with `EPERM` while Node processes hold the engine files.
  Stop only the relevant processes (e.g. the running `dev:api`), then retry.
- Production migrations use `prisma migrate deploy` (see `production-docs/`). Never run it
  yourself.
