import React from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { Header } from '../components/Header';
import { PosterImage, Screen, Spinner, T } from '../components/primitives';
import { useFollows } from '../api/hooks';
import { useAppearance } from '../context/PreferencesProvider';
import { spacing } from '../theme/theme';

export default function FollowsScreen() {
  const { tokens } = useAppearance();
  const { u, t } = useLocalSearchParams<{ u: string; t: string }>();
  const username = u || '';
  const type = (t === 'following' ? 'following' : 'followers') as 'followers' | 'following';
  const { data, isLoading } = useFollows(username, type);

  return (
    <Screen>
      <Header title={type === 'followers' ? 'Followers' : 'Following'} showBack />
      {isLoading ? <Spinner /> : (
        <FlatList
          data={data ?? []}
          keyExtractor={(i) => i.id}
          contentContainerStyle={{ padding: spacing.lg }}
          ListEmptyComponent={<T variant="caption" muted style={{ textAlign: 'center' }}>No {type} yet</T>}
          renderItem={({ item }) => (
            <Pressable onPress={() => router.push(`/user/${item.username}`)} style={[styles.row, { borderBottomColor: tokens.border }]}>
              <PosterImage uri={item.avatarUrl} style={styles.avatar} />
              <View style={{ flex: 1 }}>
                <T variant="body">@{item.username}</T>
                {item.displayName ? <T variant="caption" muted>{item.displayName}</T> : null}
              </View>
              {item.isFollowing ? (
                <View style={[styles.followBtn, { backgroundColor: tokens.surface, borderWidth: 1, borderColor: tokens.border }]}>
                  <T variant="micro" style={{ color: tokens.textPrimary, fontWeight: '700' }}>Following</T>
                </View>
              ) : null}
            </Pressable>
          )}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing.sm, borderBottomWidth: 1 },
  avatar: { width: 44, height: 44, borderRadius: 22, marginRight: spacing.md },
  followBtn: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 20 },
});
