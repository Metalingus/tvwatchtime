import React, { useState, useCallback } from 'react';
import { Alert, FlatList, Pressable, Share, StyleSheet, TextInput, View } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { Header } from '../../components/Header';
import { Button, Card, EmptyState, PosterImage, Screen, SectionHeader, Spinner, T } from '../../components/primitives';
import { TextField } from '../../components/TextField';
import { PosterGrid } from '../../components/cards';
import { api } from '../../api/client';
import { useList, useListItems, useToggleListLike, useToggleListSub, useToggleListNotify, useAddListItem, useRemoveListItem } from '../../api/hooks';
import { colors, radius, spacing } from '../../theme/theme';

export default function ListDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: list, isLoading } = useList(id);
  const [page, setPage] = useState(1);
  const { data: itemsData } = useListItems(id, page);
  const [activeTab, setActiveTab] = useState<'SHOW' | 'MOVIE'>('SHOW');
  const [showSearch, setShowSearch] = useState(false);

  const likeMutation = useToggleListLike();
  const subMutation = useToggleListSub();
  const notifyMutation = useToggleListNotify();
  const addMutation = useAddListItem();
  const removeMutation = useRemoveListItem();

  const allItems = itemsData?.items ?? [];
  const shows = allItems.filter(i => i.mediaType === 'SHOW');
  const movies = allItems.filter(i => i.mediaType === 'MOVIE');
  const currentItems = activeTab === 'SHOW' ? shows : movies;

  const onShare = async () => {
    try {
      await Share.share({ url: `tvwatchtime://list/${id}`, message: `Check out this list: ${list?.title}\ntvwatchtime://list/${id}` });
    } catch {}
  };

  const onRemove = (itemId: string) => {
    Alert.alert('Remove item?', undefined, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => removeMutation.mutate({ listId: id, itemId }) },
    ]);
  };

  if (isLoading || !list) return <Screen><Header showBack /><Spinner /></Screen>;

  return (
    <Screen>
      <Header
        showBack
        right={
          <Pressable onPress={onShare} hitSlop={10}>
            <Ionicons name="share-outline" size={24} color={colors.text} />
          </Pressable>
        }
      />
      <FlatList
        data={currentItems}
        keyExtractor={(i) => i.id}
        numColumns={3}
        contentContainerStyle={{ paddingBottom: 40 }}
        ListHeaderComponent={
          <View>
            {/* Hero */}
            <View style={{ position: 'relative', height: 200, marginBottom: spacing.md }}>
              <PosterImage uri={list.coverUrl} style={StyleSheet.absoluteFill} />
              <LinearGradient colors={['rgba(15,17,21,0.3)', 'rgba(15,17,21,0.95)']} style={StyleSheet.absoluteFill} />
              <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0, padding: spacing.lg }}>
                <T variant="h1">{list.title}</T>
                {list.description ? <T variant="body" muted style={{ marginTop: 4 }}>{list.description}</T> : null}
                <T variant="micro" muted style={{ marginTop: 8 }}>by @{list.ownerUsername} · {list.movieCount} movies · {list.showCount} shows</T>
              </View>
            </View>

            {/* Action bar */}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.lg, paddingHorizontal: spacing.lg, marginBottom: spacing.md }}>
              <Pressable onPress={() => likeMutation.mutate(id)} style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Ionicons name={list.isLiked ? 'heart' : 'heart-outline'} size={24} color={list.isLiked ? colors.favorite : colors.textMuted} />
                <T variant="caption" muted style={{ marginLeft: 4 }}>{list.likeCount}</T>
              </Pressable>
              <Pressable onPress={() => subMutation.mutate(id)} style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Ionicons name={list.isSubscribed ? 'checkmark-circle' : 'add-circle-outline'} size={24} color={list.isSubscribed ? colors.watched : colors.textMuted} />
                <T variant="caption" muted style={{ marginLeft: 4 }}>{list.isSubscribed ? 'Following' : 'Follow'}</T>
              </Pressable>
              {list.isSubscribed ? (
                <Pressable onPress={() => notifyMutation.mutate(id)}>
                  <Ionicons name={list.notifyOnAdd ? 'notifications' : 'notifications-outline'} size={22} color={list.notifyOnAdd ? colors.primary : colors.textMuted} />
                </Pressable>
              ) : null}
              {list.isOwner ? (
                <Pressable onPress={() => setShowSearch(!showSearch)}>
                  <Ionicons name="add-circle-outline" size={24} color={colors.primary} />
                </Pressable>
              ) : null}
            </View>

            {/* Add items (owner only) */}
            {showSearch && list.isOwner ? (
              <View style={{ paddingHorizontal: spacing.lg, marginBottom: spacing.md }}>
                <AddItemSearch listId={id} existingIds={allItems.map(i => i.mediaId)} onAdd={(mediaId) => addMutation.mutate({ listId: id, mediaId })} />
              </View>
            ) : null}

            {/* Tabs */}
            <View style={{ flexDirection: 'row', paddingHorizontal: spacing.lg, marginBottom: spacing.sm }}>
              {shows.length > 0 ? (
                <Pressable onPress={() => setActiveTab('SHOW')} style={[styles.tab, activeTab === 'SHOW' && styles.tabActive]}>
                  <T variant="caption" style={{ color: activeTab === 'SHOW' ? colors.background : colors.textMuted, fontWeight: '700' }}>📺 Shows ({shows.length})</T>
                </Pressable>
              ) : null}
              {movies.length > 0 ? (
                <Pressable onPress={() => setActiveTab('MOVIE')} style={[styles.tab, activeTab === 'MOVIE' && styles.tabActive]}>
                  <T variant="caption" style={{ color: activeTab === 'MOVIE' ? colors.background : colors.textMuted, fontWeight: '700' }}>🎬 Movies ({movies.length})</T>
                </Pressable>
              ) : null}
            </View>
          </View>
        }
        ListEmptyComponent={
          <EmptyState
            title={list.isOwner ? 'No items yet' : 'This list is empty'}
            subtitle={list.isOwner ? 'Add shows and movies using the + button' : undefined}
            icon="list-outline"
          />
        }
        renderItem={({ item }) => (
          <Pressable
            onPress={() => router.push(`/${item.mediaType === 'SHOW' ? 'show' : 'movie'}/${item.mediaId}`)}
            onLongPress={() => list.isOwner && onRemove(item.id)}
            style={{ flex: 1, marginHorizontal: 2, marginBottom: 8 }}
          >
            <PosterImage uri={item.posterUrl} style={{ width: '100%', height: 160, borderRadius: radius.sm }} />
            <T variant="micro" numberOfLines={1} style={{ marginTop: 2 }}>{item.title}</T>
          </Pressable>
        )}
        onEndReached={() => { if (itemsData?.hasMore) setPage(p => p + 1); }}
        onEndReachedThreshold={0.5}
      />
    </Screen>
  );
}

