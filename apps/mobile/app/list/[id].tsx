import React, { useState, useEffect } from 'react';
import { Alert, FlatList, Modal, Pressable, Share, StyleSheet, TextInput, View } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useQuery } from '@tanstack/react-query';
import { Header } from '../../components/Header';
import { Button, Card, EmptyState, PosterImage, Screen, Spinner, T } from '../../components/primitives';
import { TextField } from '../../components/TextField';
import { api } from '../../api/client';
import { useList, useListItems, useToggleListLike, useToggleListSub, useToggleListNotify, useAddListItem, useRemoveListItem } from '../../api/hooks';
import { colors, radius, spacing } from '../../theme/theme';

export default function ListDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: list, isLoading } = useList(id);
  const [page, setPage] = useState(1);
  const { data: itemsData } = useListItems(id, page);
  const [activeTab, setActiveTab] = useState<'SHOW' | 'MOVIE'>('SHOW');
  const [showAddSearch, setShowAddSearch] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);

  const likeMut = useToggleListLike();
  const subMut = useToggleListSub();
  const notifyMut = useToggleListNotify();
  const addMut = useAddListItem();
  const removeMut = useRemoveListItem();

  const allItems = itemsData?.items ?? [];
  const shows = allItems.filter(i => i.mediaType === 'SHOW');
  const movies = allItems.filter(i => i.mediaType === 'MOVIE');

  useEffect(() => {
    if (activeTab === 'SHOW' && shows.length === 0 && movies.length > 0) setActiveTab('MOVIE');
    if (activeTab === 'MOVIE' && movies.length === 0 && shows.length > 0) setActiveTab('SHOW');
  }, [shows.length, movies.length]);

  const currentItems = activeTab === 'SHOW' ? shows : movies;

  const onShare = async () => {
    try { await Share.share({ message: `Check out "${list?.title}" on TVWatchTime\ntvwatchtime://list/${id}` }); } catch {}
  };

  const onRemove = (itemId: string) => {
    Alert.alert('Remove item?', undefined, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => removeMut.mutate({ listId: id, itemId }) },
    ]);
  };

  if (isLoading || !list) return <Screen><Header showBack /><Spinner /></Screen>;
  const isOwner = list.isOwner;

  return (
    <Screen>
      <Header showBack right={
        <View style={{ flexDirection: 'row' }}>
          {isOwner ? (
            <Pressable onPress={() => setShowEditModal(true)} hitSlop={10} style={{ marginRight: 16 }}>
              <Ionicons name="create-outline" size={24} color={colors.text} />
            </Pressable>
          ) : null}
          <Pressable onPress={onShare} hitSlop={10}>
            <Ionicons name="share-outline" size={24} color={colors.text} />
          </Pressable>
        </View>
      } />
      <FlatList
        data={currentItems}
        keyExtractor={(i) => i.id}
        numColumns={3}
        contentContainerStyle={{ paddingBottom: 40 }}
        ListHeaderComponent={
          <View>
            <View style={{ position: 'relative', height: 200, marginBottom: spacing.md }}>
              <Image source={list.coverUrl ? { uri: list.coverUrl } : undefined} style={StyleSheet.absoluteFill} contentFit="cover" />
              <LinearGradient colors={['rgba(15,17,21,0.3)', 'rgba(15,17,21,0.95)']} style={StyleSheet.absoluteFill} />
              <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0, padding: spacing.lg }}>
                <T variant="h1">{list.title}</T>
                {list.description ? <T variant="body" muted style={{ marginTop: 4 }}>{list.description}</T> : null}
                <T variant="micro" muted style={{ marginTop: 8 }}>{isOwner ? 'Your list' : `by @${list.ownerUsername}`} · {list.movieCount} movies · {list.showCount} shows</T>
              </View>
            </View>

            {isOwner ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg, marginBottom: spacing.md }}>
                <Pressable onPress={() => setShowAddSearch(!showAddSearch)} style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <Ionicons name="add-circle" size={24} color={colors.primary} />
                  <T variant="caption" style={{ color: colors.primary, marginLeft: 4, fontWeight: '700' }}>Add items</T>
                </Pressable>
                <T variant="micro" muted style={{ marginLeft: 'auto' }}>{list.likeCount} ❤️ · {list.subCount} followers</T>
              </View>
            ) : (
              <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg, marginBottom: spacing.md }}>
                <Pressable onPress={() => likeMut.mutate(id)} style={{ flexDirection: 'row', alignItems: 'center', marginRight: spacing.lg }}>
                  <Ionicons name={list.isLiked ? 'heart' : 'heart-outline'} size={24} color={list.isLiked ? colors.favorite : colors.textMuted} />
                  <T variant="caption" muted style={{ marginLeft: 4 }}>{list.likeCount}</T>
                </Pressable>
                <Pressable onPress={() => subMut.mutate(id)} style={{ flexDirection: 'row', alignItems: 'center', marginRight: spacing.lg }}>
                  <Ionicons name={list.isSubscribed ? 'checkmark-circle' : 'add-circle-outline'} size={24} color={list.isSubscribed ? colors.watched : colors.textMuted} />
                  <T variant="caption" muted style={{ marginLeft: 4 }}>{list.isSubscribed ? 'Following' : 'Follow'}</T>
                </Pressable>
                {list.isSubscribed ? (
                  <Pressable onPress={() => notifyMut.mutate(id)}>
                    <Ionicons name={list.notifyOnAdd ? 'notifications' : 'notifications-outline'} size={22} color={list.notifyOnAdd ? colors.primary : colors.textMuted} />
                  </Pressable>
                ) : null}
              </View>
            )}

            {showAddSearch && isOwner ? (
              <View style={{ paddingHorizontal: spacing.lg, marginBottom: spacing.md }}>
                <AddItemSearch listId={id} existingIds={allItems.map(i => i.mediaId)} onAdd={(mediaId) => addMut.mutate({ listId: id, mediaId })} />
              </View>
            ) : null}

            {(shows.length > 0 || movies.length > 0) ? (
              <View style={{ flexDirection: 'row', paddingHorizontal: spacing.lg, marginBottom: spacing.sm }}>
                {shows.length > 0 ? (
                  <Pressable onPress={() => setActiveTab('SHOW')} style={[styles.tab, activeTab === 'SHOW' && styles.tabActive, { marginRight: spacing.sm }]}>
                    <T variant="caption" style={{ color: activeTab === 'SHOW' ? colors.background : colors.textMuted, fontWeight: '700' }}>📺 Shows ({shows.length})</T>
                  </Pressable>
                ) : null}
                {movies.length > 0 ? (
                  <Pressable onPress={() => setActiveTab('MOVIE')} style={[styles.tab, activeTab === 'MOVIE' && styles.tabActive]}>
                    <T variant="caption" style={{ color: activeTab === 'MOVIE' ? colors.background : colors.textMuted, fontWeight: '700' }}>🎬 Movies ({movies.length})</T>
                  </Pressable>
                ) : null}
              </View>
            ) : null}
          </View>
        }
        ListEmptyComponent={<EmptyState title={isOwner ? 'No items yet' : 'This list is empty'} subtitle={isOwner ? 'Tap "Add items" to add shows or movies' : undefined} icon="list-outline" />}
        renderItem={({ item }) => (
          <Pressable onPress={() => router.push(`/${item.mediaType === 'SHOW' ? 'show' : 'movie'}/${item.mediaId}`)} style={{ flex: 1, marginHorizontal: 2, marginBottom: 12 }}>
            <View style={{ position: 'relative' }}>
              <Image source={item.posterUrl ? { uri: item.posterUrl } : undefined} style={{ width: '100%', height: 160, borderRadius: radius.sm, backgroundColor: colors.surfaceElevated }} contentFit="cover" transition={150} />
              {isOwner ? (
                <Pressable onPress={() => onRemove(item.id)} style={{ position: 'absolute', top: 4, right: 4, backgroundColor: 'rgba(0,0,0,0.7)', borderRadius: 12, width: 24, height: 24, alignItems: 'center', justifyContent: 'center' }}>
                  <Ionicons name="close" size={14} color="#fff" />
                </Pressable>
              ) : null}
            </View>
            <T variant="micro" numberOfLines={2} style={{ marginTop: 4 }}>{item.title}</T>
          </Pressable>
        )}
        onEndReached={() => { if (itemsData?.hasMore) setPage(p => p + 1); }}
        onEndReachedThreshold={0.5}
      />

      {showEditModal ? <EditListModal listId={id} title={list.title} description={list.description} visibility={list.visibility} onClose={() => setShowEditModal(false)} /> : null}
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
        <TextInput value={query} onChangeText={setQuery} placeholder="Search to add..." placeholderTextColor={colors.textDim} autoCapitalize="none" style={{ flex: 1, marginLeft: spacing.sm, color: colors.text, paddingVertical: spacing.sm }} />
        {query ? <Pressable onPress={() => setQuery('')} hitSlop={8}><Ionicons name="close-circle" size={18} color={colors.textMuted} /></Pressable> : null}
      </View>
      {filtered.map((item: any) => (
        <Pressable key={item.id} onPress={() => onAdd(item.id)} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: spacing.sm, borderBottomColor: colors.border, borderBottomWidth: 1 }}>
          <Image source={item.posterUrl ? { uri: item.posterUrl } : undefined} style={{ width: 32, height: 48, borderRadius: 4, backgroundColor: colors.surfaceElevated }} contentFit="cover" />
          <View style={{ flex: 1, marginLeft: spacing.sm }}>
            <T variant="caption" numberOfLines={1}>{item.title}</T>
            <T variant="micro" muted>{item.type}</T>
          </View>
          <Ionicons name="add-circle" size={22} color={colors.primary} />
        </Pressable>
      ))}
    </Card>
  );
}

