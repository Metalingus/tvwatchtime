import { getConnectedIntegrationSyncOptions } from './integration-media-sync-options';

describe('getConnectedIntegrationSyncOptions', () => {
  it('shows every connected integration and preserves its sync availability', () => {
    expect(
      getConnectedIntegrationSyncOptions([
        { provider: 'SIMKL', connected: true, paused: false, itemsDisabled: false },
        { provider: 'STREMIO', connected: true, paused: true, itemsDisabled: false },
        { provider: 'JELLYFIN', connected: true, paused: false, itemsDisabled: true },
      ]),
    ).toEqual([
      { provider: 'SIMKL', disabled: false },
      { provider: 'STREMIO', disabled: true },
      { provider: 'JELLYFIN', disabled: true },
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
