# Import System (Technical)

See `docs/DOCUMENTATION.md` → Section 11 and `docs/IMPORT_STRATEGY.md` for details.

## Worker Pipeline (BullMQ)
```
upload → QUEUED → EXTRACTING (safe ZIP) → PARSING (CSV)
  → NORMALIZING (inference + dedupe) → MATCHING (title-based)
  → READY_FOR_REVIEW (preview in DB)
  → [user confirms] → IMPORTING (batched apply)
  → COMPLETED (rebuild show statuses, invalidate stats, cleanup temp)
```

## Files
- `import.processor.ts` — BullMQ worker pipeline
- `import.service.ts` — upload, confirm, rollback, rebuildShowStatuses
- `lib/inference.ts` — TVTime + generic entity detection
- `lib/matcher.ts` — title matching with confidence + per-show caching
- `lib/zip-validator.ts` — safe ZIP inspection
- `lib/csv.ts` — streaming CSV parser
- `import.spec.ts` — unit tests
