# CommsUni write rollout and historical comment backfill

This is the operator runbook for **TV Watch Time**. The provider contract is
[commsuni-api-integration.md](commsuni-api-integration.md); the supplied
[commsuni-api-backfill.md](commsuni-api-backfill.md) defines historical timestamp and idempotency rules.

The owner plans to enable production writes and run one original-comments-only backfill at launch.
Originals are not already present at CommsUni before this backfill. Imported TV Time comments may
already be there and remain excluded. This document is not a record of an executed production run.

## What leaves the app

| Action                                   | Sent to CommsUni                                                                                                                                                                  |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Historical backfill                      | Eligible original app comments/replies: body, original creation time, language, spoiler flag, allowed image/GIF attachment and verified TVDB destination                          |
| Author presentation                      | Stable opaque per-user actor; current display name (username fallback), approved HTTPS avatar or null, synchronized before the author's comment                                   |
| Normal activity after writes are enabled | New eligible comments/replies, explicit likes/spoiler/report actions and explicit rating/emotion/device/character changes through supported mappings                              |
| Excluded from this backfill              | TV Time/Trakt/other imports, uncertain provenance, structural copies, group threads, external-review replies, media/list cards, deleted/hidden comments, shadow/suspended authors |
| Also not backfilled                      | Historical ratings, emotions, character/device votes, likes, spoiler-report ledgers, watch history, watchlists, email addresses, passwords or import archives                     |

Imported data stays local and is not uploaded again. A new original app reply can target an imported
TV Time parent's original UUID; the worker reads and verifies that parent's conversation, visibility
and timestamp before posting the child. It never uploads the imported parent. Numeric/generated
import IDs cannot be used as archive UUIDs.

An explicit new vote after an import is a new app action. It can be shared once writes are enabled.
Merely watching, rewatching or unwatching does not republish an existing imported device choice.

## Effects users will see

- Successfully shared historical comments become visible to other CommsUni partners under the
  user's current TV Watch Time identity, retaining their original comment timestamps.
- The merged feed prefers the provider's counters, viewer-like state and ordering for confirmed
  shared rows. Historical local likes remain stored but are not transferred into provider counters.
  Provider outages can temporarily show the local fallback.
- Owners can edit their local copy after submission; CommsUni retains its published original.
  Deletion uses the provider cleanup queue. Backfill does not rewrite text or remove the local comment.
- Backfill sends no historical reply notifications from TV Watch Time. The app cannot control
  notification policies in other partner applications.
- The migration below records device provenance separately from watch provenance. It copies the
  provenance currently stored; it cannot reconstruct already-misclassified historical choices.
- Conservative provenance checks hold existing copy-ledger entries and unexplained same-author,
  same-timestamp rows across different threads. They do not merge rows or guess a winner.

## Before enabling anything

1. Review and apply the existing CommsUni integration, delivery-ordering and vote-receipt migrations
   if production has not already received them. Apply
   `20260913090000_device_vote_provenance` **before deploying this updated API**.
   It adds nullable `device_source` to the existing episode/movie status tables and one index;
   it does not add a new table. It initializes nonempty device choices from their recorded source.
   Normal migration backup/locking precautions apply; the initialization updates existing status rows.
2. Apply 20260913210000_mobile_commsuni_compatibility before this API version. It adds local
   revision/create-request metadata and retained-image ownership without deleting existing content.
   Finish the API rollout before enabling writes/backfill; old mobile requests remain local.
   Backfilled comments can still be edited by older apps as local-only revisions, with the shared
   original and its images preserved.
3. The owner builds the API image and handles release/export steps. Agent validation does not
   substitute for those steps. No production schema or running deployment was verified here.
4. Coordinate scope (`archive:read`, `archive:write`, applicable media scope), registered source slug,
   attachment/avatar hosts, quota and migration window with the provider. Send their requested
   APK or screenshots/video before requesting production limits. These operator conditions
   cannot be inferred from configuration flags.
5. Keep the actor secret stable and backed up, along with the outbox, identity rows, comment remote
   IDs and run manifest. An API-key scope change intentionally blocks replay; do not recreate
   actors or operation keys to work around it.
6. Inspect existing queued/failed/uncertain operations before enabling writes. The global switch
   resumes existing eligible queue items as well as capturing new user actions. It is not limited
   to one operator or movie.

## Production writes and one-time backfill

```dotenv
COMMSUNI_WRITES_ENABLED=true
COMMSUNI_BACKFILL_ENABLED=true
COMMSUNI_WRITE_INTERVAL_MS=1000
```

Use these values for the approved production launch after migration and public-image checks.
Repository defaults remain false. When backfill completes, set COMMSUNI_BACKFILL_ENABLED=false
and keep COMMSUNI_WRITES_ENABLED=true for normal activity.

The existing enabled/key/actor-secret/source/host settings still apply.
`COMMSUNI_BACKFILL_ENABLED` requires the global write gate and controls both admission and delivery
of historical rows. Turning it off parks historical work in `BACKFILL_PAUSED`; live writes can
continue. Re-enable it after review to resume the same operations. Environment changes require
the API processes to reload; an HTTP request already in flight cannot be recalled.

The write interval is shared through Redis across API replicas and live/backfill requests
(default one reservation per second; configurable 100–60000 ms). It is pacing, not a promise
that this rate fits the provider's quota. Honored Retry-After and exponential backoff can slow it
further. A daily-budget rejection pauses writes; without a usable reset hint the pause is 24 hours.
An administrator may use `POST /admin/commsuni/writes/resume-budget` only after quota/reset review.
Actor-denied failures require review and are not endlessly retried.

