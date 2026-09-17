# CommsUni review and validation

## Current reference and reporting scope

Use [commsuni-api-integration.md](commsuni-api-integration.md) for provider contract details and
[TVWatch implementation notes](COMMSUNI_INTEGRATION.md) for current behavior and unresolved gaps.
Consult the relevant provider section when changing code or explaining API behavior. Earlier
attachments and download filenames are historical review inputs.

The sections below are dated or sequential validation records, not proof that every later change
was tested by each earlier run. The initial review compared the supplied pasted guide with
partner-api-integration-260908.md and found those two historical inputs identical.
The review distinguishes provider contract details from product instructions. The one-board design,
no identity-sharing prompt, deferred archive mirroring, and production-read-only rollout are preserved.
The product owner explicitly chose to retain TVWatch identities without an extra prompt. Shared
comments synchronize the user's display name (username fallback) and approved HTTPS avatar. Profile
updates remain disabled until provider writes are enabled.

## Initial regression coverage (historical)

| Area                  | Covered scenarios                                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Parent dependencies   | Failed, canceled, uncertain, and mapping-blocked parents; attachment wait; unrelated delivery can proceed                                               |
| Entity identity       | Typed TVDB series/movie/episode references; official episode order; poisoned bridges; combined broadcasts; canonical cycles; comment/entity ID mismatch |
| First publication     | Promote missing comment binding; expire engagement binding on 204; prevent concurrent negative overwrite                                                |
| Ordered delivery      | Database sequence for same-millisecond operations; rapid 1→2→3; stale snapshots; partial delivery replay with identical payload                         |
| Blocks and moderation | Remote rows, imported UUID copies, published copies, legacy local details, native account/provider links, cursor changes, provider outages              |
| Provenance            | Imports, restores, and structural clones do not enqueue publication; local state is preserved                                                           |
| Identity sharing      | Gated profile PUT with stable actor; name/avatar updates, host checks, retry, and identity mismatch protection                                          |
| Mentions              | Correct author/spans; edited/deleted spans removed; exact retry payload                                                                                 |
| Posting               | New row remains visible under Most liked; local/provider echoes deduplicate in either order; failed text remains                                        |
| Production safety     | Global write gate, disabled module boot, injected test HTTP only, paused cleanup, idempotency window, changed credential scope                          |
| UI                    | Attribution, both catalog platform icons, source controls, TVWatch identity explanation, outbound action labels, light/dark rendering and contrast      |
| Existing systems      | Comments, votes, images, social actions, translations, imports, exports, metadata remaps, account deletion                                              |

All mutation tests use mocked HTTP and persistence. During that initial review no provider calls were
made and no shared database was modified. Prisma client generation and schema validation used an
explicitly unused loopback URL. The later GET-only observation is recorded below.

## Validation record

Initial review validation on 2026-09-11 (before the identity-restoration follow-up):

- **355 API tests passed across 21 focused suites**, zero failures. The final run includes the crash-before-first-send regression.
- **18 mobile tests passed across 3 suites**, including light/dark component rendering and text contrast.
- API, mobile, and shared workspace typechecks passed; the shared CJS build passed.
- Focused API and mobile ESLint checks passed.
- Prisma schema validation passed and the generated client includes the delivery sequence. SQL was reviewed, not applied.
- 273 locale JSON files validated. All 25 CommsUni translation keys are populated in all 13 locales.
  The repository locale checker still reports older missing keys outside these additions.
- Fresh Expo web export passed: 56 routes, output in apps/app-web. No publication or deployment.
- Final diff/working-tree checks found no unexpected source-adjacent JavaScript/type declaration outputs.

The verification scope included:

- Focused API Jest suites covering the integration and affected existing systems.
- Mobile Jest tests for posting/mentions/selections, capability compatibility, and attribution.
- API/mobile/shared typechecks and focused lint.
- JSON/translation-key validation for every supported locale.
- Prisma schema validation, migration SQL review, git diff whitespace check, and generated-file check.
- Fresh local Expo web export.

## Limits and release steps

- The logged-in browser preview runtime failed with a Windows sandbox ACL error. Later isolated
  headless browser fixtures and screenshots passed; these do not verify the signed-in app or native iOS.
- One live engagement GET for Troy was inspected on 2026-09-12. Broader live API behavior remains
  unverified; production mutation tests remain prohibited.