function EditListModal({ listId, title, description, visibility, onClose }: { listId: string; title: string; description?: string; visibility: string; onClose: () => void }) {
  const [editTitle, setEditTitle] = useState(title);
  const [editDesc, setEditDesc] = useState(description || '');
  const [editPublic, setEditPublic] = useState(visibility === 'PUBLIC');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try { await api.patch(`/lists/${listId}`, { title: editTitle, description: editDesc, visibility: editPublic ? 'PUBLIC' : 'PRIVATE' }); onClose(); }
    catch { Alert.alert('Failed to save'); } finally { setSaving(false); }
  };

  const del = () => {
    Alert.alert('Delete list?', 'This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => { await api.delete(`/lists/${listId}`); router.back(); } },
    ]);
  };

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' }}>
        <View style={{ backgroundColor: colors.background, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: spacing.xl, maxHeight: '80%' }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: spacing.lg }}>
            <T variant="h2">Edit list</T>
            <Pressable onPress={onClose}><Ionicons name="close" size={24} color={colors.textMuted} /></Pressable>
          </View>
          <TextField label="Title" value={editTitle} onChangeText={setEditTitle} />
          <TextField label="Description" value={editDesc} onChangeText={setEditDesc} placeholder="Optional" />
          <Pressable onPress={() => setEditPublic(!editPublic)} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.lg }}>
            <T variant="caption" muted>Visibility</T>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <T variant="caption" style={{ marginRight: 8 }}>{editPublic ? 'Public' : 'Private'}</T>
              <View style={[styles.toggle, editPublic && { backgroundColor: colors.primary }]}>
                <View style={[styles.toggleKnob, editPublic && { transform: [{ translateX: 18 }] }]} />
              </View>
            </View>
          </Pressable>
          <Button title="Update list" onPress={save} loading={saving} icon="checkmark-outline" />
          <Pressable onPress={del} style={{ alignItems: 'center', marginTop: spacing.lg, paddingVertical: spacing.md }}>
            <T variant="caption" style={{ color: colors.danger }}>Delete list</T>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  tab: { paddingHorizontal: spacing.md, paddingVertical: 8, borderRadius: 20, backgroundColor: colors.surface },
  tabActive: { backgroundColor: colors.primary },
  toggle: { width: 44, height: 24, borderRadius: 12, backgroundColor: colors.surface, padding: 3 },
  toggleKnob: { width: 18, height: 18, borderRadius: 9, backgroundColor: '#fff' },
});
