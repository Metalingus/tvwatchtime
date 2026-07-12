import React from 'react';
import { FlatList, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Header } from '../components/Header';
import { ListCard } from '../components/ListCard';
import { EmptyState, Screen, Spinner } from '../components/primitives';
import { useMyLists } from '../api/hooks';
import { useAppearance } from '../context/PreferencesProvider';
import { spacing } from '../theme/theme';

export default function MyListsScreen() {
  const { tokens } = useAppearance();
  const { data, isLoading } = useMyLists();

  return (
    <Screen>
      <Header title="My Lists" showBack right={
        <Ionicons.Button name="add-circle-outline" size={26} color={tokens.primary} backgroundColor="transparent" iconStyle={{ marginRight: 0 }} onPress={() => router.push('/create-list')} />
      } />
      {isLoading ? <Spinner /> : (
        <FlatList
          data={data ?? []}
          keyExtractor={(i) => i.id}
          numColumns={2}
          contentContainerStyle={{ padding: spacing.lg }}
          columnWrapperStyle={{ justifyContent: 'space-between', marginBottom: spacing.md }}
          ListEmptyComponent={
            <EmptyState title="No lists yet" subtitle="Create your first list to organize your favorite shows and movies." icon="list-outline" cta="Create list" onCta={() => router.push('/create-list')} />
          }
          renderItem={({ item }) => (
            <ListCard item={item} onPress={() => router.push(`/list/${item.id}`)} style={{ width: '48%', height: 200, marginRight: 0 }} />
          )}
        />
      )}
    </Screen>
  );
}
