# CommsUni implementation audit — 2026-09-13

> Follow-up: the owner requested implementation of these corrections, excluding API-key rotation
> (finding 2). The owner confirmed originals are not present at CommsUni before the one-time backfill.
> Current implementation and public-image behavior are documented in [COMMSUNI_INTEGRATION.md](COMMSUNI_INTEGRATION.md),
> with the launch procedure in [COMMSUNI_BACKFILL.md](COMMSUNI_BACKFILL.md). Findings below are the original audit record.

The implementation covers much of both provider guides, but it is not ready for an unrestricted write/backfill rollout. I found two high-priority defects and seven additional correctness/recovery issues, plus avoidable duplication and request overhead. Passing existing tests does not establish correctness for these cases.

Scope: the current broadly modified working tree, including untracked implementation files. The contracts were docs/commsuni-api-integration.md and docs/commsuni-api-backfill.md. Implementation notes were treated as descriptions to verify, not replacements for those contracts. No production state or live provider response was inspected.

## Findings

### 1. P1 — Routine metadata updates permanently block queued deliveries

Evidence: apps/api/src/commsuni/commsuni.resolver.ts:60; apps/api/src/commsuni/commsuni.publication.service.ts:570; apps/api/src/media-metadata/media-metadata.service.ts:1653 and :4371.

The destination fingerprint includes episode.updatedAt. Fetching a missing translation or refreshing artwork/text changes that timestamp even when the TVDB identity, canonical episode, season, and episode number are unchanged. Dispatch compares the entire fingerprint and parks the operation in BLOCKED_MAPPING. The worker never selects that state again, and the approval endpoint only handles WAITING_REVIEW.

Trigger: enqueue an episode comment, backfill row, or vote; update only its translated title; dispatch. Delivery stops despite an unchanged destination. Browsing cursors and reviewed backfill proofs also become invalid unnecessarily.

Verification: a mock reproduction changed only updatedAt, retained the same reference/entity, and confirmed terminal BLOCKED_MAPPING with no provider request.

Correction: fingerprint evidence that can change the destination. Separate semantic identity/structure from metadata freshness, retaining guards against actual remaps and ambiguous identities.

### 2. P1 — API-key rotation loses effective blocks and strands delivery/cleanup

Evidence: apps/api/src/commsuni/commsuni.client.ts:68; apps/api/src/commsuni/commsuni.read.service.ts:244; apps/api/src/commsuni/commsuni.publication.service.ts:447; apps/api/src/social/conversations.controller.ts:399.

client.scope hashes the API key together with source and actor secret. That scope partitions persistent author blocks, local moderation reports, author identities, and worker admission. Replacing an expired/revoked key for the same partner changes scope even though actor(userId) is unchanged. Existing blocked authors and locally hidden reports cease to match reads. Old queued comments and account-deletion cleanup are never selected by the worker. Ownership presentation is also lost until a new identity row is established.

The notes explicitly describe credential changes parking old work. This control is overbroad: credential rotation is not necessarily a partner/actor change, and must not undo persistent blocking. The implementation already separates voteScope from the API key.

Verification: replacing only a fake API key changed scope, while the actor and voteScope remained identical. Static tracing confirmed the affected block and delivery queries.

Correction: separate credential/cache namespaces from durable partner identity. If replacement credentials cannot be verified automatically, provide an explicit reconciliation procedure preserving actors, operation IDs, blocks, and moderation decisions. Do not replay genuinely different partner identities.

### 3. P2 — A 60-second reading pause breaks pagination and can replace the feed with an error

Evidence: apps/api/src/social/conversations.service.ts:80 and :362; apps/mobile/components/comments/CommentsFeed.tsx:139; apps/mobile/api/commsuni.ts:94.

The backend stores its only continuation state with a 60-second TTL. Spending more than a minute on a page produces "Conversation cursor expired" on the next scroll. A React Query next-page error also sets isError; the main feed checks that before rendering its list. Already loaded comments are replaced by a generic error view, bypassing its footer recovery control. Retry resets pagination.

