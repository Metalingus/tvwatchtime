import React, { useState } from 'react';
import { FlatList, Pressable, View } from 'react-native';
import { Header } from '../components/Header';
import { NotificationItem } from '../components/cards';
import { Button, Chip, EmptyState, Screen, Spinner, T } from '../components/primitives';
import { useMarkNotificationRead, useNotifications } from '../api/hooks';
import { spacing } from '../theme/theme';

export default function NotificationsScreen() {
  const [unreadOnly, setUnreadOnly] = useState(false);
  const { data, isLoading } = useNotifications({ unreadOnly, page: 1 });
  const mark = useMarkNotificationRead();
  const items = data?.items ?? [];

  return (
    <Screen>
      <Header
        title="Notifications"
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
