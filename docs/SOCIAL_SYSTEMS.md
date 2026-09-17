# Social Systems — Comments, External Reviews, Spoilers, Voting, Account Deletion

Deep operational reference for the social domain. Relocated from `AGENTS.md`.
Summaries: `docs/DATA_MODEL.md` (voting), `docs/DOCUMENTATION.md` §13 (Comments & Images) and §21 (Data Export & Deletion).
Read this file BEFORE touching `apps/api/src/social/**`, `apps/api/src/users/**` deletion paths, `apps/mobile/components/voting/**`, or comment/review UI.

## Non-negotiable invariants

- Never delete a user row directly; use the anonymize-and-delete helper so comments and counters remain consistent.
- Character votes are keyed by `media_cast.id`/`cast_id`, never by character name.
- Voting percentages come from real aggregates and remain hidden until the user has voted in that category.
- Replies to comments or external reviews stay out of the top-level feed.
- Preserve localization, spoiler shielding, and profile-navigation restrictions for deleted users.

## Automated comment moderation

The owner's policy is to moderate newly submitted content inside the app, including changed
comment text, and trust stored content during CommsUni delivery and historical backfill.

- New comments/replies: check nonempty text before inserting the comment and sending notifications.
- Edited local comments: check the text only when it changes, before saving or detaching an image.
- New image uploads: after format/decoding/dimension checks, the worker checks the comment text plus
  uploaded image bytes before processing/encrypting the file and marking it ready.
- GIF selection/replacement: validate the public HTTPS URL; text follows the normal text checks.
  The picker still uses Giphy, but storing/rendering GIFs is not restricted to that provider.
- Imports, existing provider content, CommsUni publication, backfill preview/enqueue/delivery and
  delivery retries do not invoke AI moderation.
- User reports and administrator moderation decisions remain separate flows.

Local text and upload checks share ContentModerationService and the existing OPENAI_API_KEY/model.
Automatic rejection is limited to sexual content (sexual >= 0.5; sexual/minors >= 0.01),
clear insults/abuse (harassment >= 0.9; hate >= 0.8), and threatening abuse
(harassment/threatening or hate/threatening >= 0.5). A matching provider category flag and
overall flag are also required. Violence, self-harm and illicit-content categories alone no
longer reject a submission: these can describe fictional scenes. Moderate harassment scores
such as 0.7 no longer reject character criticism like "Doug is a horrible friend and husband".
This is a score-based policy, not contextual character recognition; a high-scoring false positive
is still possible. The example's actual live provider score has not been verified.
Full text is checked. Rejections return COMMENT_MODERATION_REJECTED;
text-check outages return COMMENT_MODERATION_UNAVAILABLE and preserve the draft. With no key,
these local checks are skipped under the existing capability policy. Missing moderation
configuration no longer blocks publication of already stored comments.

The outbound moderation adapter, its second flagged-content gate and approval receipts are removed.
When writes are enabled, legacy WAITING_REVIEW operations with moderation_required and no prior
transmission can resume automatically; backfill, identity, attachment and visibility rules still
apply. Other manual holds and publication failures are not automatically approved.

The upload worker currently catches moderation errors, marks the upload failed and deletes its
temporary bytes, so its configured BullMQ attempts do not automatically retry that failure.
Tests use injected fake transports and never call the live moderation model.

## Old-client compatibility and local revisions

X-TVWatch-CommsUni: 1 opts the new client into the shared protocol. Missing/unknown headers
retain the native local APIs, including old comment-then-image creation, likes/spoiler flags,
votes, profile/comment reads and editing. Ownership and local content moderation still apply.
The explicit ADMIN backfill is independent of this client capability.

An owner edit from any app version to captured/shared or imported content sets hasLocalRevision and changes the
local copy only. Existing ids, replies and counts remain; the provider's immutable snapshot
is not edited or delete/reposted. The merged feed replaces the shared copy with the local
revision at the same identity, avoiding duplicates. Shared deep links also expose the revision;
new clients label it and allow further local edits. Native mutations invalidate both native and
shared-thread revision caches. Feed rows and verified revisions share one database/metadata batch. Newly posted shared replies also retain a local parent reference
when one is available, so older apps can read the existing reply tree.

A create-request hash preserves idempotent POST retries even if a legacy client has since
edited that comment. Local-only revisions and replies to those revisions are not newly
published. Deleted local comments still schedule deletion of their shared originals.

