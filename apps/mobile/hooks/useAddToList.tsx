import React, { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { api } from '../api/client';
import {
  useAddListItem,
  useDropMedia,
  useIntegrations,
  useRemoveListItem,
  useSyncIntegration,
  useToggleTrackingPause,
} from '../api/hooks';
import { dismissAllDialogs, showConfirm, showDialog, showError } from '../lib/dialog';
import { getConnectedIntegrationSyncOptions } from '../lib/integration-media-sync-options';
import { showToast } from '../lib/toast';
import { PosterImage, T } from '../components/primitives';
import { IntegrationIcon } from '../components/IntegrationIcon';
import { useAppearance } from '../context/PreferencesProvider';
import { radius, spacing } from '../theme/theme';
import { useReassign } from './useReassign';

interface MyList {
  id: string;
  title: string;
  coverUrl?: string | null;
  showCount?: number;
  movieCount?: number;
  /** Present only when /me/lists was queried with ?mediaId= (add-to-list picker). */
  containsMedia?: boolean;
  itemId?: string | null;
}

interface ListPickerContentProps {
  lists: MyList[];
  onAdd: (listId: string) => Promise<string | null>;
  onRemove: (listId: string, itemId: string) => Promise<void>;
}

/** List rows inside the picker dialog: cover, title, show/movie counts, and a per-row
 *  add/remove toggle reflecting whether the media is already in that list. */
function ListPickerContent({ lists, onAdd, onRemove }: ListPickerContentProps) {
  const { tokens } = useAppearance();
  const { t } = useTranslation(['lists']);
  // Membership flips locally on each successful add/remove so the same dialog session
  // shows the new state without a refetch.
  const [membership, setMembership] = useState<Record<string, string | null>>(() =>
    Object.fromEntries(lists.map((l) => [l.id, l.containsMedia ? (l.itemId ?? 'unknown') : null])),
  );
  const [busy, setBusy] = useState<string | null>(null);

  const toggle = async (l: MyList) => {
    if (busy) return;
    setBusy(l.id);
    try {
      const itemId = membership[l.id];
      if (itemId && itemId !== 'unknown') {
        await onRemove(l.id, itemId);
        setMembership((m) => ({ ...m, [l.id]: null }));
      } else if (!itemId) {
        const newItemId = await onAdd(l.id);
        setMembership((m) => ({ ...m, [l.id]: newItemId ?? 'unknown' }));
      }
      // 'unknown' = added against an older API without itemId/membership support —
      // the row can't be toggled back in this session; the next open re-syncs.
    } catch {
      // Failure already surfaced by the handler (showError) — keep the row's state.
    } finally {
      setBusy(null);
    }
  };

  return (
    <View style={styles.rows}>
      {lists.map((l) => {
        const member = membership[l.id] != null;
        return (
          <Pressable
            key={l.id}
            onPress={() => toggle(l)}
            disabled={busy === l.id}
            style={({ pressed }) => [
              styles.row,
              {
                backgroundColor: tokens.surfaceElevated,
                opacity: pressed || busy === l.id ? 0.85 : 1,
              },
            ]}
            accessibilityRole="button"
            accessibilityLabel={l.title}
          >
            {l.coverUrl ? (
              <PosterImage uri={l.coverUrl} style={styles.cover} />
            ) : (
              <View
                style={[styles.cover, styles.coverFallback, { backgroundColor: tokens.surface }]}
              >
                <Ionicons name="list-outline" size={20} color={tokens.primary} />
              </View>
            )}
            <View style={styles.meta}>
              <T variant="caption" style={{ fontWeight: '700' }} numberOfLines={1}>
                {l.title}
              </T>
              <T variant="micro" muted style={{ marginTop: 2 }}>
                {(l.movieCount ?? 0) > 0 ? `🎬 ${l.movieCount}` : ''}
                {(l.movieCount ?? 0) > 0 && (l.showCount ?? 0) > 0 ? '  ' : ''}
                {(l.showCount ?? 0) > 0 ? `📺 ${l.showCount}` : ''}
                {!(l.movieCount ?? 0) && !(l.showCount ?? 0) ? t('lists:emptyLabel') : ''}
              </T>
            </View>
            <Ionicons
              name={member ? 'remove-circle-outline' : 'add-circle-outline'}
              size={22}
              color={member ? tokens.danger : tokens.primary}
            />
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * "Add to List" flow behind the media detail overflow (⋯) menu: lists the user's own
 * lists in a picker dialog with add/remove toggles; prompts to create a first list
 * when the user has none.
 */
export function useAddToList() {
  const { t } = useTranslation(['lists', 'common', 'settings']);
  const qc = useQueryClient();
  const addItem = useAddListItem();
  const removeItem = useRemoveListItem();
  const reassign = useReassign();
  const togglePause = useToggleTrackingPause();
  const dropMedia = useDropMedia();
  const integrations = useIntegrations();
  const syncIntegration = useSyncIntegration();

  const invalidateLists = () => {
    // Prefix match: covers ['myLists'] and the picker-scoped keys below.
    qc.invalidateQueries({ queryKey: ['myLists'] });
  };

  const openListPicker = async (mediaId: string) => {
    let lists: MyList[];
    try {
      // Scoped key (membership differs per media) + staleTime 0 so every picker open
      // refetches fresh membership — the global 30s staleTime would otherwise serve a
      // pre-add snapshot when the menu is reopened right after adding.
      lists = await qc.fetchQuery({
        queryKey: ['myLists', 'addToList', mediaId],
        queryFn: () => api.get<MyList[]>('/me/lists', { mediaId }),
        staleTime: 0,
      });
    } catch (e: any) {
      showError({
        title: t('lists:failedToSave'),
        description: e?.message ?? t('common:pleaseTryAgain'),
      });
      return;
    }
    if (!lists.length) {
      showConfirm({
        title: t('lists:noListsYet'),
        description: t('lists:noListsDesc'),
        confirmLabel: t('lists:createListButton'),
        onConfirm: () => router.push('/create-list' as any),
      });
      return;
    }
    showDialog({
      title: t('lists:addToList'),
      content: (
        <ListPickerContent
          lists={lists}
          onAdd={async (listId) => {
            try {
              const res = await addItem.mutateAsync({ listId, mediaId });
              invalidateLists();
              showToast(t('lists:addedToList'));
              return (res as any)?.itemId ?? null;
            } catch (e: any) {
              showError({
                title: t('lists:failedToSave'),
                description: e?.message ?? t('common:pleaseTryAgain'),
              });
              throw e;
            }
          }}
          onRemove={async (listId, itemId) => {
            try {
              await removeItem.mutateAsync({ listId, itemId });
              invalidateLists();
              showToast(t('lists:removedFromList'));
            } catch (e: any) {
              showError({
                title: t('lists:failedToSave'),
                description: e?.message ?? t('common:pleaseTryAgain'),
              });
              throw e;
            }
          }}
        />
      ),
      buttons: [{ label: t('common:cancel'), variant: 'ghost' }],
    });
  };

  /** Overflow (⋯) menu for a media detail page. Movies with transferable user activity
   *  also get a "Reassign" action. Shows get mutually exclusive pause/drop states and
   *  can resume from either one. `reassignModal` is rendered by the caller. */
  const openMediaMenu = (media: {
    id: string;
    title: string;
    kind?: 'movie' | 'show';
    inWatchlist?: boolean;
    dropped?: boolean;
    trackingPaused?: boolean;
    canReassign?: boolean;
  }) => {
    const canDrop =
      (media.kind === 'show' && !media.dropped) || (media.kind === 'movie' && !!media.inWatchlist);
    const connectedIntegrations = getConnectedIntegrationSyncOptions(integrations.data ?? []);
    showDialog({
      title: media.title,
      buttons: [
        // Primary (yellow): the add-to-list action.
        // closeOnPress 'before': these actions open a follow-up dialog/modal — the
        // menu must be dismissed first so two RN Modals are never stacked (iOS breaks
        // when the underneath modal is dismissed while another is presented).
        {
          label: t('lists:addToList'),
          variant: 'primary',
          closeOnPress: 'before',
          onPress: () => openListPicker(media.id),
        },
        ...(media.kind === 'movie' && media.canReassign
          ? [
              {
                label: t('lists:reassign'),
                variant: 'secondary' as const,
                closeOnPress: 'before' as const,
                onPress: () => reassign.openReassign(media),
              },
            ]
          : []),
        ...(media.kind === 'show' && !media.dropped
          ? [
              {
                label: media.trackingPaused ? t('lists:resumeTracking') : t('lists:pauseTracking'),
                variant: 'secondary' as const,
                onPress: () => {
                  const next = !media.trackingPaused;
                  togglePause.mutate(
                    { id: media.id, paused: next },
                    {
                      onSuccess: () =>
                        showToast(
                          next ? t('lists:trackingPausedToast') : t('lists:trackingResumedToast'),
                        ),
                      onError: (e: any) =>
                        showError({
                          title: t('lists:failedToSave'),
                          description: e?.message ?? t('common:pleaseTryAgain'),
                        }),
                    },
                  );
                },
              },
            ]
          : []),
        ...(media.kind === 'show' && media.dropped
          ? [
              {
                label: t('lists:resumeTracking'),
                variant: 'secondary' as const,
                onPress: () => {
                  dropMedia.mutate(
                    { id: media.id, kind: 'show', dropped: false },
                    {
                      onSuccess: () => showToast(t('lists:trackingResumedToast')),
                      onError: (e: any) =>
                        showError({
                          title: t('lists:failedToSave'),
                          description: e?.message ?? t('common:pleaseTryAgain'),
                        }),
                    },
                  );
                },
              },
            ]
          : []),
        ...connectedIntegrations.map((integration) => ({
          label: `${integration.provider} · ${t('settings:integrations.syncNow')}`,
          icon: <IntegrationIcon provider={integration.provider} size={22} />,
          variant: 'secondary' as const,
          closeOnPress: 'before' as const,
          disabled: integration.disabled,
          onPress: async () => {
            try {
              const result = await syncIntegration.mutateAsync(integration.provider);
              showToast(
                t('settings:integrations.syncResult', {
                  created: result.created,
                  skipped: result.skipped,
                }),
              );
            } catch (e: any) {
              showError({
                title: integration.provider,
                description: e?.message ?? t('common:pleaseTryAgain'),
              });
            }
          },
        })),
        ...(canDrop
          ? [
              {
                label: t('lists:drop'),
                variant: 'danger' as const,
                closeOnPress: 'before' as const,
                onPress: () => {
                  showConfirm({
                    title: t('lists:dropTitle', { title: media.title }),
                    description: t(
                      media.kind === 'show'
                        ? 'lists:dropShowDescription'
                        : 'lists:dropMovieDescription',
                    ),
                    confirmLabel: t('lists:drop'),
                    destructive: true,
                    onConfirm: () =>
                      dropMedia.mutate(
                        { id: media.id, kind: media.kind! },
                        {
                          onSuccess: () =>
                            showToast(t('lists:droppedToast', { title: media.title })),
                          onError: (e: any) =>
                            showError({
                              title: t('lists:failedToSave'),
                              description: e?.message ?? t('common:pleaseTryAgain'),
                            }),
                        },
                      ),
                  });
                },
              },
            ]
          : []),
      ],
    });
  };

  return { openMediaMenu, reassignModal: reassign.reassignModal };
}

const styles = StyleSheet.create({
  rows: { gap: spacing.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radius.md,
    padding: spacing.sm,
  },
  cover: { width: 44, height: 44, borderRadius: radius.sm },
  coverFallback: { alignItems: 'center', justifyContent: 'center' },
  meta: { flex: 1, marginLeft: spacing.sm },
});
