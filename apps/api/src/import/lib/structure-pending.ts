/**
 * Durable marker for import rows whose show graph must be reconciled before an episode
 * target can be trusted. Keep this distinct from cast-related PENDING_MATCH rows.
 */
export const STRUCTURE_PENDING_ERROR = 'Awaiting background TV structure migration';

/** Terminal marker used when the strict authority migration needs human intervention. */
export const STRUCTURE_REVIEW_ERROR = 'TV structure migration needs manual review';
