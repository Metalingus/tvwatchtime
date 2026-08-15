# Inbound user-data integrations

TVWatch can connect to SIMKL, Stremio, Jellyfin, Plex, and Emby and import supported user activity. The
direction is intentionally one-way: TVWatch reads provider data and never writes TVWatch changes
back to a provider.

## Capability mapping

| Provider | Imported data                                                                                                               | Deliberately not inferred                                            |
| -------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| SIMKL    | Watched episodes/movies, watchlist and show tracking states, ratings                                                        | Favorites (not exposed by the sync response)                         |
| Stremio  | Watched episodes/movies and active library items as watchlist items                                                         | Favorites and ratings                                                |
| Jellyfin | Played episodes/movies, favorites as watchlist, BoxSets as private lists                                                    | The whole media library as a watchlist; partial playback as watched  |
| Plex     | Server-played movies/episodes, account Watchlist and its watched episodes, collections and video playlists as private lists | The whole server library as a watchlist; partial playback as watched |
| Emby     | Played episodes/movies, favorites as watchlist, BoxSets as private lists                                                    | The whole media library as a watchlist; partial playback as watched  |

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

- **Collections** is available for Jellyfin, Plex, and Emby and defaults to on. For Plex, the same
  setting also controls video playlists. Turning it off skips collection, playlist, and BoxSet
  requests as applicable; the next successful sync removes only that provider's imported private
  lists and keeps manual lists.
- **Pause sync** stops manual and scheduled sync without hiding existing imported data.
- **Preferred client** controls Open in routing for Jellyfin and Emby. Changing it does not clear the
  sync cursor or trigger a library re-import.
- **Disable all synced items** removes the provider's active contributions but retains its ownership
  ledger. Enabling items performs a fresh sync and restores contributions still present upstream.
- **Delete all synced items** removes provider-owned contributions and forgets its ledger. Sync is
  disabled until the user explicitly enables it again.
- **Disconnect** removes stored credentials but retains provenance and Advanced settings whenever
  synced contributions remain, allowing cleanup after disconnect.

These controls affect TVWatch only. They never modify the connected provider.

Connection/authorization returns as soon as credentials and any server selection are saved. The
mobile client then starts the first sync as a separate visible operation, so a large media-server
scan does not leave the authorization control loading. Users can request Sync now at any time. The DB-managed
`inbound_integrations` scheduled job refreshes stale Stremio, Jellyfin, Plex, and Emby accounts in bounded batches
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
  stored. New connections also retain the server ID used by Swiftfin links; older connections
  resolve and cache it on their first eligible iOS Open in request. The token, Stremio auth key, and
  SIMKL token are encrypted at rest with
  ENCRYPTION_MASTER_KEY.
- Emby exchanges the submitted username/password for a user access token. The password is discarded;
  the access token, user ID, and server ID are encrypted at rest.
- Plex uses the strong PIN browser flow. After authorization, users select one accessible Plex Media
  Server when their account exposes more than one. The account token and selected machine identifier
  are encrypted at rest.

Jellyfin favorites intentionally map to TVWatch watchlist items because Jellyfin does not expose a
separate watchlist state. A successful sync also imports every Jellyfin BoxSet as a provider-owned
private list and matches its movie/series children through the normal trusted-ID import path.
Existing Jellyfin-owned favorites created by older TVWatch builds are removed on the next successful
Jellyfin fetch; manual favorites are preserved. Media pages show connected Stremio, Jellyfin, Plex,
and Emby launchers under the shared Open in heading. Jellyfin opens the matched item detail page when
a synced item ID is known. For untouched library items it searches Jellyfin by trusted external ID,
then exact title/year; it opens the connected server root only when no item can be resolved. On Apple
devices, Automatic and Swiftfin use Swiftfin's verified item route with Jellyfin Web as fallback.
Jellyfin's official mobile clients do not currently expose a dependable cross-platform item route,
so Android and web use Jellyfin Web. Emby's Automatic and Emby app choices use its platform-specific
native item route on iOS and Android, with Emby Web as fallback. Desktop/web always uses the web
target. A native client must already be configured for and signed into the same server.
Plex resolves an IMDb or TMDb ID through Plex's metadata provider and opens the resulting
`https://watch.plex.tv/movie/...` or `/show/...` universal link. The installed Plex app can claim
that link; otherwise it remains a normal Plex web details page. TVWatch omits the Plex launcher when
Plex cannot resolve a safe item link instead of falling back to the server-specific Plex Web route.

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

Plex and Emby successful syncs are complete, paged snapshots for the provider surfaces they report.
Plex scopes server history, collections, video playlists, account Watchlist membership, and each
account show's watched episodes by stable source-key prefixes, so one independently fetched surface
cannot retract another. Plex account show metadata supplies watched episodes for watchlisted shows
even when the selected server has no TV library. Discover requests deliberately omit PMS container
pagination headers because Plex's Watchlist endpoint rejects them. A Watchlist failure fails the sync
instead of reporting a misleading successful zero; a failed per-show episode request preserves that
show's prior snapshot.

Plex media items are eligible for matching only when Plex supplies an IMDb, TMDb, or TVDb GUID.
Items without one of those trusted identities are skipped without attempting title/year matching.
The next successful sync also retracts any Plex-owned rows that an older TVWatch build created from
title fallback, while preserving manual and other-provider ownership. Libraries using Plex's
`tv.plex.agents.none` agent do not expose these external IDs, so their items remain skipped until a
metadata agent supplies one.

## Media server URL safety

Production defaults reject loopback, link-local, and private Jellyfin, Plex, and Emby targets to
prevent SSRF. Self-hosted deployments that intentionally reach a LAN media server can set
ALLOW_PRIVATE_INTEGRATION_URLS=true. Without that opt-in, public media servers must use HTTPS and
redirects are rejected.

## Database/release notes

The 20260813140000_inbound_integrations migration adds user_integrations and provider values to
ListSource. The 20260813220000_integration_sync_controls migration adds granular settings,
pause/disable state, source ownership columns, and the integration contribution ledger. It also
backfills provider-owned rows from completed import audit records. Applying either migration to a
shared database remains a separately approved deployment step.

The 20260814120000_plex_emby_integrations migration adds PLEX and EMBY to IntegrationProvider and
ListSource. It is additive and, like every shared-database migration, must be applied separately
during deployment.
