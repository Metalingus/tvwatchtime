// Configurable in-app announcements + broadcast pushes.
// Admin authors per-locale text (English required, others fall back to it).
// Actions are a closed whitelist of navigation targets so the admin cannot
// inject arbitrary routes — used by both banner taps and push deep-link taps.

import type { NotificationCategory } from './enums';

/** Whitelisted navigation targets an announcement/broadcast action can resolve to. */
export const ANNOUNCEMENT_TARGETS = [
  'none',
  'import',
  'explore',
  'my-lists',
  'followed-lists',
  'stats',
  'settings',
  'notifications',
  'show',
  'list',
  'external',
] as const;

export type AnnouncementTarget = (typeof ANNOUNCEMENT_TARGETS)[number];

export type AnnouncementActionType = 'none' | 'navigate' | 'external';

export interface AnnouncementActionParams {
  /** Required when target === 'show'. */
  showId?: string;
  /** Required when target === 'list'. */
  listId?: string;
  /** Required when target === 'external'. */
  url?: string;
}

export interface AnnouncementAction {
  type: AnnouncementActionType;
  target?: AnnouncementTarget;
  params?: AnnouncementActionParams;
}

/** Per-locale text map. `en` is always required and is the fallback. */
export type LocaleText = Record<string, string>;

export interface AnnouncementDto {
  id: string;
  revision: number;
  icon: string;
  title: LocaleText;
  message: LocaleText;
  actionLabel: LocaleText | null;
  action: AnnouncementAction;
}

/** Payload broadcast pushes carry in their `data` so the app can navigate on tap. */
export interface BroadcastPushData {
  category: NotificationCategory;
  actionType?: AnnouncementActionType;
  actionTarget?: AnnouncementTarget;
  actionParams?: AnnouncementActionParams;
  broadcastId?: string;
  announcementId?: string;
}

/** Resolve an action to a mobile route path (expo-router) or an external URL.
 *  Returns null for `none`. Callers use `isExternalAction` to decide between
 *  router.push (route) and Linking.openURL (external URL). Shared so the API
 *  (in-app notification `link`) and the mobile navigator stay in sync. */
export function announcementActionToRoute(
  action: AnnouncementAction | null | undefined,
): string | null {
  if (!action || action.type === 'none') return null;
  if (action.type === 'external') return action.params?.url ?? null;
  switch (action.target) {
    case 'import':
      return '/import';
    case 'explore':
      return '/(tabs)/explore';
    case 'my-lists':
      return '/my-lists';
    case 'followed-lists':
      return '/followed-lists';
    case 'stats':
      return '/stats';
    case 'settings':
      return '/more';
    case 'notifications':
      return '/notifications';
    case 'show':
      return action.params?.showId ? `/show/${action.params.showId}` : null;
    case 'list':
      return action.params?.listId ? `/list/${action.params.listId}` : null;
    default:
      return null;
  }
}

export function isExternalAction(action: AnnouncementAction | null | undefined): boolean {
  return !!action && action.type === 'external';
}
