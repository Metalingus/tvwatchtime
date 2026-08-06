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

## External reviews (TMDB reviews as first-class thread roots)

- TMDB reviews: page-1 `reviews` from hydration are persisted to `external_reviews` with stable provider-id upserts. Unchanged reviews retain their row id, likes, replies, detected language, and cached translations; changed content clears only its translation cache, and vanished provider rows are pruned. Targets synced before reviews existed are lazily backfilled when a comments thread opens (`reviewsSyncedAt` on MediaItem/Episode; never-synced → one light fetch inline; stale >30d → background refresh; 404 = sync empty, transient = stays unsynced). Reviews are first-class thread roots and replies remain excluded from top-level comment/activity feeds (`externalReviewId: null`) exactly like comment replies (`parentId: null`).

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
- **Percentages are hidden until the user votes** in that category (`reveal = userVote != null` / `userVotes.length > 0`). Once voted, every option's percentage shows; returning voters see them immediately. Percentages come from **real aggregates** (never hardcoded). Single-select categories use largest-remainder (sum to 100); multi-select reactions use independent rounding.
- Client state: `useEpisodeVotes` runs four independent optimistic mutations, each on its own slice of the `['episode', id]` cache (sections never overwrite each other), with rollback on error and server reconcile on success. Do NOT invalidate/refetch the whole episode on a vote.
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
