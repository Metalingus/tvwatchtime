import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { BlockedUserDto } from '@tvwatch/shared';
import { api } from '../api/client';
import { useCommsUniScope } from '../api/commsuni';
import { useAppearance } from '../context/PreferencesProvider';
import { spacing } from '../theme/theme';
import { Card, T, Spinner } from './primitives';
import { ProfileAvatar } from './ProfileAvatar';

export function BlockedUsersSettings() {
  const { tokens } = useAppearance();
  const { t } = useTranslation(['settings', 'comments', 'common']);
  const scope = useCommsUniScope();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState('');
  const [error, setError] = useState(false);
  const query = useQuery({
    queryKey: ['blockedUsers', ...scope.key],
    queryFn: () => api.get<BlockedUserDto[]>('/social/me/blocked'),
    enabled: open && scope.ready,
    retry: false,
  });
  const unblock = async (row: BlockedUserDto) => {
    if (pending) return;
    setPending(row.id);
    setError(false);
    try {
      await api.del('/social/users/' + encodeURIComponent(row.id) + '/block');
      await query.refetch();
      await Promise.all(
        ['conversations', 'commsuniThread', 'comments', 'comment', 'commentReplies'].map((key) =>
          qc.resetQueries({ queryKey: [key] }),
        ),
      );
    } catch {
      setError(true);
    } finally {
      setPending('');
    }
  };
  return (
    <Card>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
      >
        <T variant="h2">{t('settings:blockedUsers')}</T>
      </Pressable>
      {open ? (
        <View style={{ marginTop: spacing.md }}>
          {query.isLoading ? <Spinner /> : null}
          {!query.isLoading && !query.isError && query.data?.length === 0 ? (
            <T muted>{t('settings:noBlockedUsers')}</T>
          ) : null}
          {query.data?.map((row) => (
            <View
              key={row.id}
              style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: spacing.sm }}
            >
              <ProfileAvatar uri={row.avatarUrl} />
              <T style={{ flex: 1, marginHorizontal: spacing.sm }}>
                {row.displayName || row.username}
              </T>
              <Pressable
                accessibilityRole="button"
                disabled={!!pending}
                onPress={() => {
                  void unblock(row);
                }}
              >
                <T style={{ color: tokens.textPrimary, textDecorationLine: 'underline' }}>
                  {t('settings:unblock')}
                </T>
              </Pressable>
            </View>
          ))}
          {error || query.isError ? <T muted>{t('common:pleaseTryAgain')}</T> : null}
        </View>
      ) : null}
    </Card>
  );
}