Captured attachment rows set retainedCommentId. Detaching a retained image clears only its
current commentId; the retained relation keeps its public URL and bytes valid for the shared
original. New uploads use separate image ids. Processing attempts use separate encrypted
object keys and update by image id, so stale workers cannot overwrite a replacement or a
published image. Imported image processing does not overwrite an explicit local revision.
Account deletion/anonymization moves retained-image ownership together with the comment.

Edited imports and structural copies remain separate local items. User-supplied archive UUIDs
cannot replace somebody else's shared comment; only a verified publication binding from our own
source permits the merged feed to substitute the local revision for the shared original.

## Rich cards and GIF attachments

Show/movie and list cards retain their local identifiers and clickable presentation in the merged
comments feed. CommsUni has no matching rich-card payload fields, so card comments remain local
(including their text) and are excluded from publication/backfill. They are not stripped or
converted into invented provider attachments. Replies to an unpublished local parent stay local.

Public HTTPS GIF URLs from any provider are accepted locally and exempt from COMMSUNI_MEDIA_HOSTS.
Non-GIF attachments still use that configured host list. CommsUni independently enforces its
per-source attachment-host policy; removing our duplicate GIF allowlist does not register a host
with the provider. Credentials, non-HTTPS URLs and local-address GIF URLs remain invalid.

## Shared comments (CommsUni)

