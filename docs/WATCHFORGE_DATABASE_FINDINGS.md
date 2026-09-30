# WatchForge: live database findings and resolution design

Date: 2026-09-19. This supersedes the initial documentation-only assessment.

> Implementation scope now follows [the prioritized plan](WATCHFORGE_IMPLEMENTATION_PLAN.md).
> Completed TV Time imports are excluded from rematching, reparsing, and replay. Historical
> import counts below remain audit findings, not the implementation backlog.

## What was actually examined

The configured PostgreSQL database `tvwatch` was reached through localhost:5432.
This report does not infer its deployment role from that address. All audit SQL ran
inside transactions with `transaction_read_only=on`, a statement timeout, and no
application bootstrap. No database records, settings, jobs, or caches were changed.

Inventory: 280,137 media records; 371,106 external IDs; 2,495,850 episodes;
778 imports; 8,364,309 import items. The current Metadata Health calculation was
executed through isolated read methods with a write-denying client. Evidence is
saved in [the local audit directory](../output/watchforge-audit/metadata-health.json).

Using the supplied developer key, 428 fixed catalog lookups were completed:
294 returned a record, 134 returned 404. These were targeted diagnostic requests,
including deliberately testing the other namespace on structurally contaminated
records; the overall success fraction is **not** an estimate of catalog coverage.
Two additional /me requests checked access/quota. No user IDs, viewing history,
comments, archive contents, or internal database IDs were sent to WatchForge.
The key was entered through hidden terminal input and was not saved in the repo.

