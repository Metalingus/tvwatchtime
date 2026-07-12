import React, { useState } from 'react';
import { FlatList, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Header } from '../components/Header';
import { PosterImage, Screen, Spinner, T } from '../components/primitives';
import { useSearchUsers, useFollowUser, useUnfollowUser } from '../api/hooks';
import { useAppearance } from '../context/PreferencesProvider';
import { radius, spacing } from '../theme/theme';
import { useTranslation } from 'react-i18next';

export default function FindUserScreen() {
  const { tokens } = useAppearance();
  const { t } = useTranslation(['social']);
  const [query, setQuery] = useState('');
  const { data, isLoading } = useSearchUsers(query);
  const followMut = useFollowUser();
  const unfollowMut = useUnfollowUser();

  const toggleFollow = (userId: string, isFollowing: boolean) => {
    if (isFollowing) unfollowMut.mutate(userId);
    else followMut.mutate(userId);
  };

  return (
    <Screen>
      <Header title={t('social:findUsers')} showBack />
      <View style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.md }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: tokens.surfaceAlt, borderRadius: radius.md, borderWidth: 1, borderColor: tokens.border, paddingRight: 12 }}>
          <Ionicons name="search" size={18} color={tokens.textMuted} style={{ marginLeft: 12 }} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={t('social:searchByUsername')}
            placeholderTextColor={tokens.placeholder}
            autoCapitalize="none"
            style={{ flex: 1, marginLeft: 8, color: tokens.textPrimary, paddingVertical: spacing.sm + 2 }}
          />
          {query ? <Pressable onPress={() => setQuery('')} hitSlop={8}><Ionicons name="close-circle" size={20} color={tokens.textMuted} /></Pressable> : null}
        </View>
      </View>

      {isLoading ? <Spinner /> : (
        <FlatList
          data={data ?? []}
          keyExtractor={(i) => i.id}
          contentContainerStyle={{ padding: spacing.lg }}
          ListEmptyComponent={query.length >= 2 ? <T variant="caption" muted style={{ textAlign: 'center' }}>{t('social:noUsersFound')}</T> : <T variant="caption" muted style={{ textAlign: 'center' }}>{t('social:searchUsersHint')}</T>}
          renderItem={({ item }) => (
            <Pressable onPress={() => router.push(`/user/${item.username}`)} style={[styles.row, { borderBottomColor: tokens.border }]}>
              <PosterImage uri={item.avatarUrl} style={styles.avatar} />
              <View style={{ flex: 1 }}>
                <T variant="body">@{item.username}</T>
                {item.displayName ? <T variant="caption" muted>{item.displayName}</T> : null}
              </View>
              <Pressable
                onPress={(e) => { e.stopPropagation(); toggleFollow(item.id, item.isFollowing); }}
                style={[styles.followBtn, { backgroundColor: tokens.primary }, item.isFollowing && { backgroundColor: tokens.surface, borderWidth: 1, borderColor: tokens.border }]}
              >
                <T variant="micro" style={{ color: item.isFollowing ? tokens.textPrimary : tokens.primaryForeground, fontWeight: '700' }}>
                  {item.isFollowing ? t('social:followingButton') : t('social:followButton')}
                </T>
              </Pressable>
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