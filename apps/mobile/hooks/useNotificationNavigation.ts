import { useEffect } from 'react';
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import type {
  AnnouncementAction,
  AnnouncementActionParams,
  AnnouncementTarget,
} from '@tvwatch/shared';
import { runAnnouncementAction, navigateFromLink } from '../lib/announcement';

/**
 * Listens for push-notification taps and navigates to the configured action
 * (whitelisted target) or a legacy `link`/deep-link. Registered once at the root.
 */
export function useNotificationNavigation() {
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data as
        Record<string, unknown> | undefined;
      if (!data) return;

      // Action-driven navigation (announcements + broadcasts).
      if (data.actionTarget && data.actionTarget !== 'none') {
        const action: AnnouncementAction = {
          type: (data.actionType as AnnouncementAction['type']) || 'navigate',
          target: data.actionTarget as AnnouncementTarget,
          params: data.actionParams as AnnouncementActionParams | undefined,
        };
        runAnnouncementAction(action);
        return;
      }

      // Legacy link / deep-link field.
      const link = typeof data.link === 'string' ? data.link : null;
      navigateFromLink(link);
    });
    return () => sub.remove();
  }, []);
}
