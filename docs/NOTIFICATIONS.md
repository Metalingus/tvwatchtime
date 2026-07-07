# Notification Architecture

See `docs/DOCUMENTATION.md` → Section 12 for full details.

## Pipeline
```
Event (episode airs / badge / follow / like)
  → NotificationService.createForUser()
    → Checks: feature flag (push_notifications), user prefs (per-category), daily push limit
    → In-app: create Notification row (deduped by userId + dedupeKey)
    → Push: create PushNotificationJob (scheduledFor = airDate or now)
  → PushService.dispatchDue() [every 5 min]
    → Firebase Admin (FCM/APNs) or Expo Push API
    → Mark DELIVERED / FAILED
```

## Episode Notification Rules
1. **Season premiere** (episode 1) → always notified
2. **Show watched within 30 days** → notified
3. **Show not watched 30+ days** → skipped
4. **Daily push limit** (default 3) → once exceeded, in-app only
5. **Priority sorting** → premieres first, then most recently watched

## Delivery Channels
- **Expo Go:** Expo Push API (configured, working)
- **Production:** Firebase Admin SDK → FCM (Android) + APNs (iOS)

## Push Modes (for self-hosted backends)
| Mode | Config | How it works |
|------|--------|-------------|
| `expo` (default) | `EXPO_ACCESS_TOKEN` set | Backend sends directly via Expo Push API |
| `relay` | `PUSH_MODE=relay` + `PUSH_RELAY_URL` | Backend sends to public relay → public server delivers via Expo |
| `none` | `PUSH_MODE=none` | No push delivery (in-app only) |

## Self-Hosted Push Flow
1. Mobile app generates Expo push token using the public EAS projectId (`app.json → extra.eas.projectId` — constant, never overridden)
2. Token registered with self-hosted backend via `POST /devices/register`
3. Self-hosted backend sends push → calls `PUSH_RELAY_URL/push/relay`
4. Public server delivers via Expo Push API
5. Phone receives notification (regardless of which backend the user is connected to)

## Push Relay (public instance)
- `POST /api/push/relay` — public, no auth
- Accepts: `{ token, title, body, data }`
- Rate limited per token via Redis: `PUSH_RELAY_RATE_LIMIT` (default 10 per `PUSH_RELAY_RATE_WINDOW_MINUTES` default 10 min)
- Configurable in admin settings

## Mobile URL Configuration
| Source | Used When | How |
|--------|-----------|-----|
| SecureStore (self-hosted) | User checked "Self-hosted backend" | `getBaseUrl()` in `apps/mobile/api/client.ts` |
| `app.json → extra.apiBaseUrl` | Default (public instance) | Fallback when SecureStore is empty |
| `app.json → extra.eas.projectId` | Always (EAS push token gen) | Constant — never overridden |
| `app.json → extra.publicApiUrl` | Always (push relay target) | Constant — never overridden |

## DB-Managed Crons
All editable in admin console → Scheduled Jobs page:
| Job | Default | Configurable |
|-----|---------|-------------|
| Episode notifications | Hourly | ✅ |
| Push dispatch | Every 5 min | ✅ |
| Watchlist reminders | Daily 3 AM | ✅ |
| TVmaze refresh | Daily 3 AM | ✅ |
| Scheduled hydrations | Hourly | ✅ |
