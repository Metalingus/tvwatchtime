# Inbound user-data integrations

TVWatch can connect to SIMKL, Stremio, and Jellyfin and import supported user activity. The
direction is intentionally one-way: TVWatch reads provider data and never writes TVWatch changes
back to a provider.

## Capability mapping

| Provider | Imported data                                                            | Deliberately not inferred                                           |
| -------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| SIMKL    | Watched episodes/movies, watchlist and show tracking states, ratings     | Favorites (not exposed by the sync response)                        |
| Stremio  | Watched episodes/movies and active library items as watchlist items      | Favorites and ratings                                               |
| Jellyfin | Played episodes/movies, favorites as watchlist, BoxSets as private lists | The whole media library as a watchlist; partial playback as watched |

Imports reuse the normal import apply pipeline and record per-provider contribution ownership.
Manual TVWatch actions promote a row to `MANUAL`, and TV Time imports are authoritative for watched
history. A later provider sync never overwrites either source. When one provider is disabled or
deleted, a matching contribution from another enabled provider takes ownership; otherwise only the
row still owned by the selected provider is removed.

## Advanced settings and data lifecycle

Each provider exposes an expandable Advanced settings section. Supported item types default to on
for both movies and shows; unsupported settings remain visible but disabled so the limitation is
explicit. Changing item filters clears the provider cursor so the next sync re-evaluates the full
account.

- **Pause sync** stops manual and scheduled sync without hiding existing imported data.
- **Disable all synced items** removes the provider's active contributions but retains its ownership
  ledger. Enabling items performs a fresh sync and restores contributions still present upstream.
- **Delete all synced items** removes provider-owned contributions and forgets its ledger. Sync is
  disabled until the user explicitly enables it again.
- **Disconnect** removes stored credentials but retains provenance and Advanced settings whenever
  synced contributions remain, allowing cleanup after disconnect.

These controls affect TVWatch only. They never modify SIMKL, Stremio, or Jellyfin.

Connection runs an initial sync, and users can request Sync now at any time. The DB-managed
`inbound_integrations` scheduled job refreshes stale Stremio and Jellyfin accounts in bounded batches
every six hours by default; its schedule remains editable in the admin Scheduled Jobs page. SIMKL is
deliberately excluded from this unconditional timer. The authenticated mobile client requests one
foreground sync on app launch and whenever it returns to the active state. Both the device and backend
throttle lifecycle attempts to once per 15 minutes; eligible integrations run sequentially, and SIMKL
still checks activities before requesting a delta. Connection and Sync now remain explicit,
unthrottled user overrides for every provider.

## Connections and credentials

- SIMKL uses the documented PIN authorization flow. `SIMKL_CLIENT_ID` must be configured.
- Stremio uses its device-link flow and reads the libraryItem datastore collection.
- Jellyfin exchanges the submitted username/password for an access token. The password is not
  stored. The token, Stremio auth key, and SIMKL token are encrypted at rest with
  ENCRYPTION_MASTER_KEY.

Jellyfin favorites intentionally map to TVWatch watchlist items because Jellyfin does not expose a
separate watchlist state. A successful sync also imports every Jellyfin BoxSet as a provider-owned
private list and matches its movie/series children through the normal trusted-ID import path.
Existing Jellyfin-owned favorites created by older TVWatch builds are removed on the next successful
Jellyfin fetch; manual favorites are preserved. Media pages show connected Stremio and Jellyfin
launchers under the shared Open in heading. Jellyfin opens the matched item detail page when a synced
item ID is known. For untouched library items it searches Jellyfin by trusted external ID, then exact
title/year; it opens the connected server root only when no item can be resolved.

SIMKL's initial sync requests `/sync/all-items/shows`, `/sync/all-items/movies`, and
`/sync/all-items/anime` separately and sequentially without `date_from`, then saves the exact
`/sync/activities` `all` timestamp. Later syncs check activities first, skip unchanged accounts, and
use one combined `/sync/all-items?date_from=...` request only when the timestamp changed. Activity
checks are throttled to 15 minutes unless the user presses Sync now. Every SIMKL request includes
`client_id`, `app-name`, `app-version`, and a User-Agent. Stremio watched bitfields are decoded against
the official Cinemeta video order.

SIMKL show state is authoritative when returned by a sync: hold sets TVWatch's paused state,
dropped sets Dropped, and watching/plan-to-watch/completed clear both flags. These writes
deliberately override manual TVWatch state. They are not contribution-owned and therefore remain
unchanged when SIMKL items are disabled or the integration is disconnected.

## Jellyfin URL safety

Production defaults reject loopback, link-local, and private Jellyfin targets to prevent SSRF.
Self-hosted deployments that intentionally reach a LAN Jellyfin server can set
ALLOW_PRIVATE_INTEGRATION_URLS=true. Without that opt-in, public Jellyfin servers must use HTTPS
and redirects are rejected.

## Database/release notes

The 20260813140000_inbound_integrations migration adds user_integrations and provider values to
ListSource. The 20260813220000_integration_sync_controls migration adds granular settings,
pause/disable state, source ownership columns, and the integration contribution ledger. It also
backfills provider-owned rows from completed import audit records. Applying either migration to a
shared database remains a separately approved deployment step.
