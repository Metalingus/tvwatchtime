import React, { useCallback, useState } from 'react';
import { FlatList, Pressable, RefreshControl, View } from 'react-native';
import { Header } from '../components/Header';
import { NotificationItem } from '../components/cards';
import { Button, Chip, EmptyState, Screen, Spinner, T } from '../components/primitives';
import { useMarkNotificationRead, useNotifications } from '../api/hooks';
import { useAppearance } from '../context/PreferencesProvider';
import { navigateFromLink } from '../lib/announcement';
import { spacing } from '../theme/theme';
import { useTranslation } from 'react-i18next';

export default function NotificationsScreen() {
  const { tokens } = useAppearance();
  const { t } = useTranslation(['notifications', 'common']);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const { data, isLoading, refetch } = useNotifications({ unreadOnly, page: 1 });
  const mark = useMarkNotificationRead();
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => { setRefreshing(true); await refetch(); setRefreshing(false); }, [refetch]);
  const items = data?.items ?? [];

  return (
    <Screen>
      <Header
        title={t('notifications:title')}
        showBack
        right={
          <Button title={t('notifications:markAll')} variant="ghost" onPress={() => mark.mutate({ all: true })} style={{ paddingHorizontal: spacing.sm }} />
        }
      />
      <View style={{ flexDirection: 'row', paddingHorizontal: spacing.lg, paddingBottom: spacing.sm }}>
        <Chip label={t('notifications:all')} active={!unreadOnly} onPress={() => setUnreadOnly(false)} />
        <Chip label={t('notifications:unread')} active={unreadOnly} onPress={() => setUnreadOnly(true)} />
      </View>
      {isLoading ? <Spinner /> : items.length === 0 ? (
        <EmptyState title={t('notifications:empty')} subtitle={t('notifications:emptyDesc')} icon="notifications-off-outline" />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(i) => i.id}
          contentContainerStyle={{ padding: spacing.lg }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[tokens.primary]} tintColor={tokens.primary} />}
          renderItem={({ item }) => (
            <Pressable onPress={() => { if (!item.read) mark.mutate({ id: item.id }); navigateFromLink(item.link); }}>
              <NotificationItem item={item} />
            </Pressable>
          )}
        />
      )}
    </Screen>
  );
}