import React from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Header } from '../components/Header';
import { ListCard } from '../components/ListCard';
import { EmptyState, Screen, Spinner, T } from '../components/primitives';
import { useMyLists } from '../api/hooks';
import { colors, spacing } from '../theme/theme';

export default function MyListsScreen() {
  const { data, isLoading } = useMyLists();

  return (
    <Screen>
      <Header title="My Lists" showBack right={
        <Pressable onPress={() => router.push('/create-list')} hitSlop={10}>
          <Ionicons name="add-circle-outline" size={26} color={colors.primary} />
        </Pressable>
      } />
      {isLoading ? <Spinner /> : (
        <FlatList
          data={data ?? []}
          keyExtractor={(i) => i.id}
          numColumns={2}
          contentContainerStyle={{ padding: spacing.lg }}
          ListEmptyComponent={
            <EmptyState title="No lists yet" subtitle="Create your first list to organize your favorite shows and movies." icon="list-outline" cta="Create list" onCta={() => router.push('/create-list')} />
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
