# Push Delivery — Registration, Timing & Timezones

Deep operational reference for mobile push internals. Relocated from `AGENTS.md`.
Summaries: `docs/NOTIFICATIONS.md`, `docs/DOCUMENTATION.md` §12 and §23.
Read this file BEFORE touching push registration, scheduling, or notification navigation handling.

## Non-negotiable invariants

- Register notification-tap handling exactly once at the app root; never add a second response listener.
- Compute delivery dates and catch-up behavior in the user's IANA timezone with DST-safe helpers.
- Device registration must continue updating timezone data for existing mobile and web subscriptions.
- Keep registration, tap navigation, and delivery scheduling as separate responsibilities.

## Registration & tap handling

- `usePushNotifications(enabled)` hook in `apps/mobile/hooks/usePushNotifications.ts` (registration only — notification TAP handling lives exclusively in `useNotificationNavigation` at the app root; never add a second response listener, duplicate pushes result).
- Called from `(tabs)/_layout.tsx` with `enabled = !!user`.

## Delivery modes

- Expo Go: works via Expo Push API with `EXPO_ACCESS_TOKEN`.
- Dev build: requires Firebase `google-services.json` in `android/app/` + gradle plugins in both `build.gradle` files.
- Self-hosted: `PUSH_MODE=relay` sends through public server's `/api/push/relay` endpoint.
- Web push (PWA): requires `VAPID_PUBLIC_KEY` + `VAPID_PRIVATE_KEY` (a matching pair — `npx web-push generate-vapid-keys`) and optional `VAPID_SUBJECT` (must be a `mailto:`/`https:` URI). Missing/mismatched keys → every web send fails with a bare "Received unexpected response code" (401, unsigned). A PushSubscription is bound to the `applicationServerKey` it was created with: after rotating VAPID keys the web app detects the mismatch on next start, unsubscribes and resubscribes (`useWebPush`). The admin test push (`POST /admin/users/:id/test-push`) goes through the full `PushService.sendToDevices` pipeline (web/FCM/Expo/relay), so it exercises the same path broadcasts use; web-push failures log the HTTP status code + response body.

## Import completion

- Import processing schedules one deduplicated SYSTEM notification when the import becomes `READY_FOR_REVIEW`. Its deep link is `/import?importId=<id>`, and the import screen accepts that route parameter so notification taps open the correct review directly.
- Import notification creation uses `NotificationService.createForUser`, so the global push feature flag, user SYSTEM preferences, daily push cap, registered-device delivery, and in-app fallback all remain authoritative. Notification failures are logged and do not fail the import.

## Episode notification timing (per-user timezone spread)

- Episode dates come from the persisted structural owner. TMDB-owned rows are refreshed by TMDB Changes; tracked/watchlisted TVDB-owned RETURNING rows are refreshed by the bounded hourly `tvdb_schedule_refresh` cursor. With TVmaze disabled, TMDB/TVDB date-only values are compared as provider calendar dates against the user's local day, not interpreted as UTC-midnight broadcast instants. The legacy `refresh_airtimes` job exits before scanning when TVmaze is disabled.
- Episode notifications spread across afternoon (noon→3pm→4pm...), computed **per user in their device timezone** (devices register with `timezone` from `Intl.DateTimeFormat().resolvedOptions().timeZone`; latest active device wins, then `NotificationPreference.timezone`, then server tz). "Today" is the user's local day (`common/utils/timezone.util.ts` — Intl-based, DST-safe). Devices re-register on every app start, which also backfills tz for pre-feature users — including WEB (`useWebPush` re-registers even when a PushSubscription already exists; the old early-return left pre-tz web devices at tz=NULL forever). A slot that already passed fires +10min when it's before 21:00 local, and DEFERS to the next day's first spread slot (user tz) at/after 21:00 local (`catchUpPushAt`) — notifications are NEVER skipped and never land as midnight "airs today" pushes (quiet-hours prefs exist but are NOT enforced anywhere).