WatchForge's contract and access rules:
[documentation](https://api.watchforge.app/docs),
[OpenAPI](https://api.watchforge.app/developers/openapi.json).
The key reports 60 requests/minute and 1,000/day. No further provider calls are
scheduled or running as part of this audit.

## Main diagnosis

The major problem is **known identities split across local records**, combined
with historical cross-namespace contamination and repair paths that cannot
resolve those situations.

WatchForge is valuable across those problems. It gives a common identity against
which we can compare every alias, discover counterpart records, and partition
incorrectly combined records. It also supplies UUID mappings for imports.

However, in the 32 show mappings independently checked against live providers,
31 were already corroborated by TMDB's external IDs and a live TVDB record.
The local repair pipeline is failing to converge even when providers agree.
Simply adding another lookup before the existing null return would leave most
of these cases broken.

### The precise dead end in anime repair

In [metadata-backfill.service.ts](../apps/api/src/media-metadata/metadata-backfill.service.ts),
`resolveAnimeTvdbId` obtains the correct TVDB identity, then calls
`claimTvdbId`. If that ID belongs to a different local media row, the claim
returns false and resolution returns null. The caller can then classify/park
the title as lacking a resolvable TVDB ID.

A known identity owned by another local row needs a canonicalization plan.
It must not become "provider identity unavailable."

The matching canonicalization path has another gap:
[media-canonicalization.service.ts](../apps/api/src/media-metadata/media-canonicalization.service.ts)
scans GENERAL, TVDB-owned shows with at least two active regular seasons.
`evaluateTvdbAggregate` also rejects fewer than two regular seasons. That is
appropriate for discovering multi-season component families, but leaves ordinary
single-season duplicates outside the path. Anime is excluded from the scan too.

There are currently **zero canonical-link ledger records** in this database.
That is an observed database state, not proof of which jobs have or have not
previously run elsewhere.

## Actual Metadata Health findings

These counts overlap. They cannot be summed into a count of broken titles.
Some counters measure backlog or incomplete catalog stubs, not corruption.

| Area                                             |                                          Observed | How WatchForge fits the resolution                                                                         |
| ------------------------------------------------ | ------------------------------------------------: | ---------------------------------------------------------------------------------------------------------- |
| TVDB-only media                                  |               34,947: 32,880 shows + 2,067 movies | Resolve counterpart IDs, find occupied aliases, and identify existing canonical families                   |
| TVDB fallback shows                              |                                            22,096 | Re-evaluate after identity resolution; retain TVDB ownership when structure requires it                    |
| ANIME-classified shows without TVDB identity     |                                               311 | Directly relevant; tested results expose local duplicate ownership                                         |
| Recently parked anime identity failures          |                                                77 | Revisit with distinct absent/occupied/conflicting outcomes                                                 |
| Actionable movies missing TMDB                   |                                               671 | Additional bridge before title fallback; distinguish attach from merge                                     |
| Multiple TVDB alias groups                       |           130: 31 actionable, 26 marked ambiguous | Resolve every alias and partition agreeing/contradictory identities                                        |
| Multiple IMDb alias groups                       |                         178: 173 movie + 5 series | Important additional audit surface not represented by the TVDB-only conflict counter                       |
| Multiple TMDB alias groups                       |                            10: 7 movie + 3 series | Multiple canonical anchors on one row require explicit conflict evaluation                                 |
| Structurally wrong-type media                    |                                               104 | Recover the embedded show's identity and plan a data-preserving split                                      |
| Wrong-kind external aliases                      |                                    58 on 34 media | Validate namespace before attachment/repair; distinguish from aliases already mislabeled as the row's kind |
| Active structural conflicts                      |                                               140 | Identity evidence selects the family; Structure Remap must still prove episode targets                     |
| Legacy-unmapped episodes                         |    10,720 across 285 shows; 7,487 carry user data | Resolve parent families, then exact episode mapping and protected-data transfer                            |
| Missing authority                                |                                            35,436 | Re-evaluate after validated identity/graph availability                                                    |
| Outdated authority rules                         |                                           110,885 | Rule-version backlog; not 110,885 provider disagreements                                                   |
| "Invalid authority"                              |       258, all false positives from one predicate | Local code corrected; read-only validation changes this count to zero                                      |
| Pending character votes                          |           34 items on 2 shows; neither lacks TVDB | These are role/cast replay issues, not missing parent identities                                           |
| Duplicate cast candidates                        | 980 media; exact duplicate-row/vote counters zero | Parent identity may help enrichment, but WatchForge exposes no character-role crosswalk                    |
| Missing episodes / never hydrated / stale        |                         73,401 / 210,755 / 67,607 | Correct identities first, then existing owner-specific hydration; these include incomplete stubs           |
| Missing movie overview                           |                                             2,029 | Correct identity can enable canonical hydration; ordinary content gaps remain hydration work               |
| Non-English base / content suspects              |                                     5,713 / 8,041 | Resolve identity contamination before the existing English-content repair                                  |
| Bad banner/poster mapping                        |                                               210 | Existing artwork repair after identity is correct                                                          |
| Missing rating / recommendations / movie country |                              1 / 0 / 0 actionable | Use existing supplement/backfill paths; raw missing fields and actionable counts differ                    |
| Movie data on shows                              |                                                 0 | No current findings in this particular counter                                                             |

The health calculation's `authorityInvalid` SQL omitted `GENERAL_TVDB` from
the allowed TVDB reasons. All 258 records used that valid reason. The source
predicate now includes it. This is a local fix, not a deployed change.

## Measured WatchForge results

The initial catalog cohorts were ranked by existing usage/popularity, not randomly
sampled. Subsequent requests targeted unresolved imports and corrupted namespaces.

| Tested cohort                            | Result                                                                                                                 |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 25 anime missing TVDB                    | 23 catalog hits; 21 returned TVDB links; 20 links were already owned by another local row                              |
| 30 TVDB-only shows                       | 21 returned TMDB links; 20 linked to another local row                                                                 |
| 10 other shows missing TVDB              | 8 returned TVDB links; 7 linked to another local row                                                                   |
| 25 TVDB-only movies                      | 3 returned TMDB links; 2 linked to another local row                                                                   |
| 25 multi-alias media                     | 5 had aliases resolving to different WatchForge identities                                                             |
| 35 unresolved TV Time movie UUIDs        | 20 resolved; those UUIDs occur in at least 596 retained unresolved rows in the extracted groups                        |
| 20 cross-type corrupted movie records    | Every record yielded show identity candidates; 19 yielded one show identity, one yielded two                           |
| Across all tested mappings               | 69 families span multiple local owners: 60 show families and 9 movie families                                          |
| Local graph comparison of those families | 14 show families have identical stored active regular episode graphs; 21 show families consist of single-season owners |

"Identical stored graph" means same regular S/E, normalized episode title, and UTC
air date across the compared local owners, with nonempty graphs and dated episodes.
It is not yet a current upstream-completeness check or a user-data collision preview.
The repair manifest marks these as preview-required, never automatically safe to apply.

### Concrete examples with user impact

| Records connected by WatchForge           | Evidence / impact                                                                                                                                                                  |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tengoku Daimakyo / Heavenly Delusion      | TMDB 208891, TVDB 426165, WFDB 12076; independently corroborated; identical one-season local regular graphs; 272 history rows and 38 unresolved import items across the two owners |
| Pretty Little Liars / Pretty Little Liars | TMDB 31917, TVDB 146711; independently corroborated; 5,270 history rows and 2,014 unresolved items; stored regular graphs differ, so remapping is required                         |
| Magi / Magi: The Labyrinth of Magic       | TMDB 60654, TVDB 262094; independently corroborated; 750 history rows; local graph differences need reconciliation                                                                 |
| One Day / One Day (2024)                  | TMDB 240667, TVDB 421649; identical single-season regular graphs; 286 history rows, 14 unresolved items                                                                            |
| Pine Gap / Pine Gap                       | TMDB 82469, TVDB 352547; identical single-season regular graphs; 24 history rows, 9 unresolved items                                                                               |
| Never Have I Ever / Never Have I Ever     | TMDB 100883, TVDB 378746; identical stored regular graphs; 1,166 history rows, 524 unresolved items                                                                                |

Counts describe rows attached to the candidate records, not distinct people,
unique viewing events, or a guaranteed number of recoverable activities.

### Cross-type corruption is real, with watched data attached

| Movie row            | Show identity recovered by WatchForge |                        Embedded show structure |
| -------------------- | ------------------------------------- | ---------------------------------------------: |
| The Dark Knight      | 3rd Rock from the Sun                 | 6 regular seasons; 139 watched episode records |
| Schindler's List     | Torchwood                             |  4 regular seasons; 41 watched episode records |
| Howl's Moving Castle | Roar                                  |    1 regular season; 8 watched episode records |
| Spider-Man           | Camp Lazlo                            |  5 regular seasons; 61 watched episode records |
| Perfect Blue         | Nowhere Man                           |   1 regular season; 25 watched episode records |
| The Departed         | The Middle                            | 9 regular seasons; 215 watched episode records |

Example: TMDB movie 155 is The Dark Knight; TMDB TV 155 is 3rd Rock from the Sun.
WatchForge's explicitly typed TV lookup returned IMDb tt0115082 / TVDB 72389,
consistent with the misplaced show metadata on our movie row. Equivalent
namespace collisions explain the other examples.

Several legacy aliases have already been labeled MOVIE even though they belong
to the embedded show. The existing type-mismatch repair primarily looks for a
SERIES-kind alias on a MOVIE row. It cannot recover the show from a wrongly
labeled alias and therefore refuses to delete protected structure. WatchForge
can supply the missing partitioning evidence. The repair must verify episode
ownership before moving anything; it must not just remove the stray `shows` row.

The earlier assessment's mention of a 1997 year on Howl's Moving Castle referred
to its attached stray show metadata. Its actual movie release-year field is 2004.

### One row can contain several unrelated identities

The multi-alias tests found:

- Full Metal Jacket also carries Andante's movie identity. Cross-type queries
  additionally returned two show identities, so this needs a multi-entity split.
- ISLAND combines the 2018 anime (TMDB 80535) and the 2022 Korean series
  (TMDB 211747); a separate local Korean-series row also exists.
- Signs carries a TVDB alias resolving to Hum Aapke Dil Mein Rehte Hain.
- Willy Wonka & the Chocolate Factory also carries Girlfriends of Christmas Past.
- CIA carries two WatchForge title identities that require provider-level review.

These are incompatible-identity candidates, not a list to bulk-merge.

### A live disagreement that must remain unresolved

WatchForge returned TVDB 436780 for TMDB 246862, New PANTY & STOCKING with
GARTERBELT. Live TMDB currently returned no TVDB ID, and TVDB 436780 returned 404.
The lookup was a valid WatchForge 200 response. This is why returned mappings need
freshness/provenance and why a successful lookup cannot be permission to mutate.

Of 32 selected show pairs checked against both providers, 31 agreed and were live.
That sample does not establish a global precision percentage.

## Imports: identity repair must be followed by replay

Completed TV Time imports retain 211,546 NEEDS_REVIEW and 50,540 UNMATCHED
WATCHED_EPISODE rows. Those include historical/repeated imports and are not
262,086 distinct missing watches.

The largest grouped backlog includes One Piece (34,438 review rows), Naruto
Shippuden (9,677), Detective Conan (5,495), and Bleach (4,746). Much of it already
has a matched local media ID; old staging often retains the TVDB episode identity
only in raw source fields. A new catalog alias alone does not apply this backlog.

The new audit reads only the needed catalog identifiers from those fields.
For example, one One Piece group contains TVDB series 81797 and 14,525 rows with
a retained numeric episode ID. Replay must use the existing exact-episode
verification and source-idempotency rules, not blindly accept the stored S/E.

UUID successes include Thunderbolts*, Dune, The Intouchables, Spirited Away,
and The Platform under different exported titles. Lists/favorites still need the
shared UUID resolver and preservation changes identified in the first assessment.
There are also 4,893 blank-title list review rows in completed imports; recover
their source only when it was retained. No invented title/UUID can repair lost
source evidence.

## The resolution to implement

1. **One identity resolver shared across import, hydration, and repair.**
   Return distinct outcomes: resolved on this row, resolved on another row,
   conflicting identities, absent from provider, and temporarily unavailable.
   Add WatchForge to candidate discovery and corroboration. A known occupied
   alias produces a family plan rather than a null/park stamp.

2. **General duplicate canonicalization alongside aggregate/component detection.**
   Accept explicit verified identity families, including anime and single-season
   shows. Reuse the transaction/copy ledger, regular-episode proof, protected
   specials, canonical redirects, and cache invalidation. A provider owner is
   selected after identity is established; ownership does not determine whether
   two records are the same title. Retain manual authority overrides.

3. **A split planner for poisoned records.**
   Resolve every typed alias; investigate the other namespace only when existing
   structural evidence shows contamination. Partition by corroborated title
   identity, then map each episode and user relation to its proven owner.
   Ambiguous relations remain protected. Do not convert every conflicting alias
   into a second duplicate, steal occupied aliases, or delete watched structure.

4. **Permanent evidence plus source-preserving import replay.**
   Persist resolver provenance and accepted UUID bindings. Keep manual decisions.
   Recover old source identifiers where available, rematch unresolved rows after
   canonical activation, and apply through the existing idempotent section paths.
   Do not replay all APPLIED rows or cancelled imports indiscriminately.

5. **Health selectors that describe the actionable state.**
   Separate alias ownership collisions from provider absence; audit IMDb and TMDB
   contradictions as well as TVDB; show protected split/remap blockers explicitly.
   The GENERAL_TVDB false-positive correction is already made locally.

6. **A controlled repair sequence.**
   First resolve/partition identities, then hydrate the chosen owners, prove
   episode maps, copy/split user relations, activate redirects, replay imports,
   and recompute progress/statistics. Run content/artwork/cast cleanup after
   identity convergence. Recheck inputs under locks before each applied plan.

A single universal "WatchForge wins" rule would recreate the same corruption.
The useful permanent change is to make identity evidence unlock the correct
repair path, and stop treating a local alias collision as provider failure.

## Deliverables and verification

[repair-candidates.json](../output/watchforge-audit/repair-candidates.json) contains
the 69 local identity families, exact local/provider IDs, stored graph comparisons,
impact counts, independently verified evidence where available, 20 cross-type
examples, and multi-alias conflicts. Every plan remains preview-required.

Additional local evidence:
[health metrics](../output/watchforge-audit/metadata-health.json),
[428 lookup responses](../output/watchforge-audit/lookups.ndjson),
[upstream verification](../output/watchforge-audit/provider-verification.json),
[full identity census](../output/watchforge-audit/identity-census.json).
The output directory is ignored by Git; these local audit artifacts are not
being added as production data to the repository.

Completed validation:

- All database reads enforced READ ONLY transactions.
- WatchForge: 428 catalog GETs plus two access/quota GETs.
- Upstream verification: 32 TMDB show reads, 32 TVDB show reads, one TVDB login.
- Corrected authority predicate: old count 258; corrected count 0 on the same DB.
- API no-emit typecheck passed.
- Focused MetadataBackfillService tests: 9 passed, 88 intentionally skipped.
- No builds, exports, deployments, migration applications, or database repairs.

The API image must be rebuilt by the product owner before releasing the local
health-counter fix. The broader resolver/split/canonicalization changes above
are designed but not implemented by this audit. Applying database repair plans
requires completing their per-relation previews and explicit approval under
AGENTS.md; this report does not authorize a blanket merge or delete.
