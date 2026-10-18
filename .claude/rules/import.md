---
paths:
  - "apps/api/src/import/**"
  - "apps/api/src/admin/admin-import.service.ts"
  - "apps/mobile/app/import.tsx"
---

# Import system

- **Read `docs/IMPORT_PIPELINE.md` before changing behavior.** It is authoritative.
  `IMPORT_STRATEGY.md` / `IMPORT_SYSTEM.md` are stale stubs. `DOCUMENTATION.md` §11 is background.
- Apply is batched (`import.service.ts`, `createMany`). Keep ownership/deduplication guarantees and
  resumability intact; imports must never overwrite or drop existing user data.
- Completed TV Time imports stay closed: no rematching, reparsing, or replay (see
  `docs/WATCHFORGE_IMPLEMENTATION_PLAN.md`).
- Tests (run the ones near your change):
  - `import.spec.ts`, `import-pipeline{,-trakt,-tvtime-json,-tvtime-out,-tvwatchtime}.spec.ts`
  - Native export restore: `lib/tvwatchtime/*.spec.ts`, `apply-tvwatchtime-restore.spec.ts`,
    plus `users/export.service.spec.ts` (the exporter is the format's source of truth)
  - `lib/{ratings,emotions,comments}.spec.ts`, `lib/trakt/*.spec.ts`, `lib/tvtime-json/*.spec.ts`,
    `lib/matcher*.spec.ts`
  - `apply-*.spec.ts`, `import-*.spec.ts` (retry, resumable, status, identity)
  - Coverage: zip safety, inference, mappings, ownership/dedup, format detection, external-ID matching.
- Command: `pnpm --filter @tvwatch/api test -- src/import/<file>`
