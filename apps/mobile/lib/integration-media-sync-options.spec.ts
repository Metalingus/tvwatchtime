import { getConnectedIntegrationSyncOptions } from './integration-media-sync-options';

describe('getConnectedIntegrationSyncOptions', () => {
  it('shows every connected integration and preserves its sync availability', () => {
    expect(
      getConnectedIntegrationSyncOptions([
        { provider: 'SIMKL', connected: true, paused: false, itemsDisabled: false },
        { provider: 'STREMIO', connected: true, paused: true, itemsDisabled: false },
        { provider: 'JELLYFIN', connected: true, paused: false, itemsDisabled: true },
        { provider: 'PLEX', connected: true, paused: false, itemsDisabled: false },
        { provider: 'EMBY', connected: true, paused: false, itemsDisabled: false },
      ]),
    ).toEqual([
      { provider: 'SIMKL', disabled: false },
      { provider: 'STREMIO', disabled: true },
      { provider: 'JELLYFIN', disabled: true },
      { provider: 'PLEX', disabled: false },
      { provider: 'EMBY', disabled: false },
    ]);
  });

  it('omits integrations that are not connected', () => {
    expect(
      getConnectedIntegrationSyncOptions([
        { provider: 'SIMKL', connected: false, paused: false, itemsDisabled: false },
        { provider: 'JELLYFIN', connected: true, paused: false, itemsDisabled: false },
      ]),
    ).toEqual([{ provider: 'JELLYFIN', disabled: false }]);
  });
});
