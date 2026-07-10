import React, { useCallback, useState } from 'react';
import { FlatList, Pressable, RefreshControl, View } from 'react-native';
import { Header } from '../components/Header';
import { NotificationItem } from '../components/cards';
import { Button, Chip, EmptyState, Screen, Spinner, T } from '../components/primitives';
import { useMarkNotificationRead, useNotifications } from '../api/hooks';
import { colors, spacing } from '../theme/theme';

export default function NotificationsScreen() {
  const [unreadOnly, setUnreadOnly] = useState(false);
  const { data, isLoading, refetch } = useNotifications({ unreadOnly, page: 1 });
  const mark = useMarkNotificationRead();
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => { setRefreshing(true); await refetch(); setRefreshing(false); }, [refetch]);
  const items = data?.items ?? [];

  return (
    <Screen>
      <Header
        title="Notifications"
        showBack
        right={
          <Button title="Mark all" variant="ghost" onPress={() => mark.mutate({ all: true })} style={{ paddingHorizontal: 0 }} />
        }
      />
      <View style={{ flexDirection: 'row', paddingHorizontal: spacing.lg, paddingBottom: spacing.sm }}>
        <Chip label="All" active={!unreadOnly} onPress={() => setUnreadOnly(false)} />
        <Chip label="Unread" active={unreadOnly} onPress={() => setUnreadOnly(true)} />
      </View>
      {isLoading ? <Spinner /> : items.length === 0 ? (
        <EmptyState title="No notifications" subtitle="You're all caught up." icon="notifications-off-outline" />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(i) => i.id}
          contentContainerStyle={{ padding: spacing.lg }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[colors.primary]} tintColor={colors.primary} />}
          renderItem={({ item }) => (
            <Pressable onPress={() => !item.read && mark.mutate({ id: item.id })}>
              <NotificationItem item={item} />
            </Pressable>
          )}
        />
      )}
    </Screen>
  );
}
