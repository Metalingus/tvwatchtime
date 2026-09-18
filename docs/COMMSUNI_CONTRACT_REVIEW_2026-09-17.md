# CommsUni old-to-v2 contract review — 2026-09-17

## Exact comparison baseline

Compared [the old guide](commsuni-api-integration.md) directly with
[the v2 guide](commsuni-api-integrationv2.md):

`git diff --no-index -- docs/commsuni-api-integration.md docs/commsuni-api-integrationv2.md`

Exit code 1 is expected because the files differ. The old file remains Git-ignored,
but both supplied versions are now available, so the comparison is exact.

SHA-256:
- Old: `C8FDF06CC0667BC926716EEA0A34BF74382DA0ACDFB05EC41DBF0E230732C34C`.
- V2: `E1FCD34BEE1D1487B2E4055E01A42E87029BB714585727FEF737EC870C46D82E`.

This replaces the earlier implementation-only comparison. Language filters,
histograms, search, native-author feeds, all-entity engagement, and independent
0–10 ratings **already existed in the old guide**. They are opportunities, not
v2 additions. No live provider calls were made; documented changes do not establish
that every server-side rollout is complete.

## Confirmed changes and app impact

### TVDB character-role voting

The largest technical addition is the new `character:tvdb-<TVDB v4 character ID>`
contract. Old documentation described `actor:<actor_id>` or label fallback.

V2 specifies:
- First votes create options after TVDB verifies an Actor/Guest Star role belongs
  to the title or exact episode. Later votes on existing keys still work.
- Cast menus come from our catalog, not `castVotes[]`, which lists voted options
  including zero-count rows. An unlisted role starts at zero.
- New rows supply `provider`, `characterId`, and `peopleId`, with nullable
  actorId/name/imageUrl and empty role. We supply names/artwork from our catalog.
- Legacy and new role counts must stay separate; saved votes must not be migrated.
- New-key enforcement is rolling out. New options have a separate per-key/minute
  quota; invalid keys/membership return 400/422, TVDB outages 503. Honor Retry-After
  for 429/503.

**Benefit:** exact role IDs replace fragile performer-name/artwork matching. Our
stored role IDs support returned options without new metadata calls or migrations.

**Implemented in the preceding work:** exact returned-key matching to one
MediaCast.characterExternalId on verified media, stored display metadata, separate
legacy counts, and suppression of unresolved raw IDs in the cast UI. Original
provider keys/viewer state remain intact; no saved vote is migrated.

**Remaining:** first-option publication and a complete cast menu, including exact
episode guest stars. The dispatcher still requires a returned cast option.
This is the highest-value follow-up, not a completed feature.

### Live versus historical counts

Old conversation totals described frozen baselines; reply-list total could mean
historical upstream replies and, under filters, only the current page. V2 changes:
- Conversation comments.total/replies.total: currently visible rows.
- New conversation allTime: historical/tombstone-inclusive counts.
- Comment replyCount: live replies; new replyCountAllTime: historical.
- Reply-list count: active rows on the page; total: active replies for the thread
  and current filters; new allTimeTotal: historical/debug count.
- Fetch replies using live replyCount, not archived replyStatus/fetchedReplyCount.
  Missing archive capture does not mean a thread has no native replies.

Its example changes from 3 of 12 replies, incomplete, to 3 live replies, complete,
with 12 retained as allTimeTotal. This prevents misleading badges and “missing
replies” states. Our decoders already use comments.total/replyCount; keep those.
The conversation count endpoint itself is **not new**.

### Write-response and validation clarifications

- Successful 202/204 writes explicitly have no body. Reports already used status
  202 in the old table, but its global JSON-envelope claim was misleading.
  The preceding transport fix accepts empty acknowledgments while retaining
  duplicate/replay headers. Empty 200 reads still fail envelope validation.
- Idempotency explicitly binds comment/reply/report route targets and bodies.
  Existing queued path/body/key preservation remains compatible.
- Profile PUT's malformed table is repaired: displayName and nullable avatarUrl
  are supplied; both plus authorId are returned. Names have explicit 1–64 and
  control-character constraints.
- New likes/spoiler marks/reports require visible, non-tombstoned comments.
  Native mine_hide/mine_claim requests explicitly return invalid_reason.