- Verify both additive migrations on the target before an approved release. This work did not apply
  them and does not establish whether someone else has applied them.
- API image build, push, and deployment were not run; they remain release steps.
- The guide does not define incremental change feeds, cross-app notifications, moderation webhooks,
  or a bulk delete endpoint; none is assumed.
- Outbox records retain delivery evidence needed for retries and account cleanup. No automatic
  historical export or aggressive ledger pruning is introduced.

## Identity-restoration follow-up

The product owner confirmed that shared comments should keep TVWatch names and profile pictures.
The dispatcher now synchronizes the display name (username fallback) and an approved HTTPS avatar
before a comment/reply. It skips unchanged profiles, preserves the actor/author binding, rejects a
changed author ID, and retries failed profile acknowledgements without prematurely sending the comment.
Profile updates stay behind the existing disabled-by-default write switch and account lifecycle checks.

Validation for this focused follow-up:

- 68 API tests passed across the publication, transport, and disabled-module suites.
- 7 mobile tests passed across attribution rendering/contrast and backend compatibility.
- API/mobile typechecks and focused API/mobile lint passed.
- Identity copy updated and checked in all 13 locales; the obsolete anonymous-identity key was removed.
- A fresh local Expo web export completed (56 routes).
- No schema changes, migrations, provider calls, image builds, publication, or deployment were performed.
  Existing live-provider and native-device validation limits still apply.

## Shared text/image moderation follow-up

Images, live comment/reply text, edited text, and CommsUni outbound content now reuse
ContentModerationService with OPENAI_API_KEY and OPENAI_MODERATION_MODEL. Local text uses the existing
image thresholds; CommsUni keeps its stricter unflagged-or-manually-approved sending rule.
Moderation runs before saving new text or mutating edited comments/attachments. A validated unflagged
text-only creation can reuse its approval at dispatch; media still requires a combined check.
Existing imports and provider comments are not rescanned.

Validation: 156 focused API tests across 7 suites and 13 mobile tests across 2 suites passed.
API/mobile/shared typechecks, focused lint, locale JSON/key checks, and the fresh 56-route Expo web export
passed. Both new user messages are translated in all 13 locales. No live OpenAI or CommsUni calls were
made, no database was changed, and no deployment or API image build was performed. Native iOS modal
validation remains a device check; moderation errors in the edit dialog are rendered inline.

## User-facing UI correction (historical; later vote/badge changes below)

The product owner explicitly removed source filters and the separate Community votes panel.
Provider stars/reactions now feed the existing show/movie/episode controls through CommsUniVotingService,
including native vote responses. Provider counts are authoritative when safely mapped; local selections
are preserved, and unavailable/unmapped sections retain local counts. The adapter does not sum
overlapping imported/local/shared totals or convert the provider's separate 0–10 score.
Device and cast options remain local because the guide does not establish a safe option-ID bridge.

The comments header no longer exposes a block-list shortcut. Personal blocks are managed in Settings,
with native and provider entries together and no admin endpoints. Source icons sit beside usernames
on comment/reply cards. Missing/broken avatar URLs have a generic profile silhouette; GIFs/images use
loaded intrinsic dimensions rather than a fixed square frame.

An isolated headless Chrome fixture (real card React layout, mocked hooks/media wrapper, no provider
access) passed in light and dark themes. Browser measurements: an 840×360 image displayed at
656×281.14, the broken-avatar placeholder remained visible, and the source badge was within the
username row. Screenshots were inspected. This is web layout verification, not native iOS verification.


Validation for the UI correction: 119 API tests across 11 focused suites and 26 mobile tests across
4 suites passed. API/mobile/shared typechecks, focused API/mobile lint, all-locale JSON/key checks,
and a fresh Expo web export (56 routes) passed. No live provider requests, provider writes, database
migrations, API image build, or deployment were performed. The existing release migrations and API
image build remain required before deploying the API; native iOS device QA is still separate.


## Scroll flicker correction (historical; signed-URL reuse since removed)

The pre-fix browser fixture reproduced image removal on every viewport exit and a new image node
on every re-entry. The card now treats visibility as activation, preserves a media frame, retains
loaded dimensions through row recycling, and uses stable image sources/keys without GIF fade-ins.
The lists retain activation and use a viewport-relative threshold, including for very tall comments.
Clipped-subview removal is disabled for these bounded virtualized lists.

