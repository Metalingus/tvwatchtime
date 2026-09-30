# WatchForge validation and rollout

Updated 2026-09-22. There is no separate WatchForge candidate/report/preview panel.
Normal unresolved matching and identity guards trigger the existing metadata queue automatically.
Existing Metadata Health repair actions reuse that implementation; no manual candidate workflow is required.

## Import behavior to verify

- Known local identities and successful normal TMDB/TVDB matches do not require a WatchForge request.
- A missing link can use a verified WatchForge mapping and retain it for later matching.
- Quota/cooldown/outage returns promptly. It does not suppress an otherwise valid ordinary match.
- The provider's queried.provider=tvtime response is accepted for a tvtime_uuid query.
- Prefetched episode aliases/coordinates use their local cache. Apply rechecks current identity.
- Completed TV Time imports stay closed. A cancelled job is not resumed by this change.

## September 22 regression evidence

The reported import cmucqs9bn006313jhdrei18fs processed 41,633 source rows and reached review in
354.633 seconds. It was later cancelled. Read-only database/Redis inspection found:

- Fourteen actual WatchForge HTTP attempts during its processing window.
- Today's provider metrics included 639 cooldown/quota deferrals and eleven invalid-response outcomes.
- A public example from the provider documentation returned queried.provider=tvtime, exposing the
  parser mismatch. The corrected production client successfully resolves that public example.
- A local-only benchmark resolved 143 of 198 distinct movie titles previously marked unmatched in
  about 1.6 seconds without either provider enabled.
- Five thousand staged episode lookups used one batch prefetch; 4,987 resolved. Subsequent lookup
  time was 459 ms, with additional database work confined to cache misses.

These component timings are not a full re-import measurement. The cancelled import, completed imports,
user history and existing catalog records were not rewritten by these diagnostics.
Subsequently, the owner explicitly authorized testing unresolved identifiers with WatchForge and
verifying proposed links with TMDB/TVDB. Targeted local testing resolved the latest import's 25 pending
review/unmatched rows without confirming the import or replaying completed TV Time imports. Thirteen
catalog records were repaired locally. One Bachelorette metadata refresh remains protected-structure
blocked; this is separate from the repaired identity links.

Those local results are not evidence that production data is already repaired. The production path is
tested independently with freshly seeded corrupt records; each PostgreSQL fixture rolls back:
conflicting aliases, an unrelated show attached to a movie with watched episodes, rematching a removed
input alias to another movie, and retrying an interrupted non-TV-Time application callback. Provider
responses and metadata refresh are deterministic stubs in these workflow fixtures. Separate tests cover
the provider contract, repair engine, refresh behavior, real database write races and Redis rate limits.

Regression tests cover fallback ordering, accepted bindings, quota fallback, the tvtime response alias,
600 distinct identities returning during one cooldown without rate-limit admission, and repeated
prefetched episode lookups without canonical queries. Existing import and repair regression suites
remain applicable.

## Latest full-archive regression

Import cmucz2xfr001iykhmjkalv5iz staged 66,321 source rows in 52.36 seconds. It exposed two gaps:
a record with multiple independently valid movie identities could not partition even when its exact
title/year and another verified provider anchor identified the retained work; and the worker attempted
hydration of a still-conflicted source after a partial split. The planner now accepts that strictly
corroborated partition, and the worker checks each affected record before refresh, retaining blocked
sources for review while refreshing clean targets.

The fresh PostgreSQL workflow fixture now includes two different movies' TMDB/IMDb pairs on one row.
Retired-episode unit tests cover confirmed 404 recovery, live contradictory IDs, outages, unsupported
coordinates, and incomplete/combined bridges.

Running the normal repair worker and pre-confirm reconciliation implementation locally resolved the
two Willy Wonka entries and ten WHAT / IF episodes. No import confirmation or completed TV Time replay
was performed. The two deleted umbrella watchlist titles remain reviewable because current provider data does not
prove a series target. The owner subsequently confirmed Atlantis E13 as the finale's second half. The
existing TV Time legacy module now recognizes that specific provider-ID correction, revalidates the
current parent/title/coordinate and combined runtime, requires the first half in the same import, and
resolves both halves onto the single finale.
Apply retains one watch/status and records the canonical episode number. All 39 previously skipped TVDB episode IDs were
checked and returned 404; no identities were invented to force a zero-unresolved result.

## Data safety and release

Duplicate and split repairs preserve recovery sources and manual choices, validate episode/role
destinations, and commit receipts with the transfer. Recorded episode mappings preserve future imports
and integration ownership. These protections remain inside the backend; no manual workbench is needed.

The earlier nine additive migrations were already applied only to localhost:5432/tvwatch:
TV_TIME enum, six lookup indexes, and two extensions of the existing copy ledger.
This simplification requires no additional migration and does not roll back existing data/schema.
Prisma client generation was completed for those migrations.

Before production, apply the reviewed migrations, configure the production provider credentials,
and deploy the matching API/metadata worker image. No local repair scripts or data export are required.
The owner runs API/admin/shared builds and any required Expo web export. No build, export, publication
or deployment was run for this fix. Restart development processes if they are not watching source changes.

API source and admin/shared no-emit typechecks, targeted lint and focused regression tests are the
validation gates. The opt-in PostgreSQL/Redis fixture suites remain available; they reject non-local
targets and are separate from replaying a real import.