- Entity ratings must be JSON numbers. A mistaken POST rating reference becomes
  PUT; this does not introduce a new rating endpoint.
- Option keys are nonblank, 1–255 characters, without controls; conflicting
  optionKey/key aliases are invalid. Report detail excludes control characters.
- Error documentation expands to source_disabled, invalid_content_length,
  body_aborted, invalid_created_at, invalid_option_key, write_conflict,
  idempotency_unavailable, and tvdb_unavailable. JSON-body timeout/size/content-type
  rules are generalized.
- Emotion guidance warns against merging arbitrary emojis with the archive's fixed
  12-option catalog. It adds no new emotion endpoint.

### Sharing and identity guidance

Old §9 treated first-write identity opt-in as a possible pattern and historical
backfill as a scripted/backend decision. V2:
- Explicitly makes app-only posting optional for the partner. If offered, it must
  be a disclosed user choice.
- Separates public sharing with app profile, public sharing with generated persona,
  and optional app-only posting. A persona does not make the text private.
- Says the first CommsUni prompt **must** offer app identity versus generated
  persona, separately from consent to publish comments.
- Requires a settings choice later. PUT updates the public profile overlay;
  DELETE returns to a generated persona without deleting comments.
- Allows disclosed sharing consent to cover future and existing originals, and
  delegates consent/eligibility/dependencies to the backfill guide.

**Conflict with repository product intent:** COMMSUNI_REVIEW.md records the owner's
explicit choice to retain app identities without another prompt. The current
rollout follows that decision. This review preserves that behavior and does not
claim it satisfies v2's new guidance; reconcile the product decision and provider
expectation for rollout.

The supplied commsuni-api-backfill.md still describes the older scripted
original-comments-only process, not the consent-oriented procedure v2 references.
No updated backfill guide was supplied. Do not infer permission to republish TV Time
imports or treat a generated persona as consent.

### Smaller changes

Source filters preferably use catalog names/icons/colors. Attribution suggests
“Support CommsUni.tv” as link text. Failed unsynced drafts are distinguished from
immutable posted text. The checklist is reorganized and broken code fences removed;
many checklist additions restate existing sections.

## Already supported by the old contract

| Existing capability | Possible app improvement |
| --- | --- |
| Language filters and histograms | Language picker; include filters in cursors/cache keys and decide local/unknown-language behavior. |
| Engagement on all entity types | Show/season polls and platform/interest controls; empty archived show/season polls remain normal. |
| Entity-scoped search, native-author feeds | Explicit search/activity surfaces; search remains top-level, maximum 50, without pagination. |
| Separate 0–10 ratings and comment rating snapshots | Optional numeric-rating surfaces; do not multiply our five-star poll by two. |
| Conversation counts, visible-image grants, timestamps, queued idempotent writes | Already used; v2 does not add these endpoints. |

Shared text editing, direct TMDB references, cross-app notifications, moderation
webhooks, shared blocks/bans, bulk deletion, automatic archive ownership transfer,
and cross-title/reply-inclusive search remain unavailable.

## Documentation inconsistencies

- The existing conversation count endpoint is still contradicted by “no count-only
  endpoint.” Preserve the explicit documented route.
- Native mine_* rejection now conflicts with the unchanged gaps section claiming
  it is not enforced. Our TV-Time-only validation works in either rollout state.
- Tombstone paragraphs disagree about placeholders; preserve sanitized structural
  parents only while surviving replies need them.
- Search cost remains three units in its route section versus one in the summary.
- media_not_found now says respect no-store, while dedicated media/cache guidance
  retains hours-long negative caching. Existing bounded caching is unchanged pending
  clarification; grant statuses and HTTP errors are not interchangeable contracts.
- Stable-fields prose still calls archived reply counters frozen despite the new
  live/historical distinction.

## Validation and release

This exact-diff follow-up changes documentation only. The preceding code fixes
remain consistent with v2; no additional runtime change was needed for this review.

Previously completed for those fixes:
- API no-emit source typecheck: pnpm --filter @tvwatch/api typecheck:source.
- Six focused Jest suites: 203 passing tests, mocked HTTP/persistence.
- Focused ESLint for seven changed API source/test files.

Tests were not rerun for documentation-only corrections. No live API tests,
migrations, database writes, builds, exports, or deployment. An API image rebuild
remains required for the preceding fixes; no new Expo web export is required.