The footer had described the destination of a new comment while global sharing was disabled, not
the provider GIF above it. It now says the new comment will be visible only in TVWatch and appears
only while composing; per-comment provenance labels remain.

Validation: 26 focused mobile tests, mobile typecheck, focused lint (including the regression script),
all 13 new locale strings, and a fresh 56-route web export passed. The offline browser script passed
all four external/archive × light/dark cases with real React Query: stable DOM/height through repeated
visibility changes, same height after recycling, short-link reuse, spoiler shielding, and viewer
isolation. These files survived the reported computer crash. No backend changes, provider API calls,
provider writes, migrations, or deployment were performed for this correction. Native iOS device
verification remains separate from the browser fixture.


## Earlier vote counts and avatar badge follow-up (2026-09-12; historical)

The badge moved from the username to the avatar's outer top-right corner. Offline light/dark
browser fixtures verified placement, source-name reveal without changing card height, placeholders,
and media stability. The later 4-pixel outward adjustment passed the same four browser cases,
mobile typecheck, focused lint, and a fresh 56-route web export.

The frozen star/reaction counts were an implementation defect. Detail and vote responses now replace
the current actor's provider-native contribution with that viewer's saved MANUAL selections.
Imported choices do not decrement the frozen archive. This does not yet merge all other users'
unshared local votes. Device/cast controls also remain local; the API supports them.

The vote/badge follow-up recorded 52 distinct focused API tests and 22 mobile tests passing, along
with API/mobile/shared typechecks, focused lint, shared build, web export, and diff/emission checks.
These are prior validation results, not new test runs performed for the documentation update.

