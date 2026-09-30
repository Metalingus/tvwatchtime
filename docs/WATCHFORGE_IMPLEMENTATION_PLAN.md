# WatchForge integration scope

Updated 2026-09-22 to follow the product owner's correction: use WatchForge when ordinary
TMDB/TVDB resolution cannot establish the identity/link, and repair verified catalog corruption automatically through
the existing metadata queue. Existing Metadata Health actions reuse the same implementation. Do not add a separate operator workflow.

## Runtime behavior

1. Use existing local IDs and normal TMDB/TVDB matching first.
2. Consult WatchForge for unresolved identities. Corroborate its typed mapping with provider data.
3. Persist a verified binding and reuse it. An outage, quota or cooldown is not conflicting identity
   evidence and must not disable ordinary matching or repeatedly wait for a request that cannot run.
4. Keep duplicate/split transfer safeguards inside the existing repair implementation. Existing
   Metadata Health type-mismatch and duplicate repair actions use that implementation directly.
5. Preserve current library data and recorded episode redirects. Completed TV Time imports stay closed.

## Automatic production repair

A corrupt local match is staged as pending identity repair. After matching finishes, the existing
metadata queue verifies the provider evidence and performs the supported alias partition, attachment,
typed split or duplicate consolidation. It refreshes affected metadata once and invokes the existing
import service to rematch pending rows from their original source identifiers. The callback invalidates
the affected matcher caches; it does not reuse the formerly wrong local match. Ambiguous evidence stays
in review. Transient provider failures retry through BullMQ.

New TV Time imports wait for pending identity work before confirmation. Completed TV Time imports
are excluded from repair callbacks and replay. Other import formats can finish their safe rows and apply
the repaired rows afterward through the existing apply/ownership checks. The callback retains its
pending marker until application finishes so a worker interruption can retry.

Search/hydration identity guards, CommsUni provider conflicts and missing integration cross-links use
the shared reconciler. SIMKL retries a newly resolved alternate identifier once and reschedules affected
outbox entries after an actual repair. Successful ordinary matching retains its fast path.

Production creates these verified bindings and episode redirects itself. No local database snapshot,
one-time repair script, hardcoded media ID, or Admin candidate-loading step is a deployment prerequisite.
The fresh-corruption PostgreSQL fixture covers the normal staging → queue → worker → rematch path.

## Simplification delivered

Removed the separate WatchForge Admin panel, candidate browser, manual preview/apply/report endpoints,
standalone audit schedule and unused candidate/report/manifest-page code. The existing Admin page
and controller are back to their pre-workbench versions.

Internal repair verification, atomic receipts, data-preserving transfers and existing metadata-queue
follow-ups remain implementation details. They are not a new process the administrator must operate.

## Import regression fixed

Import cmucqs9bn006313jhdrei18fs took 354.633 seconds to reach review and was later cancelled.

- The API normalizes UUID queries to queried.provider=tvtime. The client incorrectly required
  tvtime_uuid, rejected valid responses and activated a cooldown.
- The cooldown check ran after rate-limit admission, so unavailable calls still waited.
- UUID provider lookup preceded normal movie matching, and provider deferral suppressed fallback.
- Prefetched episode lookups still queried canonical ownership per row.

The client now accepts the observed documented-provider alias, checks cooldown/quota pauses before
waiting, and preserves cached reads. Movie matching checks accepted local UUID bindings and the normal
matcher before calling WatchForge. Positive episode-prefetch hits require no extra identity queries;
apply still validates current targets transactionally.

Read-only local verification found 143 of 198 previously unmatched movie titles through the normal
matcher with both external providers disabled. This is a local matching benchmark, not a measured
full re-import. The cancelled job was not replayed or modified.

See [validation and rollout](WATCHFORGE_TESTING.md).