Backfill trusts the historical content already accepted by the app. Preview, enqueue, delivery and
retries never invoke AI moderation or require a moderation key. New local comments, text edits and
image uploads retain their local moderation checks. Attachments must already be publicly retrievable
at the first POST; preview checks payload/URL rules, not remote host registration or actual bytes.
GIF provider hosts do not need entries in our local COMMSUNI_MEDIA_HOSTS list; CommsUni's own
per-source host registration still applies. Show/movie/list card comments remain local and excluded
from backfill so their rich links remain intact inside TV Watch Time.

## Public image check

MinIO remains private and encrypted. CommsUni receives the stable public API URL
https://PUBLIC-API-HOST/api/comment-images/IMAGE_ID. The API decrypts and streams WebP/GIF; partners
need neither an app token nor an encryption key.

Before applying a manifest with images:

- Set API_BASE_URL to the public HTTPS API address, optionally including /api.
- Add its hostname to COMMSUNI_MEDIA_HOSTS and register that exact host with the operator.
- Open a ready image from the preview anonymously. Check HTTP 200, image/webp or image/gif, and
  actual image bytes rather than JSON, ciphertext, or a login page.
- Allow that public image route through the proxy. Do not expose the MinIO bucket.
- Retain the bucket and encryption master key for stable delivery.

Readiness includes an example URL and local hostname check, not proof of external reachability.
Deleted/hidden comments must stop serving their images.

## Dry run (no database or provider mutations)

Use an administrator JWT for **our API**, via `COMMSUNI_ADMIN_TOKEN` in the operator environment.
Never put the provider key or token in command-line arguments, the client app, a manifest or source
control. Use a private folder for manifests: they contain comment text and author presentation.
The script requests restrictive file modes; on Windows also use a folder with appropriate NTFS access.

From the repository root:

```powershell
node apps/api/scripts/commsuni-backfill.mjs --api-url https://YOUR-BACKEND/api --manifest C:\private\commsuni-run.json
```

Include the same API prefix used by the deployed app. HTTP is accepted only on loopback.
The script generates one run UUID and fixed cutoff, pages through the candidates, and saves each
page. Repeating the command resumes that same manifest. It does not start NestJS, a worker or Prisma.
Preview may consume metered provider/metadata reads; the resolver does not persist media bindings.
It does not search for matching original text. Generate the preview with the corrected API after
deployment; older semantic-fingerprint proofs are not silently rebased.

Review `sourceCounts`, every eligible payload/author/TVDB reference, and all excluded/blocked reasons.
Eligibility requires MANUAL provenance with no import source key/audit record, no copy lineage/ledger,
and no existing submission. The server signs each reviewed row with a proof tied to the run,
cutoff, content, author ID and mapping. Changed content or destinations cannot silently enter
the approved batch. Rows created after the fixed cutoff are outside this run.

Do not erase a started manifest to force a new export. Retain all manifests/checkpoints and server
mappings permanently for dedupe. To omit a reviewed eligible row, remove that row from the reviewed
list deliberately; do not invent a proof. Resolve blocked or ambiguous rows before any later,
separately reviewed preview.

## Apply later, after explicit production authorization

After approval of the reviewed manifest and the wider audience for historical comments, configure
both write switches on. Check `GET /admin/commsuni/backfill/readiness` (ADMIN role).
Its schema/configuration checks do not prove provider scopes, host approval or remaining paid quota.

```powershell
node apps/api/scripts/commsuni-backfill.mjs --api-url https://YOUR-BACKEND/api --manifest C:\private\commsuni-run.json --apply --acknowledge-historical-sharing
```

The script sorts parents before children, admits five comments at a time and waits for their
acknowledgments. The server bounds unfinished backfill work to 100 rows across concurrent
operators. Existing operations are reused via permanent `comment:<local-id>` dedupe keys;
no replacement ID is created. The worker stores the exact body/path and one POST idempotency
key before transmission, verifies mappings again, and preserves original timestamps.

A failed/changed/deferred/uncertain/paused/review-required row stops the script with a nonzero exit.
It saves checkpoints, remote IDs and administrator error details without dumping comment bodies
into console output. Repeating the same apply command resumes the same operation identities.
A lost POST response must be resolved within the provider's 24-hour ledger window; the worker
parks ambiguous POSTs at 23 hours as `UNCERTAIN`. Never reset that state/key or restart the export
to bypass uncertainty; reconcile with the provider first.

Stopping the script stops further admission, but already queued work can still deliver.
Turn off the separate backfill flag and reload all API workers to park remaining historical work.
Turn off the global write flag to pause all outbound actions, including deletion cleanup.

## Report, finish and correction

```powershell
node apps/api/scripts/commsuni-backfill.mjs --api-url https://YOUR-BACKEND/api --manifest C:\private\commsuni-run.json --report
```

The report endpoint paginates by delivery sequence and includes every local-to-remote mapping in
the run. `deliveryComplete` means all eligible rows selected in that manifest were acknowledged;
excluded or blocked preview rows were not sent. Keep their counts in the rollout report.

Spot-check provider GETs for correct TVDB title, parent/reply placement, original time, source badge,
identity and initial attachments. Then disable the backfill flag, keep live writes only if approved,
and tell the provider the migration is finished. No real-title write smoke tests.

There is no bulk rollback. Wrongly sent comments need individual DELETEs under each original actor.
Do not delete identity/outbox/mapping records before cleanup finishes. Deleting the local manifest
does not delete provider comments, and changing the actor secret is not an undo mechanism.
