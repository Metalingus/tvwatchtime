import { useEffect, useMemo } from 'react';
import { AppState, InteractionManager } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { invalidateIntegrationData } from '../api/integration-cache';
import { createIntegrationForegroundSyncCoordinator } from '../lib/integration-foreground-sync';

export function useIntegrationForegroundSync(userId: string | null) {
  const queryClient = useQueryClient();
  const coordinator = useMemo(
    () =>
      createIntegrationForegroundSyncCoordinator({
        storage: AsyncStorage,
        sync: async () => {
          await api.post('/integrations/foreground-sync');
          invalidateIntegrationData(queryClient);
        },
      }),
    [queryClient],
  );

  useEffect(() => {
    if (!userId) return;
    let active = true;
    const run = () => {
      if (active) void coordinator.run(userId).catch(() => undefined);
    };
    const initial = InteractionManager.runAfterInteractions(run);
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') run();
    });
    return () => {
      active = false;
      initial.cancel();
      subscription.remove();
    };
  }, [coordinator, userId]);
}
