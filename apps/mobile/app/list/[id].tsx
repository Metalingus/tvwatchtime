import React from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Header } from '../../components/Header';
import { Card, EmptyState, PosterImage, Screen, Spinner, T } from '../../components/primitives';
import { useList } from '../../api/hooks';
import { colors, radius, spacing } from '../../theme/theme';

export default function ListScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data, isLoading } = useList(id);

  return (
    <Screen>
      <Header title={data?.title ?? 'List'} showBack />
      {isLoading ? <Spinner /> : (
        <FlatList
          data={data?.items ?? []}
          keyExtractor={(i) => i.id}
          contentContainerStyle={{ padding: spacing.lg }}
          ListEmptyComponent={<EmptyState title="This list is empty" icon="layers-outline" />}
          renderItem={({ item }) => (
            <Pressable onPress={() => router.push(`/${item.mediaType === 'SHOW' ? 'show' : 'movie'}/${item.mediaId}`)} style={styles.row}>
              <PosterImage uri={item.posterUrl} style={{ width: 50, height: 75, borderRadius: radius.sm }} />
              <T variant="body" style={{ flex: 1, marginLeft: spacing.md }}>{item.title}</T>
              <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
            </Pressable>
          )}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.sm, marginBottom: spacing.sm },
});
