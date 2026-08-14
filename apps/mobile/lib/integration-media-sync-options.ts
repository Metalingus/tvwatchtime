import type { IntegrationDto, IntegrationProvider } from '@tvwatch/shared';

type IntegrationSyncAvailability = Pick<
  IntegrationDto,
  'provider' | 'connected' | 'paused' | 'itemsDisabled'
>;

export interface IntegrationMediaSyncOption {
  provider: IntegrationProvider;
  disabled: boolean;
}

export function getConnectedIntegrationSyncOptions(
  integrations: readonly IntegrationSyncAvailability[],
): IntegrationMediaSyncOption[] {
  return integrations
    .filter((integration) => integration.connected)
    .map((integration) => ({
      provider: integration.provider,
      disabled: integration.paused || integration.itemsDisabled,
    }));
}
