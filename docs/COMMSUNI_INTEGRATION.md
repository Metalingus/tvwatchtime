# CommsUni integration — TV Watch Time

## Contract and production plan

Use [the provider integration guide](commsuni-api-integration.md) and
[backfill contract](commsuni-api-backfill.md). The operational procedure is
[COMMSUNI_BACKFILL.md](COMMSUNI_BACKFILL.md); historical validation is in
[COMMSUNI_REVIEW.md](COMMSUNI_REVIEW.md).

The owner plans to enable live writes at production launch and run one historical backfill.
Original app comments are not already at CommsUni before that backfill. Imported TV Time comments
may already be there and are never backfill candidates. Original text is not searched or matched by
name before publication. Permanent mappings and stable operation keys prevent duplicate retries.
Configuration defaults remain off; deploying preparation code does not itself publish content.
API-key rotation behavior is unchanged at the owner's request.

## API-first mobile rollout

The updated API supports old and new apps concurrently. New clients send
X-TVWatch-CommsUni: 1 on JSON requests and image uploads. An absent or unrecognized header
keeps native comment reads, comment actions and votes on the legacy local workflow. The
capability is request-scoped, so two devices using the same account do not change each other's
mode. Responses vary on this header; it is a protocol capability, not an authorization grant.

Legacy comment creation never auto-publishes, including the old create-then-upload image flow.
Legacy likes, spoiler reports and votes remain local. New clients use shared reads/writes when
configured. Explicit community interaction endpoints still provide their documented shared
results; background workers and the ADMIN backfill are not mistaken for legacy mobile clients.

All app versions can edit their own local copy of a backfilled/shared comment. The local comment keeps its id, parent/reply
relationships, counts and ownership, with hasLocalRevision recording the local-only change.
CommsUni retains the captured original. Both native reads and the merged board show the local
revision in this app; newer apps label it accordingly. Locally revised content is never
republished by a later backfill. Deleting the comment still reserves deletion of the shared
original and makes all associated image URLs unavailable.

Images referenced by captured/shared payloads retain their own immutable rows and encrypted
blobs after a local detach/replacement. Replacement uploads get new image ids. A retained image
stays anchored to its original comment, including through account anonymization and deletion.
Unfinished shared photo drafts changed locally are canceled at finalization rather than
publishing the revised attachment against an older text snapshot.

Apply 20260913210000_mobile_commsuni_compatibility (after the earlier CommsUni migrations)
before deploying this API. Then finish the API rollout before enabling writes/backfill.
App-store rollout can follow independently: existing mobile installs do not need a forced update.
Legacy-created comments stay local unless included in an explicitly reviewed backfill; updating
the app alone does not silently publish them. A completed preview must be replaced by a separately
named new preview to reflect changed eligibility; retain the earlier manifests.

Edited imports and structural copies remain separate local items. User-supplied archive UUIDs
cannot replace somebody else's shared comment; only a verified publication binding from our own
source permits the merged feed to substitute the local revision for the shared original.

## Identity and delivery

All provider requests originate on the backend with stable per-user actors. Credentials never enter
the browser/app, public image URLs, or manifests. Typed TVDB identities, canonical routing, official
episode coordinates, and corroborated cross-provider IDs establish destinations. Fingerprint v2
contains semantic identity/structure; translations, artwork, metadata timestamps, and authority-review
timestamps/rule versions do not invalidate it.

CommsUni-aware comments and explicit vote changes commit their intent with the local write. PostgreSQL
holds the outbox. Committed comments, actions/reports, finalized images and explicit votes wake
BullMQ immediately; the 10-second drain remains recovery for missed wakeups. Per-actor ordering and
provider pacing still apply. Original timestamps, the
transmitted POST body/path, and idempotency key survive retries. Ambiguous POSTs are parked before
the provider's 24-hour ledger expires. Parent ordering, media finalization, suspension, and visibility
checks remain enforced. Submitted shared text is immutable; deletion is not an edit workaround.

Transient provider failures retry with backoff. Moderation runs only on new local comments/images
and changed local text. Publication, historical backfill and retries trust stored content and make
no moderation calls. Legacy moderation-required holds can resume when writes are enabled.
Definitive first selection rejection does not suppress shared counts. Partial/ambiguous selections
remain uncertain until a later acknowledged selection supersedes them or reconciliation resolves them.
Account/comment deletion reserves cleanup under the original identity; disabling writes also pauses
cleanup. Shared operation-state classifications include backfill pauses during account cancellation.

## Conversations, reads, and presentation

The app has one merged board, Latest/Most liked sorting, avatar source badges, shared attribution,
and the existing voting controls. Source-filter headers and a separate voting panel remain omitted.

- Local rows and shared revisions use one comment/metadata batch per page. Counts use a SQL
  aggregate with an origin join and return one row, without loading local comment history into Node.
- Local rows use bounded keyset pages. Provider order is authoritative within its stream. Verified
  imported UUIDs use provider counters/actions; imports stay stored and are not republished.
- The current and immediately retryable cursor snapshots last 30 minutes, independently from the
  30-second read cache. Older snapshots are removed after successful advancement, so the growing
  deduplication history is stored at most twice instead of once per visited page. Retrying the same
  cursor uses the same successor key. Refresh starts a new traversal; old cursors from farther back
  can expire. Cursors remain scoped to user/thread/sort/source.
- Entity-specific cache epochs invalidate affected reads without evicting other titles/source
  catalogs. In-flight page seeding retains its original epoch.
- Visible pages seed individual comment reads. Visibility checks batch block/report queries and
  reapply suppression to cached rows. Buffered pages also check current local deletion flags.
