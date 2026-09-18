# Release dates and notification frequency

## Date semantics

Known broadcast timestamps (`airDate` with `airTime`) become eligible at the
actual instant, regardless of viewer timezone. Displays convert that instant and
its time to the device timezone. TMDB/TVDB date-only values retain their provider
calendar date; UTC midnight storage is never treated as a broadcast instant.
When no time is supplied, eligibility starts on that date in the viewer timezone.
This fallback does not establish streaming-service/country-specific availability.

The shared release-date helper is used by API and mobile eligibility. Prisma and
SQL helpers use the equivalent split. Watch Next, paused rails, upcoming groups,
show/season progress, bulk actions, and metadata/import progress calculations use
these rules. Undated official episodes retain their existing progress treatment,
but Watch Next and positive bulk actions require a known date. Viewing-history
timestamps and explicit watched records are not rewritten.

## Timezones and freshness

New mobile/web requests send X-TVWatch-Timezone; iOS widgets send the device zone
directly and Android widgets use the app client. The API validates the IANA zone
and isolates it in request context. Older clients use the latest active registered
device timezone, then notification preferences, then UTC. Background jobs without
an explicit user timezone also fall back to UTC.

Library cache keys include timezone and calendar day without changing invalidation
prefixes. Watch Next responses carry an optional refreshAt for the next known
broadcast, and the cache rejects that snapshot once the boundary passes.
The app refreshes date-sensitive queries at local midnight, known broadcast times,
and timezone changes on foregrounding; it does not poll providers. Persisted
mobile query caches are versioned to discard old date interpretations.

Upcoming cards, episode details/history, and Android/iOS widget dates preserve
date-only calendar days. Actual broadcast dates/times are localized together.
Provider refreshes that replace timestamps with date-only values clear stale
airTime markers; TVmaze enrichment is retired and cannot repopulate them. TVDB's series schedule is now ingested for both TVDB-owned and TMDB-owned shows
with a stored TVDB series identity. The canonical episode date remains separate
from the derived UTC instant until persistence. Conversion follows
[TVDB's airtime convention](https://support.thetvdb.com/kb/faq.php?id=29):
The documented streaming networks (Apple TV, Netflix, Disney+, Hulu, etc.) use
US Eastern independently of the show's production country. Prime's documented
official GMT date uses midnight UTC. Other series use the mapped source-country
capital/major-city IANA zone. DST rules apply. Production country is not the
release timezone for those global streaming services.
This is a series-schedule derivation, not an episode-specific or regional
streaming availability guarantee. Unknown countries/times and ambiguous or
nonexistent DST wall times remain date-only.

Episodes missing only an airtime are eligible for the interactive metadata queue,
including empty-string legacy values. Targeted repairs re-fetch the canonical episode date and preserve viewing history.
They also recognize the exact timestamp pattern produced by the old
production-country streaming rule; only an exact match to the provider's current
episode date is corrected. Other nonempty clocks remain untouched.
Correct clocks are skipped using the cached schedule, so the correction selector
does not continuously enqueue healthy episodes.
Library overlays refresh both date and time; changed instants invalidate the
reader's cached rails/progress and recompute membership once. Mobile merges the
new clock in place and invalidates upcoming/progress queries when work completes.

## Notification limits

- At most one episode notification per show, per user, per local release day.
  A season premiere is preferred; otherwise use the first episode in sequence.
- A separate delivery-day key prevents late-night deferred alerts and the next
  day's episodes producing two pushes for the same show on one local day.
- Scheduler reruns and replicas serialize admission using a per-user PostgreSQL
  advisory transaction lock. Inbox records and push-job payload keys both provide
  deduplication, including push-only preferences.
- Inactivity reminders have a 72-hour per-user cooldown across all shows.
  The daily job remains an eligibility scan; changing its persisted cron is not
  necessary. Per-show rotation remains in effect.
- Reminder eligibility uses the recipient timezone. Daily push budgets use the
  scheduled delivery day in that timezone, not the API server's calendar day.

## Validation and release

Focused mocked API/mobile tests cover west/east timezone boundaries, exact
broadcast instants, DST, request isolation/legacy clients, SQL predicates,
library cache expiry, bulk/progress consumers, season drops, reruns, deferred
delivery, and push-only reminder cooldowns.

No schema migration is needed. Existing missing clocks fill during normal hydration\nor queued visible-episode refresh after release; this change is not a bulk backfill. No production data or
existing queued notifications was changed. Already queued old notifications are
not retroactively canceled by these source changes.

Release requires an API image rebuild/deployment, a fresh Expo web export for web,
and a new native app/widget build for native display/refresh changes. Builds,
exports, deployment, live database/provider checks, and native iOS compilation
were not performed in this Windows session.

## Streaming-country correction (2026-09-18)

The initial converter incorrectly interpreted Slow Horses' British production
country as the timezone of Apple TV's midnight release. That produced
2026-09-15T23:00Z instead of 2026-09-16T04:00Z for S6E1, and the same five-hour
error for the rest of season six. TVDB's network response identifies Apple TV as
a US network and its airtime convention lists midnight for Apple TV.
[Apple's premiere announcement](https://www.apple.com/tv-pr/news/2026/09/apple-tv-hosts-world-premiere-for-the-sixth-season-of-slow-horses-at-tiff/)
independently confirms September 16; it does not specify an exact hour.
The stored scheduled time follows TVDB's convention, not unverified early-access
reports or a claim that every regional streaming catalog is available then.

Schedule cache v2 and episode-task cache v3 discard the incorrect cached rule.
The corrected source service repaired all six season-six episodes in the local
Docker database. S6E1 maps to September 16 at 00:00 in America/Toronto; S6E2 maps
to September 23 at 00:00. User episode watch records were checked unchanged.
Production repair/deployment requires explicit approval.

Validation also exercised the real source ShowsController response and mobile
formatters using the corrected stored episode: Toronto September 16 at 12 AM,
Los Angeles September 15 at 9 PM, London September 16 at 5 AM. Eligibility changes
at exactly 04:00 UTC in all three cases. The full app browser check could not run
because the local web/API development servers were stopped; no native check,
build, export, or deployment was performed for this correction.

## Native startup crash correction (2026-09-18)

The Android release crash at bundle offset 2679799 was symbolicated with the
existing release source map to useReleaseClock.ts:65: window.addEventListener.
React Native defines window as the native global; its presence does not establish
browser event support. The root layout ran this effect at startup and threw.

The hook now registers DOM focus listeners only on web after checking both event
methods. Android/iOS use the existing AppState subscription; cleanup uses the same
captured browser target. Regression tests reproduced the crash before the change
and pass for Android/iOS startup, cleanup, native foreground release transitions,
web focus, and a headless window without event methods. This is an app-bundle fix
requiring a new APK/native release; it does not require an API/database change.
No APK build, installation, or physical-device launch verification was run here.