function AddItemSearch({ listId, existingIds, onAdd }: { listId: string; existingIds: string[]; onAdd: (mediaId: string) => void }) {
  const [query, setQuery] = useState('');

  const results = useQuery({
    queryKey: ['search', 'list-add', query],
    queryFn: () => api.get<{ items: any[] }>('/search', { q: query, pageSize: 10 }),
    enabled: query.length >= 2,
  });

  const filtered = (results.data?.items ?? []).filter((i) => !existingIds.includes(i.id));

  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surfaceAlt, borderRadius: radius.md, paddingHorizontal: spacing.md }}>
        <Ionicons name="search" size={18} color={colors.textMuted} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search to add..."
          placeholderTextColor={colors.textDim}
          style={{ flex: 1, marginLeft: spacing.sm, color: colors.text, paddingVertical: spacing.sm }}
        />
      </View>
      {filtered.map((item: any) => (
        <Pressable key={item.id} onPress={() => onAdd(item.id)} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: spacing.sm, borderBottomColor: colors.border, borderBottomWidth: 1 }}>
          <PosterImage uri={item.posterUrl} style={{ width: 32, height: 48, borderRadius: 4 }} />
          <T variant="caption" numberOfLines={1} style={{ flex: 1, marginLeft: spacing.sm }}>{item.title}</T>
          <Ionicons name="add" size={20} color={colors.primary} />
        </Pressable>
      ))}
    </Card>
  );
}

const styles = StyleSheet.create({
  tab: { paddingHorizontal: spacing.md, paddingVertical: 8, borderRadius: 20, backgroundColor: colors.surface, marginRight: spacing.sm },
  tabActive: { backgroundColor: colors.primary },
});
