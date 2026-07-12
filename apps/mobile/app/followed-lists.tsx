import React from 'react';
import { FlatList } from 'react-native';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Header } from '../components/Header';
import { ListCard } from '../components/ListCard';
import { EmptyState, Screen, Spinner } from '../components/primitives';
import { useFollowedLists } from '../api/hooks';
import { spacing } from '../theme/theme';

export default function FollowedListsScreen() {
  const { t } = useTranslation(['lists']);
  const { data, isLoading } = useFollowedLists();

  return (
    <Screen>
      <Header title={t('lists:followedLists')} showBack />
      {isLoading ? <Spinner /> : (
        <FlatList
          data={data ?? []}
          keyExtractor={(i) => i.id}
          numColumns={2}
          contentContainerStyle={{ padding: spacing.lg }}
          columnWrapperStyle={{ justifyContent: 'space-between', marginBottom: spacing.md }}
          ListEmptyComponent={
            <EmptyState title={t('lists:noFollowedLists')} subtitle={t('lists:noFollowedDesc')} icon="list-outline" />
          }
          renderItem={({ item }) => (
            <ListCard item={item} onPress={() => router.push(`/list/${item.id}`)} style={{ width: '48%', height: 200, marginRight: 0 }} />
          )}
        />
      )}
    </Screen>
  );
}