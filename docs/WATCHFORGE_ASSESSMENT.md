# WatchForge identity assessment

> Superseded by [the live database investigation](WATCHFORGE_DATABASE_FINDINGS.md),
> which includes 428 authenticated lookups, actual Metadata Health counts, and repair candidates.
> Follow [the prioritized implementation plan](WATCHFORGE_IMPLEMENTATION_PLAN.md) for current
> scope; it excludes completed TV Time imports from reprocessing.

Studied on 2026-09-19 against the current TV Watch Time checkout and WatchForge's
public documentation / OpenAPI 3.1 contract (API specification version 1.2.1).

## Recommendation

Evaluate WatchForge as a supplementary identity resolver, initially in report-only
mode. Its most distinctive contribution is TV Time movie UUID → provider IDs.
It could also find missing TMDB/TVDB/IMDb bridges and expose contradictory local
aliases. Keep our internal media IDs, metadata ownership rules, and episode
remapping machinery authoritative inside the application.

It cannot establish that every apparent duplicate is interchangeable. A title
identity and an episode structure are different facts. The durable solution is
an evidence-backed audit, shared resolution across import paths, controlled
repairs, and prevention of the same errors on subsequent imports.

This is a code/contract assessment, not a production database diagnosis. No
database was queried or changed. No authenticated catalog lookup was performed;
coverage, accuracy, latency, and recovery counts remain unmeasured.

## What the public API actually offers