- User-driven reads refresh counters/spoiler state only on existing local MANUAL rows from our source.
  Other partners' content is not persisted. Absence from one page never establishes deletion.
- Deleted parents retain sanitized traversal placeholders only while replies survive; old text/media/
  author actions are removed. Childless tombstones disappear.
- Structured mentions remain separate from text parsing. Flattened replies expose navigation to the
  actual inReplyToCommentId target.
- Saved posts stay visible while archive IDs arrive. Shared action dialogs retain operation IDs and
  show sent, duplicate-report, review, failure, and actor-throttling outcomes. Confirmed actions patch
  displayed rows instead of relying on an immediate provider snapshot that may lag the write.
- Show/movie/list card comments remain local, with their clickable cards intact in the merged feed;
  their text and card are not published as an unsupported CommsUni attachment.
- GIFs from any provider bypass our local media-host allowlist. CommsUni can still enforce its own
  source-level host registration. Non-GIF images continue using COMMSUNI_MEDIA_HOSTS.
- Only local delivery/image-processing state is polled. Provider data is read on user activity.
- Archive reports offer mine_hide and mine_claim only when origin.kind is tvtime. The UI explains
  these are requests for operator review, not immediate removal or ownership transfer. Existing
  backend validation remains in force.
- Own-source shared reads expose the viewer's verified local comment ID for the existing editor.
  Own comments offer Edit/Delete without self-report or self-block actions; ownership is never
  inferred from display names. Edits use the existing local-revision and retained-image behavior.
- Pending delivery has no visible waiting label. Saved posts and local edits remain visible through
  refreshes and delayed provider snapshots; actionable delivery failures remain visible.
- Report confirmation is derived from the matching delivery operation, so a late pending POST
  response cannot overwrite an acknowledgment. Accepted reports say Report submitted; duplicates
  remain distinct. Cached pending comments are tracked alongside new posts, deduplicated by local
  ID, and stop polling on a final state. A pending snapshot cannot replace a known synced status.


## Media detail loading

Show, movie and episode details return local counts and interactions immediately after their
normal metadata/local-data work. They never await CommsUni. The app reads shared comment counts
and voting totals through separate authenticated API queries and updates each independently.
Provider failure leaves usable local data (or a previously displayed shared total). Artwork
polling does not poll CommsUni, and late aggregates do not overwrite a vote changed meanwhile.
See [the loading contract](SOCIAL_SYSTEMS.md#detail-comment-counts-and-watched-dates).

## Images: encrypted MinIO, public API delivery

MinIO stores ciphertext. The public GET /api/comment-images/:imageId route retrieves it, decrypts it
on the backend, and streams WebP/GIF bytes. Partner readers need no JWT or decryption key. Responses include an ETag and public, no-cache
revalidation policy. Matching If-None-Match requests return 304 after checking current visibility,
without reading MinIO or decrypting the image again. First requests still fetch/decrypt bytes; no
new plaintext server cache or public bucket is introduced.

Live publication and backfill use the same publicCommentImageUrl helper and send a stable attachment
URL such as https://PUBLIC-API-HOST/api/comment-images/IMAGE_ID with contentType and the registered
source slug as provider. API_BASE_URL may contain /api; the helper adds the prefix exactly once.
Never send a MinIO object key, ciphertext URL, encryption metadata, or temporary upload URL.
The bucket stays private and the URL has no expiring signature.

Before production:

1. Set API_BASE_URL to the externally reachable HTTPS API address.
2. Put that hostname in COMMSUNI_MEDIA_HOSTS and register it with the CommsUni operator.
3. Permit anonymous access to /api/comment-images/* through the reverse proxy.
4. Finalize the image before the first comment POST; media cannot be attached later through editing.
5. Retain backend access to the bucket and encryption master key.

The backfill readiness endpoint exposes an example delivery URL and local hostname-match result.
These do not prove provider registration or external reachability. Tests verify anonymous
ciphertext-to-plaintext delivery and public-route metadata with mocks. The owner must check a real
ready-image URL anonymously before release. Deleted/hidden comments stop serving images.

Incoming archive images request grants in visible batches of at most 16 through the backend.
POST /v1/media-grants is a read independent of publication. Missing results are cached for two hours.
Signed URLs live only in the mounted load attempt; image bytes have a separate cache. Abandoned
subscribers cancel without aborting other visible images in the same batch.

## Engagement

<a id="current-engagement-support-2026-09-12"></a>

Five-star and emotion controls use verified provider options/totals. Devices/cast require verified
mappings; unmapped counted cast choices stay visible without guessed identities. The independent
provider 0–10 rating is not converted into the five-star poll.

Native and provider-option endpoints share vote persistence/provenance handling. Local MANUAL votes
contribute while imported choices are not added again to the frozen archive. Receipts deduct known
native counterparts. Device provenance stays independent from watch/rewatch provenance; watching
alone does not republish an imported device choice.

## Validation and release

Four existing migrations are prerequisites: integration, delivery ordering, vote receipts, and device
provenance. These corrections add no schema migration. Generate a fresh preview using the corrected
API; pre-fix fingerprint proofs and cursors are not silently rebased.

The API no-emit typecheck reads shared source through tsconfig.typecheck.json, so validation does not
require a package build. Release builds still compile shared CJS through the existing pipeline.

The owner builds the API image and creates a fresh Expo web export before the respective releases.
Production migrations, publication, and backfill remain separate operations. Mocked validation does
not establish live scopes, hostname registration, quota, proxy reachability, or native iOS behavior.