The provider's short cache recommendation concerns response freshness, not a one-minute maximum browsing session.

Verification: an expiring Redis mock served page one, advanced 61 seconds, and rejected the next page.

Correction: decouple cursor lifetime from response freshness. Preserve loaded pages and scroll position on continuation errors. Do not simply lengthen shared-content cache TTLs.

### 4. P2 — Imported copies can override healthy provider rows and split engagement

Evidence: apps/api/src/social/conversations.service.ts:174, :287, and :325; apps/api/src/social/comments.service.ts:896; apps/mobile/api/commsuni-presentation.ts:96.

Confirmed publications prefer the remote stream, but exact TV Time imports do not. When a local imported copy has more likes than its provider counterpart, it wins the merge and puts the provider UUID in seen. The real provider row is discarded. The displayed row uses local counters, local author presentation, and local interaction routes despite a healthy shared board. Imported rows have no commsUniState, so their likes stay local. Opening the copy also follows the local comment route without an automatic TV Time UUID redirect.

Trigger: an imported comment receives local likes before/during read-only integration and outranks the same archive UUID.

Verification: both copies were present; local likes 500 versus provider likes 10 produced one local row and no provider row while upstream remained available.

Correction: reconcile verified identical UUIDs to the provider DTO/actions when available, preserving provider ordering. Retain imported records for history/fallback without deleting or republishing them.

### 5. P2 — One terminal vote failure can disable shared counts for everyone indefinitely

Evidence: apps/api/src/commsuni/commsuni.voting.service.ts:183 and :273.

The uncertainty query includes every attempted SELECTION whose state is not SYNCED or DUPLICATE_REPORT. A definitive FAILED, canceled, or parked operation therefore continues to disable its whole engagement category. This applies to every viewer of the title and is not restricted to the active partner scope. Local totals replace shared totals even when the provider is healthy.

Trigger: an attempted star vote receives a deterministic validation failure. Subsequent viewers lose shared star totals, with no expiry or reconciliation path. Temporary uncertainty is reasonable; treating every terminal failure as permanent global uncertainty is not.

Verification: a row permitted by this query made a different viewer receive local total 1 despite provider total 100.

Correction: distinguish definite rejection from ambiguous transmission and partially completed selections. Scope and reconcile uncertainty precisely, with an operator path for outcomes that cannot safely be inferred.

### 6. P2 — Deleted provider parents hide surviving reply branches

Evidence: apps/api/src/commsuni/commsuni.read.service.ts:47, :333, and :404; packages/shared/src/commsuni.ts:23.

decodeComment returns null for every tombstone, regardless of replyCount. Lists omit it and single-comment reads reject it. Reply expansion first calls that same single-comment method, so surviving replies cannot be reached through the normal branch UI.

The provider explicitly requires a minimal placeholder when replies remain (commsuni-api-integration.md:1972). The shared DTO has no tombstone state.

Verification: a provider tombstone with three replies decoded to null.

Correction: retain a sanitized tombstone with traversal when children remain. Remove old text, media, and publishing/engagement actions; omit childless tombstones.

### 7. P2 — Temporary moderation failures become permanent manual-review work

Evidence: apps/api/src/commsuni/commsuni.moderation.ts:17; apps/api/src/commsuni/commsuni.publication.service.ts:771; apps/api/src/commsuni/commsuni.admin.controller.ts:139.

The moderation adapter converts every exception, including timeout/429/503, to false. Dispatch interprets that as WAITING_REVIEW, which the worker does not retry. A brief outage strands historical batches, GIFs, and finalized image comments until manual approval. The backfill script stops on this state.

Verification: a temporary moderation exception produced the same false result as flagged/unreviewed content; worker state handling confirms the manual-review transition.

Correction: distinguish approved, flagged/manual review, and temporarily unavailable. Retry unavailable moderation with bounded backoff and unchanged unpublished content. Missing configuration can still require manual approval; do not bypass moderation.

### 8. P2 — An identical reply retry fails after the first local save succeeds

Evidence: apps/api/src/social/comments.service.ts:228; apps/api/src/commsuni/commsuni.publication.service.ts:214.