Before CommsUni work, read the relevant sections of the
[provider API guide](commsuni-api-integration.md), especially
[Entity engagement fields](commsuni-api-integration.md#entity-engagement-fields) for voting and
[§8 caching](commsuni-api-integration.md#8-caching-and-request-hygiene) for local storage.
[Current TVWatch support](COMMSUNI_INTEGRATION.md#current-engagement-support-2026-09-12) records
implementation gaps separately. Provider support for a feature does not mean we have connected it;
our missing mappings do not mean the API lacks the feature.

See [COMMSUNI_INTEGRATION.md](COMMSUNI_INTEGRATION.md). Provider reads are optional; writes are implemented but disabled by default at the service, worker, and HTTP transport. Imported/restored/cloned comments never enqueue publication. New remote replies use a separate parent reference and stay out of top-level activity feeds. All deletion entry points reserve gated provider cleanup inside the existing local anonymization transaction. Provider personas never become local user accounts. The comments header has no source filters, separate voting panel, or block-list shortcut. Source icons overlay the avatar's top-right corner; missing/failed avatars use a profile silhouette, and media keeps its natural aspect ratio. Viewability starts media loading once; scrolling out of view does not remove a valid image's frame. Transient image/grant failures and timeouts recover automatically with at most two delayed retries, keeping the loading frame stable. Archive retries request a fresh link and replace the renderer; external images also retry automatically. Definitive missing media, terminal access failures, or exhausted retries use the compact localized unavailable/retry row. Loaded dimensions are remembered in a bounded memory-only layout cache so recycled rows keep their height. Signed links stay only in the mounted attempt, outside shared query storage; cached image bytes retain their scoped key. Discarded grant requests are aborted, and provider Retry-After delays are respected. The composer explains local-only visibility only while a draft exists. Personal blocked users (local plus provider) are managed in Settings.

## Detail comment counts and watched dates

Show, episode and movie detail responses return local comment counts and local voting sections
without calling CommsUni. They advertise `communityDetailsDeferred: true`. After local detail is
ready, the app independently requests `GET /conversations/counts` and
`GET /shows/:id/interactions`, `/movies/:id/interactions`, or `/episodes/:id/interactions`.
Each result updates the existing screen as it arrives; provider delays/failures never contribute
to the main detail's loading/error state. Counts use CommsUni's entity `/conversation` totals,
with no provider comment-page download. The count includes top-level provider comments plus eligible
local roots; replies, external-review replies, deleted and locally hidden roots are excluded
from the local addition. Confirmed provider-linked local rows and their explicitly linked
structural copies are not added twice. Unmatched imports or unacknowledged deliveries can overlap
the provider total, so `commentsCountApproximate` marks their sum with ≈. These are community
totals, not a count of rows remaining after the viewer's personal author blocks. Provider
failure/disabled/unmapped cases retain the local top-level count. Main show counts use the SHOW
conversation, not an aggregate of episode or season conversations. Show/movie detail responses
always include the local fallback, even when the optional provider service is absent; older cached
responses without a count display a dash until refreshed.

Community queries follow the detail's invalidation scope, without following the 500 ms local
artwork/gallery polling. Pull-to-refresh starts community refreshes without awaiting them.
Local metadata refreshes retain already displayed shared aggregates when the viewer selection
has not changed. Late responses cannot replace a newer optimistic vote or repopulate a removed
detail/account/backend cache. A successful shared count replaces a local count even when the
local detail refresh changed that count while the shared request was in flight; comparing those
two local snapshots must not suppress a valid shared response. A count fallback leaves an
already displayed shared count intact.
No additional environment variables or data migration are needed for this loading behavior.

Movie watched buttons show the compact, localized `watchedAt` date and time beneath the main title
in the micro text size: "on [date] at [time]", without repeating "Watched". The dated button retains
the original 50-point action-row height with reduced internal padding and one-line labels.
Unknown dates stay omitted. This presentation does not change tracking timestamps.

## External reviews (TMDB reviews as first-class thread roots)

- TMDB show/movie reviews: page-1 `reviews` from documented title hydration endpoints are persisted to `external_reviews` with stable provider-id upserts. Unchanged reviews retain their row id, likes, replies, detected language, and cached translations; changed content clears only its translation cache. A vanished provider row is pruned only when it has no user replies or likes; interacted roots remain durable so user data never loses its thread parent. Targets synced before reviews existed are lazily backfilled when a show/movie comments thread opens (`reviewsSyncedAt` on MediaItem; never-synced → one light fetch inline; stale >30d → background refresh; 404 = sync empty, transient = stays unsynced). Episode threads retain any legacy cached provider roots but do not call an undocumented episode-review endpoint. Reviews are first-class thread roots and replies remain excluded from top-level comment/activity feeds (`externalReviewId: null`) exactly like comment replies (`parentId: null`). During cross-media canonical cutover, provider roots are relinked and cloned replies preserve the root foreign key in the same transaction; failure rolls everything back.

## Split episode comment threads

- When structure migration splits one provider episode into two canonical parts, it physically clones the current user-comment tree onto the secondary part. Comment/reply ids, likes, spoiler reports, and ready image rows are cloned; immutable encrypted image blobs may be referenced by both image rows and are deleted only after the last live reference is removed. The two comment threads are independent immediately after the migration: subsequent comments, edits, likes, reports, moderation, and deletions on one part do not affect the other. Provider reviews and existing moderation cases are not duplicated.

## Comment and review translations

- `POST /comments/:id/translate` and `POST /external-reviews/:id/translate` accept one supported app locale. Azure language detection runs before translation; same-language, attachment-only, mention-only, emoji-only, and laughter-only content is rejected locally.
- Cached translations live in each row's JSON `translations` map and are returned automatically for the request locale. Comment edits and changed provider review content invalidate the map. Concurrent generation uses a Redis single-flight key and an atomic `jsonb_set` merge.
- Exact `@username` mentions are protected with `translate="no"` markup and verified after translation. TMDB Markdown/HTML is converted and sanitized before translation, sanitized again afterwards, and rendered through the allowlisted rich-text component; user comments remain plain text.
- The public activity feed and profile timeline contain only top-level manual media comments. Replies to comments or external reviews never become activity entries.

## Comment spoilers

- Comment spoilers: `Comment.isSpoiler` + `Comment.spoilerCount` + `comment_spoiler_reports` (one row per user+comment). Community flagging via `POST /social/comments/:id/spoiler-report` (idempotent, no self-reports); `isSpoiler` flips at `COMMENT_SPOILER_THRESHOLD = 5` (shared constant in `packages/shared/src/social.ts`). Authors self-mark at creation (`isSpoiler` on the create DTO; composer eye-off toggle). Imported spoiler state comes from TV Time `is_spoiler`/`spoiler_count` columns. The DTO carries `isSpoiler`/`spoilerCount`/`spoilerReportedByMe`; mobile `CommentCard` censors spoiler comments behind a "view anyway" cover (per-card session state, body + attachments hidden).

## Episode and movie interaction voting (IMPORTANT)

- Four categories on watched episodes: **device** / **rating** / **reaction** (multi-select) / **character** (single-select). Writes are upsert-style — one active vote per user+episode+category, except reactions which toggle on/off (`reactions` table, one row per user+episode+reaction).
- Watched movies expose **rating** / **reaction** / **character** with the same optimistic UI and percentage reveal. Movie character voting is single-select at `@@unique([userId, mediaId])`; `PUT /movies/:id/vote/character` accepts `{ value: castId | null }`, validates that the credit belongs to the movie, and null removes the vote.
- **Character vote is keyed by `cast_id`** (FK → `media_cast.id`). NEVER key it by character name (breaks on duplicate names, multi-role actors, renames). The cast DTO exposes `creditId` = `media_cast.id` for this.
- **Percentages are hidden until the user votes** in that category (`reveal = userVote != null` / `userVotes.length > 0`). Once voted, every option's percentage shows; returning voters see them immediately. Percentages come from **real aggregates** (never hardcoded). Single-select categories use largest-remainder (sum to 100); multi-select reactions display each option’s share of total reaction selections, using largest-remainder rounding (the existing `reactionPercents` behavior), not a percentage of distinct people.
- Client state: `useEpisodeVotes` runs four independent optimistic mutations, each on its own slice of the `['episode', id]` cache (sections never overwrite each other), with rollback on error and server reconcile on success. Do NOT invalidate/refetch the whole episode on a vote. Verified CommsUni stars, reactions, devices, and characters use these same sections and mutation responses. Shared totals add all local MANUAL votes after deducting acknowledged native counterparts from delivery receipts; the current viewer's selection remains authoritative. countedUserVote/countedUserVotes support optimistic changes without subtracting imported choices from the frozen archive. Device mappings require matching key/id/name; character mappings require corroborating TVDB artwork/person identity, matching performer name, and one local credit on the verified media. Counted cast options with no unique mapping are shown as read-only choices and included in percentages. Unavailable, empty, or unsafe fixed catalogs and unacknowledged delivery outcomes fall back to local aggregates. A shared reaction total is a count of selections (`totalKind: selections`), not distinct users.
- Reusable components live in `apps/mobile/components/voting/`; the math is in `packages/shared/src/vote-math.ts` (shared by API + mobile).

## Account deletion (anonymize-and-delete)

- Every path (`DataDeletionService.confirmDeletion`, `UsersService.deleteMe`, and audited Admin user deletion) calls `anonymizeAndDeleteUser` (`apps/api/src/users/lib/deleted-user.ts`). Never delete a user row directly.
- New deletions create ONE unique, suspended, non-login shadow identity per deleted account. A shared ghost cannot own ratings/reactions/votes because their per-user unique constraints would collide across deleted people. The legacy shared `deleted-user@system.local` account remains supported for older comments.
- Before deleting the original row, the helper reassigns only comments that are ancestors of a reply authored by another account. It deletes comments without surviving replies, including an all-self-authored branch; actual tree rows, not the denormalized `repliesCount`, decide this. Preserved comment-image ownership moves to the ghost, and affected surviving parents have `repliesCount` rebuilt. Media/episode ratings, media/episode reactions, and character votes also move to the unique ghost. Episode/movie status rows carrying a `device` vote are reassigned, but `watched=false`, `watchedAt=null`, and `watchCount=0`; status rows without a device vote cascade away. Thus aggregate “where did you watch?” votes survive without retaining viewing history.
- The original user is then deleted so credentials, auth providers, profile, devices, show/progress state, history, watchlist, favorites, custom lists, follows/blocks, notifications, provider alerts, imports, badges/stats, reports, and contacts follow their existing cascades. Password-reset tokens are deleted, deletion-request email/user references are anonymized, queued push jobs are deleted explicitly, and `ExportService.deleteForUser` removes still-downloadable export files plus their records because those tables do not have a User FK.
- The privacy-preserving transfer and final cascade remain one atomic transaction, with a 15-minute budget for unusually large imported accounts. A per-account PostgreSQL try-lock rejects concurrent deletion attempts immediately instead of letting retries expire while waiting behind the active deletion; the Admin request timeout is longer than the transaction budget.
- Every deletion entry point captures the original email address before anonymization and sends a best-effort completion email only after the deletion transaction commits. SMTP failure is logged but never turns a completed deletion into an API failure or sends a false confirmation for a rolled-back deletion.
- Denormalized comment `likesCount`/`spoilerCount` and external-review `likesCount` are decremented for the deleted user's removed likes/reports. Comments required by another account's replies survive because their author moves before the original user is deleted; all other comments are deleted.
- Clients recognize both legacy and per-deletion ghosts through `PublicUserDto.isDeletedUser` (set in `mapPublicUser`): localized `common:deletedUser` label, no profile navigation, and no avatar. Generated deleted-ghost emails are reserved from registration/authentication. Shadow identities are excluded from Admin user counts/listings.
- RECLAIM: if the same person re-registers and re-imports, `applyComments` returns their comments — a staged OWNER-authored candidate whose `(source, sourceKey)` exists under either a legacy or per-deletion ghost is reassigned to the importing user instead of dedupe-skipped (guarded by the exact old `userId`; third-party/shadow candidates never reclaim; no audit rows so rollback cannot delete the pre-existing comments).
- Admin deletion is `DELETE /admin/users/:id` (ADMIN+), requires the exact username in `confirmUsername`, prevents self/SUPER_ADMIN/deleted-shadow deletion, requires SUPER_ADMIN for staff targets, uses the same helper, and writes a `delete_user` audit record with preservation totals.

## Write/backfill preparation invariants

See [COMMSUNI_BACKFILL.md](COMMSUNI_BACKFILL.md) before enabling live writes or running historical
publication. Backfill is reviewed original app comments/replies only; it does not export imported
comments, historical votes or watch history. Existing copy ledgers and uncertain cross-thread
provenance are excluded. New structural copies always retain their original local comment ID.

Device contribution uses `deviceSource`, not the watch row's `source`: rewatch/unwatch must not
turn an imported device into a new native vote. Explicit tracking feedback enters the same vote
transaction/outbox path as the detail vote buttons. Migration `20260913090000_device_vote_provenance`
must precede the API deployment; it preserves recorded provenance, not inferred history.

A confirmed provider-linked comment uses provider likes/viewer state in the healthy shared feed;
historical local likes are retained as local data/fallback, not uploaded. Native replies to
imported original UUIDs verify the parent remotely. Delivery does not duplicate the notification
already emitted for a local-parent reply, and historical backfill emits no reply notifications.

## Common comment presentation

Local, imported and CommsUni rows use CommentsFeed, CommentCard, CommentMedia and the existing
/comment/[id] thread screen. ThreadNode only adds tree geometry and collapse/load-more controls.
The legacy /community-comment/[id] URL redirects with an explicit source marker; never send that
provider UUID to a local comment endpoint. CommentView in the mobile presentation adapter retains
the original shared DTO/context alongside namespaced UI identities; it is not a database model.

CommentActions is the shared local/provider action modal. useCommentActions returns its selection
and props; every consumer must render the modal. Confirmations/errors remain inline and opening
an editor on iOS waits for the modal's onDismiss. Translation failures are inline too, including
requests started from the language picker. Provider grants remain attempt-local; local image URLs
come from the selected backend. Do not recreate source-specific cards, feeds or thread layouts.

## Individual replies while provider writes are disabled (2026-09-12)

The provider write switch governs outbound publication, not the ability to save a local reply.
For an eligible signed-in user, decoded provider comments expose actions.reply=true even when
CommsUni writes are off; like/delete/spoiler publication controls retain their existing write gates.
Suspended/shadow/deleting accounts remain unable to reply, and unavailable/deleted/blocked parents
are rejected. The local create route resolves the media and verifies the exact provider parent,
its timestamp and structured mention author before saving the native reply. No provider write or
outbox admission occurs while writes are off. The existing composer explains local visibility.

The Reply control beside likes targets the selected message (including depth-two provider rows),
not always the thread root. Local unpublished direct replies are included in their provider
parent's reply count so the thread remains expandable after a reload. Counts exclude published,
hidden/deleted and blocked local rows. Frontend query keys are versioned to discard the previous
cached write-dependent reply permissions. No schema or migration change is needed for this fix.

## Audit corrections and launch plan (2026-09-13)

See [current implementation](COMMSUNI_INTEGRATION.md) and [production backfill](COMMSUNI_BACKFILL.md).
The owner plans to enable live writes at launch and run one original-comments-only backfill.
Imports are never republished; originals are not already at the provider before backfill.
API-key rotation changes were explicitly excluded.

Semantic fingerprints ignore routine metadata timestamps. Stored comments are not re-moderated on delivery.
Sanitized tombstones preserve surviving reply branches. Verified imported UUIDs use provider
counters/actions. Bounded local keyset pages and 30-minute cursor state are independent of short
read-cache freshness. Existing own-source fields refresh on user reads; other partners stay transient.
Visible archive images request grants in batches of at most 16. Public outgoing image URLs use the
backend decryption route; MinIO remains private.