Primary sources: [API documentation](https://api.watchforge.app/docs),
[OpenAPI specification](https://api.watchforge.app/developers/openapi.json), and
[developer portal](https://api.watchforge.app/).

The relevant endpoint is `GET /v1/catalog/lookup`. Inputs are a provider ID,
its namespace (`type`), and `media_type=movie|tv`. Supported namespaces include
WFDB, TMDB, TVDB, IMDb, and TV Time UUID. Responses identify a WatchForge record
through a string `wf_id` and expose provider aliases, title/year, and supporting
metadata. WatchForge describes these aliases as verified; the contract does
not expose the verification method, evidence, confidence, or verification date.

Implementation-significant details:

- Use an approved developer key (`wfk_dev_`) in the Authorization header. A
  personal account key cannot access catalog lookup. No key is required for health.
- Always specify namespace and media type. Bare numbers default to TMDB, and an
  ID shared between movie/TV namespaces can return `409 ambiguous_id`.
- Missing provider IDs are nullable. `ids` can contain arrays of aliases and
  additional provider keys. Do not assume one returned scalar exhausts the aliases,
  or automatically trust unknown provider keys.
- `wf_id` remains a string; its schema permits values outside JavaScript's safe
  integer range. Normalize other IDs defensively too.
- The documented starting allowance is 60 requests/minute and 1,000/day. Honor
  rate-limit headers and `Retry-After`; confirm the actual allowance for our key.
- `404` means no verified catalog match, not that the title or imported activity
  is invalid. Outages, authorization failures, and quota exhaustion are separate
  outcomes, never negative identity evidence.
- The published contract contains one catalog lookup endpoint. It does not offer
  catalog search, batch lookup, episode-ID translation, season graphs, split/merge
  relationships, a changes feed, or a downloadable identity dataset. Account
  calendar/history endpoints do not supply those catalog capabilities.
- The docs explicitly disallow walking the TV Time UUID catalog. Query only
  deduplicated identifiers already present in our catalog/import evidence.

Public `GET /v1/health` returned `ok=true`, `enabled=true`, `version=v1` during
this study. That establishes liveness only. The portal's catalog totals do not
establish coverage of TV Time UUIDs or deleted TVDB aliases.

Before relying on persistent shared mappings, confirm permitted application use,
caching/retention, quota increases, and the semantics of corrected/merged WFDB
records with the provider. These guarantees were not established by the reviewed
public contract. No application or external message was submitted.

## Fit against our actual code

| Problem                                                | Current implementation                                          | Potential WatchForge contribution                       | Remaining proof                                                            |
| ------------------------------------------------------ | --------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------- |
| TV Time movie UUID with no useful title                | Archive-local title/year evidence and UUID bindings             | Exact UUID lookup may recover a typed provider identity | Validate response and target; conflicting source evidence stays reviewable |
| UUID-only list/favorite entries                        | Separate title-based resolver; titleless entries are not staged | Resolve UUID before the title-required early return     | Preserve source identity and make old entries replayable                   |
| TVDB-only movie missing TMDB                           | IMDb bridge, TVDB remote IDs, then title/year/local metadata    | Another ID bridge before title fallback                 | Direct provider corroboration before attaching/merging                     |
| Wrong or contradictory aliases                         | Existing kind-aware lookups and Metadata Health repairs         | Detect disagreement and prioritize suspects             | Disagreement alone does not prove which side is wrong                      |
| Duplicate show rows or season components               | Complete graph proof and atomic canonicalization                | Find candidate cross-provider families                  | Existing episode/component proof remains mandatory                         |
| Deleted TVDB IDs                                       | Guarded replacement search and archive episode evidence         | May retain an old alias missing upstream                | Historical alias coverage is unknown; verify replacement scope             |
| Split/combined episodes, specials, anthology numbering | Structure Remap and exact episode aliases                       | At most improves parent-title identification            | No public episode crosswalk; cannot resolve these alone                    |

### 1. UUID resolution currently lives within an archive

[`ArchiveIdentityIndex`](../apps/api/src/import/lib/archive-identity.ts) keeps
movie evidence/bindings in memory for an import. It joins titles, release years,
range-key title hints, and movie UUIDs across files. It does not query a global
TV Time UUID catalog.

[`resolveMovieTarget`](../apps/api/src/import/import.processor.ts) first reuses
that archive binding, then tries title candidates through `matchMedia`. This is
a natural insertion point for validated UUID evidence before title fallback.
The main watched-movie matching path must use the same resolver too.

[`ExternalProvider`](../apps/api/prisma/schema.prisma) currently has neither a
TV Time nor a WatchForge namespace. `ExternalId` correctly enforces uniqueness
on `(provider, providerEntityKind, value)`. UUIDs survive in some import JSON,
but there is no first-class global UUID binding in that identity table.

Proposed persistence should distinguish the identifier's owner (TV Time) from
the evidence supplier (WatchForge). A small evidence/binding table is preferable
for a pilot to pretending an unverified WatchForge assertion is already a
trusted external alias. A later schema decision can add typed namespaces after
validation and a reviewed migration.

### 2. Lists/favorites have a separate, important gap

In [`import.processor.ts`](../apps/api/src/import/import.processor.ts), the
movie list-entry branch around line 1368:

1. Finds a name through `buildMovieUuidNameMap`.
2. Returns unresolved immediately if no name exists.
3. Calls `matchMedia` by title without the archive's resolved UUID binding or
   release-year evidence.

The list loop around line 1420 counts titleless entries as unresolved and skips
staging them. Favorites have a similar early return. Staged movie list/favorite
rows also omit `movieUuid` from their `normalizedData` around lines 1437 and 1498.

Consequences: adding WatchForge only to `matchByExternalIds` would miss this path.
A later scan of `UNMATCHED` import rows would also miss entries that were never
staged. Historical recovery may require reparsing a retained original archive;
without retained source evidence, an aggregate unresolved count cannot recreate
the missing UUID or activity. Retention availability must be measured.

Unify this path with movie identity resolution, retain UUID/year/source evidence,
and retain unresolved UUID-only entries as auditable pending records. Preserve
the current UI rule against displaying unreviewable blank-title noise.

### 3. Movie repair has a useful insertion point

[`resolveProviderDuplicateMovieTarget`](../apps/api/src/media-metadata/metadata-backfill.service.ts)
around line 1907 already distinguishes attaching a missing TMDB ID from merging
into a local TMDB movie. Add corroborated WatchForge evidence after the existing
exact provider bridges and before title/year fallback.

The `providerDuplicateMovies` health metric counts movies missing TMDB identity;
it is not a count of proven duplicates. A successful lookup might enrich the
existing row without merging anything.

[`MovieIdentityService`](../apps/api/src/media-metadata/movie-identity.service.ts)
also separates provider lookup from alias attachment and rechecks anchors inside
a serializable transaction. Preserve that distinction: an occupied alias is a
collision to investigate, not permission to steal it during an import.

### 4. Existing repairs must still be reviewed before expansion

The movie merge moves many user relations and checks character-vote compatibility,
but ultimately deletes the source media row. It is different from show
canonicalization's retained source/copy ledger. WatchForge does not make movie
merges automatically reversible.

A concrete policy issue to resolve before widening automatic repairs:
`mergeDuplicateMovieRows` around lines 2425–2436 lets a newer source rating replace
the target rating based on timestamp alone, including its `source` and `sourceKey`.
It does not protect a manual target rating from a newer imported source rating.
The import invariant in `IMPORT_PIPELINE.md` protects manual/local ratings.
Document and test an explicit merge collision policy; use manual/local precedence
for the proposed integration unless the product owner specifies otherwise.

### 5. Show structure is a separate proof problem

[`MediaCanonicalizationService`](../apps/api/src/media-metadata/media-canonicalization.service.ts)
distinguishes `EXACT_DUPLICATE` from `SEASON_COMPONENT`, compares complete regular
episode graphs, and verifies TVDB episode → TMDB component mappings before
activation. [`METADATA_OPERATIONS.md`](METADATA_OPERATIONS.md) defines the
authority/remapping safeguards and rollout gate.

Two local rows returning the same `wf_id` are candidates for investigation. They
are not sufficient proof to collapse an anthology, adaptation, alternate cut,
movie group, or separate season into one interchangeable media row. WatchForge's
alias arrays do not document those relationship semantics.

## A concrete database audit

First take a read-only inventory against an explicitly selected database or
snapshot. Use a read-only database role/transaction and bounded queries; do not
call hydration/upsert code from this audit merely because a helper has “resolve”
in its name. Existing import matching can persist data.

Report these categories separately:

| Category                | Inventory/evidence to collect                                                  | Decision                                                            |
| ----------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| Missing identity        | Visible movies lacking typed TMDB; shows missing counterpart IDs               | Enrich if proven; absence alone is not corruption                   |
| Conflicting identity    | Multiple same-kind aliases, wrong-kind aliases, contradictory provider anchors | Investigate aliases independently; retain unresolved evidence       |
| Duplicate candidate     | Several visible media rows connected by exact provider evidence or WFDB result | Prove equivalence before planning a merge                           |
| Unresolved import       | `UNMATCHED`, `NEEDS_REVIEW`, `PENDING_MATCH`, plus reason-coded `SKIPPED` rows | Separate identity failure, structure wait, and deliberate artifacts |
| Missing staged evidence | List unresolved counts and retained archive availability                       | Reparse where possible; do not fabricate missing entries            |
| Structure issue         | `LEGACY_UNMAPPED`, stale authority, incomplete graphs, blocked canonical links | Use structure audit/remap, not title ID lookup                      |
| Already canonicalized   | ACTIVE source links and their retained data                                    | Exclude from ordinary duplicate/health counts                       |
| User impact             | Distinct affected users and relations, by category                             | Prioritize watched history and meaningful user data                 |

Do not report a single “bad rows” total by summing overlapping categories. Count
distinct media, imports, activities, and users separately. A retained ACTIVE
source, a legitimate TVDB-only title, and a temporarily unavailable provider are
not broken data.

For each proposed action record: source/target internal IDs, typed provider IDs,
source archive identity where retained, WatchForge assertion, independent provider
evidence, lookup time/request ID, local input fingerprint, reason, affected
relation counts, and whether the action is enrichment, merge, conflict review,
structure repair, or no change. Keep personal archive contents out of reports
and external requests.

## Pilot and integration sequence

1. **Baseline audit.** Inventory the categories above and retain counts/examples.
   This does not require WatchForge access. Production counts have not yet been
   measured in this assessment.
2. **Small provider evaluation.** With an approved developer key, sample up to
   200 distinct identifiers, weighted toward UUID-only movies and TVDB-only
   movies, with conflict/dead-alias cases and known-good controls. Query only IDs
   already held. Reserve quota for live imports; additional alias consistency
   checks consume additional requests. Record coverage and independently reviewed
   precision by category, not just HTTP success rate.
3. **Backend client in report-only mode.** Validate responses, namespace/type,
   queried ID when present, scalar/array consistency, and all existing anchors.
   Cache/deduplicate by `(provider, kind, id)` across workers and enforce a shared
   daily/minute budget. Missing key leaves existing behavior usable. A 404 gets
   a bounded negative cache; 429 pauses until allowed; 401/403 suspends the client;
   transient 5xx/timeouts retry separately. No result should turn an outage into
   a permanent skipped import.
4. **Shared import resolution.** Route history, watchlist, favorites, lists,
   ratings, reactions, comments, and movie character-vote targets through the same
   UUID-aware helper. Resolve each distinct UUID once. Exact local/direct-provider
   evidence remains stronger than a contradictory WatchForge assertion. UUID-only
   results begin as review candidates; adopting them for automatic import matching
   requires measured accuracy and an explicit evidence policy. Merely fetching an
   existing TMDB title validates its existence, not the UUID→title relationship.
5. **Persistent evidence and replay.** Retain source UUIDs before dropping them.
   Store accepted bindings with provenance and contested assertions separately.
   Re-evaluate stale/conflicting bindings when evidence changes. Replay retained
   unresolved activities through normal source-idempotent apply; respect manual
   resolutions and do not blindly reapply already-applied records.
6. **Reviewed repair plans.** Feed corroborated movie identities into the existing
   attach/merge path and show candidates into canonicalization. Recheck anchors
   under locks at apply time, preserve user-data collision policy, capture recovery
   evidence, and verify relation outcomes. Approve production changes separately
   after reviewing exact actions and a recovery plan.
7. **Prevent recurrence.** Persist successful identity decisions, keep namespace
   validation at every write boundary, measure newly created duplicates and
   unresolved imports, and re-run a bounded evidence audit when mappings change.
   Upstream catalogs keep changing, so “fixed” means convergence and detection of
   regressions, not a promise that future ambiguity disappears.

## Acceptance criteria and remaining work

- Same numeric movie/series ID can never cross namespaces.
- UUID-only list/favorite resolution agrees with history/extras in the same import.
- Conflicting aliases and multiple plausible identities do not auto-merge.
- Provider failure/quota exhaustion cannot drop activity or overwrite a good match.
- Re-import/replay does not duplicate watches, comments, ratings, or memberships.
- Movie merges protect manual/local choices and preserve all affected relations.
- Show merges still require complete episode proof; specials and future episodes
  retain the repository's progress rules.
- Every claimed repair has a before/after result and retry/recovery evidence.

Focused validation should extend the existing archive-identity, import-processor
identity, movie-identity, provider-duplicate repair, and canonicalization tests,
plus client contract fixtures covering null/multiple aliases and error outcomes.
Run the API no-emit typecheck when implementation changes are made.

This study changed documentation only. No application tests, builds, exports,
migrations, authenticated provider requests, deployments, or database repairs
were run. Public docs/spec parsing and the public health check completed. The
code graph had stale source locations, so findings were verified against current
files. A future API integration requires focused validation and an API image
build by the product owner before release; any migration or production repair
requires its own approval under `AGENTS.md`.