Capture can derive and save commsUniParentId from a local imported/structural parent. The original request supplied only parentId. If the response is lost, replaying the same clientActionId compares the now-populated remote parent with the originally omitted field and throws "Action ID was reused". The user cannot recover the successful first result using the original retry identity.

Verification: replaying an unchanged local-parent DTO against the state capture produces was rejected.

Correction: compare an immutable normalized client-request fingerprint, or normalize derived parent references consistently on replay. Do not compare server-enriched state directly with raw optional input.

### 9. P2 — Shared action dialogs discard final delivery outcomes

Evidence: apps/mobile/components/comments/CommentActions.tsx:86; apps/mobile/api/commsuni.ts:23; apps/api/src/commsuni/commsuni.publication.service.ts:915.

The dialog reads only the enqueue response's state, discards operationId, immediately refreshes shared queries, and displays pending. It never consumes the eventual acknowledgement. Unlike the shared-like hook, report and author-spoiler actions cannot show completion, duplicate-report status, or terminal failure. An early refetch can return the old provider snapshot, leaving spoiler state unchanged until another browse/refresh.

The provider requires surfacing Report-Duplicate instead of implying a fresh report reached operators. Actor throttling also lacks clear user-specific presentation: feed catches collapse it to unavailable, and dialogs use generic failures/pending.

Verification: static end-to-end tracing; no native runtime test for this finding.

Correction: retain operation IDs, consume local operation status, distinguish queued/sent/duplicate/failed/throttled, and apply confirmed or optimistic state to the affected row. Local operation polling already exists and need not poll CommsUni.

## Controls, duplication, and efficiency

- Keep useful safeguards: explicit write/backfill switches, stable actors, import/provenance exclusion, verified destinations, permanent local-to-remote mappings, parent ordering, frozen POST payloads, pacing, and the 23-hour uncertainty cutoff. The provider ledger lasts 24 hours; unconditional replay risks duplicates.
- Narrow overbroad controls: metadata freshness in destination identity (1), credential identity applied to durable blocks (2), terminal failure treated as global uncertainty (5), and temporary moderation treated as manual review (7).
- Batch image grants: CommsUniClient.mediaGrants has no production caller. Each visible archive image instead uses per-comment verification plus a single-image GET. This route is supported, but the provider calls it wasteful for lists and recommends batches of at most 16. The GET-only rollout is documented; preserve that intent while separating read-capability gating from publication gating when enabling batches. Even write-enabled installations currently do not batch.
- Narrow invalidation: CommsUniClient.invalidate (:135) scans/deletes all read-cache entries for the partner after each delivered action, including unrelated threads and source catalogs. Use entity/thread-specific invalidation. Session buffers are separate and are not invalidated by this method, so broad cache eviction is not comprehensive freshness management either.
- Bound local feed work: ConversationsService.page (:136) loads every eligible local root/reply, sorts in JavaScript, and stores the complete candidate list plus growing seen in continuation state to serve 20 items. Prefer a bounded local keyset stream.
- Batch visibility checks: CommentsService.visibleSharedCopies (:451) repeats block lookups per row. Linked copies can repeat report lookups, resolution, and individual reads. ConversationsService has overlapping suppression logic. Compute viewer visibility once and batch local lookups.
- Consolidate vote mutation logic: ConversationsController.vote (:291) duplicates rating/reaction/character/device persistence and watched-state checks from media/show/tracking services. Keep necessary endpoints but share mutation/provenance/event/cache rules.
- Centralize operation states: repeated string arrays in publication, cleanup, voting, backfill, and mobile differ. Account-deletion cancellation omits BACKFILL_PAUSED; approval updates the outbox without updating Comment.commsUniState. A typed state model and transition helpers would prevent drift. These observations alone do not prove data loss.
- Reduce documentation duplication: docs/partner-api-backfill.md and docs/commsuni-api-backfill.md are byte-identical. Keep one authoritative copy and link the alias. Separate current implementation/operations guidance from repeated historical validation notes.

## Contract coverage and boundaries

