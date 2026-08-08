/**
 * Durable marker for import rows whose show graph must be reconciled before an episode
 * target can be trusted. Keep this distinct from cast-related PENDING_MATCH rows.
 */
export const STRUCTURE_PENDING_ERROR = 'Awaiting background TV structure migration';

/** Legacy marker: rows produced by older builds are replayed and healed automatically. */
export const STRUCTURE_REVIEW_ERROR = 'TV structure migration needs manual review';

/** Auditable terminal marker for a provider episode row that has no proven canonical target. */
export const STRUCTURE_SKIPPED_ERROR = 'Skipped unprovable provider episode artifact';
