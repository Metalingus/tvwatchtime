import type { QueryClient } from '@tanstack/react-query';

export function invalidateIntegrationData(queryClient: QueryClient) {
  queryClient.invalidateQueries({ queryKey: ['integrations'] });
  queryClient.invalidateQueries({ queryKey: ['integrationOpenTargets'] });
  queryClient.invalidateQueries({ queryKey: ['watchNext'] });
  queryClient.invalidateQueries({ queryKey: ['upcoming'] });
  queryClient.invalidateQueries({ queryKey: ['showsByStatus'] });
  queryClient.invalidateQueries({ queryKey: ['movies'] });
  queryClient.invalidateQueries({ queryKey: ['watchlist'] });
  queryClient.invalidateQueries({ queryKey: ['favorites'] });
  queryClient.invalidateQueries({ queryKey: ['history'] });
  queryClient.invalidateQueries({ queryKey: ['forYou'] });
  queryClient.invalidateQueries({ queryKey: ['lists'] });
  queryClient.invalidateQueries({ queryKey: ['myLists'] });
}
