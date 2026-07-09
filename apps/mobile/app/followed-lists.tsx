import React from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { Header } from '../components/Header';
import { ListCard } from '../components/ListCard';
import { EmptyState, Screen, Spinner } from '../components/primitives';
import { useFollowedLists } from '../api/hooks';
import { spacing } from '../theme/theme';

export default function FollowedListsScreen() {
  const { data, isLoading } = useFollowedLists();

  return (
    <Screen>
      <Header title="Followed Lists" showBack />
      {isLoading ? <Spinner /> : (
        <FlatList
          data={data ?? []}
          keyExtractor={(i) => i.id}
          numColumns={2}
          contentContainerStyle={{ padding: spacing.lg }}
          ListEmptyComponent={
            <EmptyState title="No followed lists" subtitle="Subscribe to lists from other users to see them here." icon="list-outline" />
          }
          renderItem={({ item }) => (
            <Pressable onPress={() => router.push(`/list/${item.id}`)} style={{ flex: 1, margin: 4 }}>
              <ListCard item={item} style={{ width: '100%', height: 200, marginRight: 0 }} />
            </Pressable>
          )}
        />
      )}
    </Screen>
  );
}