A read-only database transaction identified the saved binding for Troy, S3E10. One provider GET
returned two archived five-star selections, three emotion selections, zero device selections, and
two character option entries with one vote each. Both character entries label Rebecca Ferguson /
Juliette but use different keys. That does not prove two distinct voters or a safe local cast mapping.
See [the diagnostic details](COMMSUNI_INTEGRATION.md#vote-count-correction-and-read-only-diagnosis-2026-09-12).

The same observed response put `{ average: 5, count: 2 }` in `rating.votes.archived`, whereas the
[provider guide](commsuni-api-integration.md#entity-engagement-fields) specifies no archived data in
that separate field. Record this as an unresolved contract/response discrepancy; a value of 5 alone
does not establish a scale. Our star control uses `options.starRatings[]`.

The earlier 30-second reuse/60-second retention of signed media URLs conflicted with the guide's
[one-shot URL rule](commsuni-api-integration.md#handling-signed-urls). That implementation has since
been replaced by attempt-local delivery links and fresh grants for retries; image byte/layout caches
remain separate. The recovery tests cover this behavior, while live native/browser reproduction
remains unverified.

## Documentation reference update (2026-09-12)

Repository routing and implementation/status notes now link to the supplied provider guide.
Obsolete expandable-panel wording was removed; earlier username-badge verification is explicitly
historical. Remaining vote, identifier, signed-URL, and live/native verification gaps are recorded.
The provider guide itself was not rewritten. This documentation update makes no runtime changes,
provider calls, database writes, migrations, builds, or deployments.


## All-user voting follow-up (2026-09-12)

The subsequent implementation replaces the per-viewer-only merge with all local MANUAL votes and
durable native-delivery receipts. Devices and safely mapped cast options use the same detail and
mutation-response path. Provider cast aliases keep their separate counts while resolving to one
unique local credit only with corroborating TVDB artwork/person identity and matching name.
Unmapped counted options remain visible as read-only entries.

The read-only Troy probe ran the actual decoder, cast mapper, and voting adapter against saved local
data and one authenticated provider engagement GET. It returned 3 star votes, 6 emotion selections,
1 device vote, and 3 character votes: 2 Juliette votes from the provider plus the local Robert Sims
vote. The receipt table was not present and no outbox operations existed; the guarded read-only
fallback was exercised. This snapshot does not establish every title's mapping or live write behavior.

The new additive receipt migration is reviewed and the Prisma client was generated using an unused
loopback datasource override. Windows initially blocked the engine file; only the local API watcher
and its server were stopped for generation, then the local API was restarted. No migration was
applied. Provider writes remained disabled throughout.


Final verification for this follow-up:
- 173 API tests passed across 12 focused suites; 16 mobile tests passed across 2 suites.
- API/mobile/shared typechecks and focused API/mobile lint passed.
- Shared package build, Prisma schema validation, and comparison of receipt migration columns/indexes
  with Prisma-generated SQL passed. The migration adds only receipt storage and an array constraint.
- All 13 locales contain the new unavailable-vote label.
- Four offline browser scenarios passed (light/dark × narrow/wide). Narrow light/dark screenshots
  were inspected; the fixture uses mocked icons/images and local count state, not a signed-in app.
- A fresh Expo web export completed with 56 routes. The local API's feature-flags route returned 200.
- Rollback now restores only the failed voting category, preserving concurrent changes in other
  categories. Character option ordering is stable for percentage tie-breaking. A contradictory
  provider catalog cannot be overridden by a hardcoded star-key fallback.
- No provider write tests, migrations, API image build, publication, or deployment ran.
  Native iOS and live write behavior remain unverified. Apply/reconcile receipt storage before an
  approved write rollout; keep COMMSUNI_WRITES_ENABLED=false for the current production-read-only work.


Build/export ownership update: the product owner subsequently instructed that they run all builds
and exports. The shared-package build and web exports recorded above had already completed before
that instruction. Future agent work must report required build/export steps without running them
unless the owner explicitly delegates the specific command. No further build/export was run for
this instruction update.

## Write and backfill readiness preparation (2026-09-12)

Implementation and operator workflow are documented in [COMMSUNI_BACKFILL.md](COMMSUNI_BACKFILL.md).
The supplied [backfill guide](partner-api-backfill.md) was copied unchanged into the repository;
[commsuni-api-integration.md](commsuni-api-integration.md) remains the main provider contract.
Historical validation above is not a production write acceptance record.

Corrections cover device provenance, explicit tracking feedback, imported-parent reply intents,
provider engagement for confirmed shared copies, historical/duplicate notification suppression,
encrypted provider diagnostics, distributed write pacing, partial-selection checkpoints and
daily-budget handling. Backfill preview/apply/report routes are ADMIN-only, gated separately,
limited in admission, and reuse permanent creation operation IDs. Copy lineage/audit records
and ambiguous cross-thread provenance are checked before review and again during admission.

Completed validation:
- API no-emit typecheck passed after the final code change.
- Focused backend ESLint passed, including the final changed service and tests.
- The expanded focused API set passed **395 tests in 17 suites**. Subsequent administrator/detail
  regressions passed **70 tests in two suites** (including rerun existing tests); the final publication
  suite passed **55 tests**, including a new partial-selection quota case. These counts overlap.
- The operator script passed **9 Node tests** using fake requests: dry-run pagination, stable resume,
  parent ordering/cycle rejection, explicit apply acknowledgment, scope mismatch, uncertain outcomes,
  complete mapping pagination and token redirect protection.
- Prisma client generation, schema format and schema validation completed with an explicitly unused
  loopback datasource override. No database connection/migration was used for those checks.
- Additive device migration columns/index were reviewed against the schema. It is **not applied**.
- Existing ts-jest isolatedModules deprecation warning remains; it did not fail the focused tests.

Production boundaries:
- Actual local environment still has COMMSUNI_WRITES_ENABLED=false; backfill flag absent means false.
  No environment flag or real database record was changed by this preparation.
- No provider calls, including no playground writes, were used for this implementation validation.
- No historical backfill, provider cleanup, migration application, build, export or deployment ran.
- Real PostgreSQL migration execution/admission concurrency, provider scopes/quotas/host retrieval,
  and live end-to-end delivery still need rollout verification. Mock tests do not prove those.
- Apply/reconcile required schema before this API release. Builds/exports remain the owner's work.
  There are no new mobile screens, translation keys or theme changes in this preparation.

## Consolidated comment UI verification (2026-09-12)

The cleanup reuses CommentsFeed, CommentCard, ThreadNode, CommentMedia, TranslatableContent and the
existing /comment/[id] screen for local/provider comments. CommentActions is the common action
modal for the feed, comment thread and external-review thread. The old provider thread route is a
compatibility redirect. Separate provider card/feed/media/action renderers and the obsolete scroll
fixture were removed. Unused frontend engagement helpers were removed; detail voting is unchanged.

Verified after the final runtime changes:
- Mobile workspace no-emit typecheck passed.
- Focused ESLint passed for all changed UI/hooks/tests, including the review-thread consumer.
- **108 tests passed across 10 focused mobile suites.** Coverage includes light/dark component
  renders, both sources' like/reply/overflow wiring, invalid source markers, explicit remote UUID
  reply targets, disabled provider actions, stable posted-row keys, group/local routing, spoilers
  in thread nodes, nested media activation, local/backend image routing, archive grant recovery,
  iOS onDismiss-before-edit sequencing, inline modal confirmations/errors and existing votes/moderation.
- Local/provider action endpoints are tested with mocks; no live write test was performed.
- No new translation keys were introduced. Existing translation keys and shared theme tokens are
  reused; the common modal retains the existing dialog width cap and safe-area sizing.
- Browser inspection failed with "Transport closed"; the native fallback kernel failed to
  initialize with a sandbox ACL error. Live browser/native visual and interaction verification
  remains outstanding. Isolated rendering/callback tests do not establish native iOS behavior.
- No provider writes, database migrations, builds, exports or deployments were run.
  Existing write/backfill defaults and the unapplied device-provenance migration remain unchanged.
- The owner must produce a fresh Expo web export before releasing this frontend. Earlier API
  release/migration requirements remain separate; this cleanup did not alter backend code.

The raw Git file count includes previously accumulated work, 13-locale updates and tests. Reusing
existing components also marks previously untouched files as modified; that counter is not a count
of independent implementations. The reduction is in duplicate rendering and action logic.


## Missing individual Reply controls (2026-09-12)

Root cause: the API derived actions.reply from the provider write switch, and local creation
also asserted that switch for any provider-parent reply. Consolidation honored that value and
hid both the per-message Reply control and composer. Local reply eligibility now uses the
account's eligibility separately; provider sends/outbox admission remain default-off.

Validation: 195 tests passed across the four focused API suites (comments, reader, publication
and transport safety). 34 mobile tests passed across presentation and common-card suites,
including the actual thread screen's select-message -> composer-target -> cancel interaction
at depths one and two with provider publishing off. Wrong-media, wrong-comment, deleted,
blocked and suspended cases reject before saving; native replies create no provider request
or outbox operation. API/mobile no-emit typechecks and focused lint passed.
No live provider writes, migrations, builds, exports or deployment ran. Live browser/native
UI verification was not performed. API image and web export remain owner-run release steps.


## Immediate nested-reply placement (2026-09-13)

A newly created reply to a local message inside a provider-rooted thread was passed to the root
feed retention path. That path presents its entries as direct replies to the displayed root.
The server parent was correct, so refreshing/reloading the subtree corrected the placement.

The thread screen now inserts a newly created non-root reply into the selected parent's expanded
subtree for either thread source. The UI parent reference is explicit for provider targets, the
selected subtree expands immediately, and controls account for already loaded children while
server reply counts catch up. Direct root replies retain the existing root-feed behavior.

39 tests passed across the common-card/thread and presentation suites, including the complete
select -> create -> select child -> create grandchild sequence without a query refresh in both
local/provider threads and both Recent/Top sorts, plus posting under a collapsed provider parent.
Mobile no-emit typecheck and focused lint passed. No new files, backend/schema changes, provider
requests, builds or exports were needed. Live browser/native UI verification was not performed.


## Audit corrections and production preparation (2026-09-13)

The owner requested the audit fixes except API-key rotation. The owner confirmed original app
comments are not already present at CommsUni before the planned one-time backfill; imports remain
excluded. Current behavior is in [COMMSUNI_INTEGRATION.md](COMMSUNI_INTEGRATION.md), and launch,
public-image verification, and backfill steps are in [COMMSUNI_BACKFILL.md](COMMSUNI_BACKFILL.md).

Implemented: semantic fingerprints; durable browsing cursors with bounded local keyset reads;
provider-preferred verified imports; precise vote uncertainty and superseding receipts; sanitized
tombstone traversal; transient moderation retries; normalized local-parent replay; delivered-action
feedback; batched grants and visibility checks; entity cache epochs including deletion cleanup;
shared vote persistence; public image URL construction; current documentation without duplicate
provider-contract copies. API-key scope logic was compared with the initial working tree and is unchanged.

Final focused validation:
- API: 393 integration/social/image/vote regressions passed (21 suites).
- Adjacent API compatibility: 180 metadata/movie/social tests passed (9 suites).
- Mobile: 130 comment/media/operation/optimism tests passed (12 suites).
- Backfill script: 9 tests passed.
- Total: 712 focused tests passed.
- API/shared and mobile no-emit workspace typechecks passed. The API now typechecks shared source
  through tsconfig.typecheck.json without requiring a package build.
- Focused API/mobile ESLint and git diff --check passed. Changed files were formatted with Prettier.
- Locale files remain valid. Every new label and every reused label required by the new tombstone UI
  exists across the 13 locales. Older, unrelated missing-key warnings remain in the repository.

Early validation runs identified stale fixtures and typing issues, which were corrected and rerun.
The ts-jest isolatedModules deprecation warning remains. Initial temporary source-typecheck settings
were replaced with the checked-in API typecheck configuration; no JavaScript was emitted beside source.

Public-image regressions use real encryption/decryption with mock storage: an anonymous reader
receives image bytes, while stored bytes remain encrypted; deleted comments cannot serve the image.
These tests do not establish external proxy reachability or provider hostname registration.

No production writes, backfill, live provider requests, migrations, builds, Expo exports, publication,
or deployment were performed. This correction adds no schema migration. Existing rollout migrations,
the owner's API image build and fresh web export, real anonymous image verification, and native iOS
interaction checks remain release prerequisites.

## Live playground movie validation — 2026-09-14

The owner explicitly selected **movie tvdb-369369 for all live tests**, superseding the earlier
synthetic-show suggestion. No write was sent to show 900000001. TVDB's authenticated movie lookup
confirmed Calamity Jane (1963), TMDB 534283 / IMDb tt0306616. The local app resolved that exact movie
to cmu1dedey1kcve4sepjc60o08. The 2024 film has a different TVDB ID and was only inspected.

The repeatable CLI is apps/api/scripts/commsuni-write-smoke.mjs. It is restricted to the approved
movie, requires --run, reads credentials from the process environment, uses isolated per-run actors,
records credential-free results under .tmp, and deletes its own test comments/votes/profile overlay.
Run from the root with:
    rtk proxy node --env-file=.env apps/api/scripts/commsuni-write-smoke.mjs --run

Observed provider results:
- Source tv-watch-time is registered with status staging; write scope is operational.
- Profile PUT, comment POST, identical POST retry, single-comment GET, feed GET, reply POST/GET,
  like/unlike, author spoiler PATCH, community spoiler PUT/DELETE, engagement PUT/GET/DELETE,
  conversation count GET, and author comment DELETE succeeded.
- The first run exposed delayed feed visibility and stopped/cleaned up. A bounded follow-up observed
  the new top-level comment after 4,205 ms and the reply after 6,285 ms. These are sample observations,
  not latency guarantees; direct comment reads succeeded immediately.
- The movie exposes no starRatings options. An existing returned emotion key was used for the
  engagement write test; five-star publication was not verified.
- Cleanup DELETEs returned 204. Subsequent GETs for all three created provider comments/replies
  returned deleted=true with cleared text. No operator reports or other partners' content were changed.
- Reports: .tmp/commsuni-write-smoke-ee1ece42-b943-43ac-8f02-925f5545518d.json (initial delayed-read failure),
  .tmp/commsuni-write-smoke-d7f0c2f1-e02a-4561-bc50-45344477fc0e.json (comment/reply/actions pass),
  .tmp/commsuni-write-smoke-0c7c8272-6f0d-4c8f-be1a-be22298cd8fb.json (engagement pass).

Actual web app at localhost:8082, using localhost:4000/api:
- A temporary regular USER account opened the exact playground movie and its shared comments.
- The separate comment-count endpoint returned 10, source=commsuni, approximate=false.
- A comment submitted through the actual composer appeared in the feed and through the local GET.
  The merged count became 11. UI delete/confirmation succeeded, the count returned to 10, and the
  comment GET showed deletedByUser=true with empty text.
- COMMSUNI_WRITES_ENABLED and COMMSUNI_BACKFILL_ENABLED remained false. The temporary local comment
  consequently had no provider ID/state. Automatic outbox delivery from the app is still unverified;
  direct provider writes and local UI workflows were tested separately.
- Browser console also reported nested button markup in ArtworkHero and a false non-boolean
  interactive attribute. These warnings did not prevent this workflow and were not changed here.
- Public image upload/delivery and native iOS/Android behavior were not covered by this live run.
  No application build/export, migration, production deployment, or historical backfill was run.