| Area                       | Assessment                                                                                                                                                                                                                                                                 |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend credentials/actors | Server-built headers, constrained routes, manual redirects, stable actors implemented. Rotation has finding 2.                                                                                                                                                             |
| Historical selection       | MANUAL provenance, import audit/source-key exclusion, copy/ambiguity guards, cutoff, parent checks, preview proof, and permanent dedupe implemented. No evidence that preview/apply intentionally republishes imported parents.                                            |
| Timestamps/idempotency     | Original ISO timestamps, durable mappings, frozen retry payloads, finite provider-ledger handling implemented. Finding 8 affects the app-facing retry layer.                                                                                                               |
| Paging/reconciliation      | Provider stream order is retained within that stream; findings 3 and 4 affect the merged result.                                                                                                                                                                           |
| Replies/media              | Lazy expansion and reply media exist; tombstones fail in finding 6. inReplyToCommentId is decoded but has no production presentation consumer, so flattened replies lack actual-target attribution/jump behavior.                                                          |
| Local continuity           | New saved rows retained optimistically; local fallback paths exist. Own-source durable records are not refreshed from browse results; local lists can retain stale provider spoiler/counter state. This remains incomplete against the source-cache guidance.              |
| Moderation                 | Separate reports/spoilers/blocks and backend suspension guards exist. Final outcomes/throttling presentation and persistent key-rotation behavior need correction.                                                                                                         |
| Voting                     | Fixed star/emotion mapping, local intent capture, native-only subtraction, and receipts exist. Five-star polls are not conflated with independent 0–10 ratings. Finding 5 affects aggregate reliability.                                                                   |
| Branding/localization      | Shared attribution/source components exist. All 23 new English keys in changed comment/common/list/movie/settings namespaces exist in every other supported locale. Native appearance was not visually validated.                                                          |
| Optional surfaces          | Season conversations, search, language filters, broad source-filter UI, independent 0–10/comment-rating composition are not fully exposed. Their absence alone is not a regression. The documented owner choice to omit source controls/extra voting panels was respected. |

## Validation and data safety

- 543 API tests passed: 337 focused CommsUni/social/moderation tests and 206 metadata/media/social compatibility tests.
- 115 mobile tests passed: CommsUni presentation, comment actions/cards/media, media state/layout, and vote optimism.
- 9 backfill script tests passed: rtk proxy node --test apps/api/scripts/commsuni-backfill.spec.mjs.
- Total existing focused tests: 667 passed.
- Nine temporary audit reproductions passed assertions of the current problematic behavior. These demonstrate defects, not correct product behavior. The temporary test file was removed.
- API and mobile no-emit typechecks passed: rtk proxy pnpm --filter @tvwatch/api typecheck and the corresponding mobile command.
- Focused API/mobile ESLint checks passed without fixes.
- Locale validation completed with warnings: 273 JSON files valid; the checker reports older missing-key fallbacks. A separate comparison with HEAD found no missing translations for the 23 new English keys in the audited changed namespaces. Translation quality and older warnings are not certified.
- The first pnpm test invocation rejected Jest arguments and ran no tests. Corrected pnpm exec jest commands produced the results above. Jest reported the existing ts-jest isolatedModules deprecation warning.
- All four new migrations were reviewed. They add tables/columns/indexes; ordering and device provenance also update existing rows. No destructive schema operation was found. Device provenance copies recorded source and cannot reconstruct already-misclassified choices. No migrations were applied or PostgreSQL locking/concurrency tested.
- Not run: live provider calls, shared database reads/writes, actual backfill, full repository suites, native iOS/Android UI flows, builds, Expo export, publication, or deployment. Provider keys/scopes, host registration, quota, and production migration state were not verified.
- Application code was not changed. This report is the retained artifact. The existing implementation requires the owner's API image build and fresh Expo web export before the respective releases, after fixes and approved migration/release preparation.

Fix durable identity and destination fingerprinting first; then pagination/reconciliation, vote uncertainty, tombstone traversal, and recovery UX. Address request overhead and duplication alongside those focused fixes. Follow with approved native/provider validation before broad writes or historical backfill.
