import React, { useState, useEffect, useMemo } from 'react';
import {
  FlatList,
  Keyboard,
  Modal,
  Pressable,
  Share,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useTranslation } from 'react-i18next';
import { Header } from '../../components/Header';
import { cardYear, MediaLibraryBadge } from '../../components/cards';
import {
  Button,
  Card,
  EmptyState,
  PosterImage,
  Screen,
  Spinner,
  T,
} from '../../components/primitives';
import { TextField } from '../../components/TextField';
import { api } from '../../api/client';
import {
  useList,
  useListItems,
  useToggleListLike,
  useToggleListSub,
  useToggleListNotify,
  useAddListItem,
  useRemoveListItem,
  useSearch,
  useRecentWatched,
  useDeleteList,
} from '../../api/hooks';
import { useAppearance } from '../../context/PreferencesProvider';
import { radius, spacing } from '../../theme/theme';
import { countryFlag } from '../../lib/country';
import { showError, showConfirm } from '../../lib/dialog';

/** Poster grid columns (chunked rows — never FlatList numColumns, see AGENTS.md). */
const GRID_COLS = 3;

export default function ListDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: list, isLoading } = useList(id);
  const { tokens } = useAppearance();
  const { t } = useTranslation(['lists', 'common']);
  const itemsQuery = useListItems(id);
  const [activeTab, setActiveTab] = useState<'SHOW' | 'MOVIE'>('SHOW');
  const [showAddSearch, setShowAddSearch] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  // When the add-items search is open and the list below is empty, the keyboard
  // would cover the results — pad the scroll view by the keyboard height.
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', (e) =>
      setKeyboardHeight(e.endCoordinates.height),
    );
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardHeight(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  const likeMut = useToggleListLike();
  const subMut = useToggleListSub();
  const notifyMut = useToggleListNotify();
  const addMut = useAddListItem();
  const removeMut = useRemoveListItem();

  const allItems = useMemo(
    () => (itemsQuery.data?.pages ?? []).flatMap((p: any) => p.items ?? []),
    [itemsQuery.data],
  );
  const shows = useMemo(() => allItems.filter((i) => i.mediaType === 'SHOW'), [allItems]);
  const movies = useMemo(() => allItems.filter((i) => i.mediaType === 'MOVIE'), [allItems]);

  useEffect(() => {
    if (activeTab === 'SHOW' && shows.length === 0 && movies.length > 0) setActiveTab('MOVIE');
    if (activeTab === 'MOVIE' && movies.length === 0 && shows.length > 0) setActiveTab('SHOW');
  }, [shows.length, movies.length]);

  const currentItems = activeTab === 'SHOW' ? shows : movies;
  // Chunked rows instead of numColumns (forbidden on Android — see AGENTS.md grid rule).
  const gridRows = useMemo(() => {
    const out: any[][] = [];
    for (let i = 0; i < currentItems.length; i += GRID_COLS)
      out.push(currentItems.slice(i, i + GRID_COLS));
    return out;
  }, [currentItems]);

  const onShare = async () => {
    try {
      await Share.share({
        message: `${t('lists:shareMsg', { title: list?.title })}\ntvwatchtime://list/${id}`,
      });
    } catch {}
  };

  const onRemove = (itemId: string) => {
    showConfirm({
      title: t('lists:removeItemQuestion'),
      confirmLabel: t('common:remove'),
      destructive: true,
      onConfirm: () => removeMut.mutate({ listId: id, itemId }),
    });
  };

  if (isLoading || !list)
    return (
      <Screen>
        <Header showBack />
        <Spinner />
      </Screen>
    );
  const isOwner = list.isOwner;

  return (
    <Screen>
      <Header
        showBack
        right={
          <View style={{ flexDirection: 'row' }}>
            {isOwner ? (
              <Pressable
                onPress={() => setShowEditModal(true)}
                hitSlop={10}
                style={{ marginRight: 16 }}
              >
                <Ionicons name="create-outline" size={24} color={tokens.textPrimary} />
              </Pressable>
            ) : null}
            <Pressable onPress={onShare} hitSlop={10}>
              <Ionicons name="share-outline" size={24} color={tokens.textPrimary} />
            </Pressable>
          </View>
        }
      />
      <FlatList
        data={gridRows}
        keyExtractor={(row) => row.map((i) => i.id).join('_')}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: showAddSearch ? keyboardHeight + 40 : 40 }}
        ListHeaderComponent={
          <View>
            <View style={{ position: 'relative', height: 200, marginBottom: spacing.md }}>
              <Image
                source={list.coverUrl ? { uri: list.coverUrl } : undefined}
                style={StyleSheet.absoluteFill}
                contentFit="cover"
              />
              <LinearGradient colors={tokens.mediaGradient} style={StyleSheet.absoluteFill} />
              <View
                style={{ position: 'absolute', bottom: 0, left: 0, right: 0, padding: spacing.lg }}
              >
                <T variant="h1" style={{ color: tokens.mediaText }}>
                  {list.title}
                </T>
                {list.description ? (
                  <T variant="body" style={{ marginTop: 4, color: tokens.mediaText }}>
                    {list.description}
                  </T>
                ) : null}
                <T variant="micro" style={{ marginTop: 8, color: tokens.mediaText }}>
                  {isOwner
                    ? t('lists:yourList')
                    : t('lists:byUser', { username: list.ownerUsername })}{' '}
                  · {t('lists:moviesCount', { count: list.movieCount })} ·{' '}
                  {t('lists:showsCount', { count: list.showCount })}
                </T>
              </View>
            </View>

            {isOwner ? (
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  paddingHorizontal: spacing.lg,
                  marginBottom: spacing.md,
                }}
              >
                <Pressable
                  onPress={() => setShowAddSearch(!showAddSearch)}
                  style={{ flexDirection: 'row', alignItems: 'center' }}
                >
                  <Ionicons name="add-circle" size={24} color={tokens.primary} />
                  <T
                    variant="caption"
                    style={{ color: tokens.primary, marginLeft: 4, fontWeight: '700' }}
                  >
                    {t('lists:addItems')}
                  </T>
                </Pressable>
                <T variant="micro" muted style={{ marginLeft: 'auto' }}>
                  {list.likeCount} ❤️ · {t('lists:followersCount', { count: list.subCount })}
                </T>
              </View>
            ) : (
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  paddingHorizontal: spacing.lg,
                  marginBottom: spacing.md,
                }}
              >
                <Pressable
                  onPress={() => likeMut.mutate(id)}
                  style={{ flexDirection: 'row', alignItems: 'center', marginRight: spacing.lg }}
                >
                  <Ionicons
                    name={list.isLiked ? 'heart' : 'heart-outline'}
                    size={24}
                    color={list.isLiked ? tokens.favorite : tokens.textMuted}
                  />
                  <T variant="caption" muted style={{ marginLeft: 4 }}>
                    {list.likeCount}
                  </T>
                </Pressable>
                <Pressable
                  onPress={() => subMut.mutate(id)}
                  style={{ flexDirection: 'row', alignItems: 'center', marginRight: spacing.lg }}
                >
                  <Ionicons
                    name={list.isSubscribed ? 'checkmark-circle' : 'add-circle-outline'}
                    size={24}
                    color={list.isSubscribed ? tokens.watched : tokens.textMuted}
                  />
                  <T variant="caption" muted style={{ marginLeft: 4 }}>
                    {list.isSubscribed ? t('lists:followingList') : t('lists:followList')}
                  </T>
                </Pressable>
                {list.isSubscribed ? (
                  <Pressable onPress={() => notifyMut.mutate(id)}>
                    <Ionicons
                      name={list.notifyOnAdd ? 'notifications' : 'notifications-outline'}
                      size={22}
                      color={list.notifyOnAdd ? tokens.primary : tokens.textMuted}
                    />
                  </Pressable>
                ) : null}
              </View>
            )}

            {showAddSearch && isOwner ? (
              <View style={{ paddingHorizontal: spacing.lg, marginBottom: spacing.md }}>
                <AddItemSearch
                  listId={id}
                  existingIds={allItems.map((i) => i.mediaId)}
                  onAdd={(mediaId) => addMut.mutate({ listId: id, mediaId })}
                />
              </View>
            ) : null}

            {shows.length > 0 || movies.length > 0 ? (
              <View
                style={{
                  flexDirection: 'row',
                  paddingHorizontal: spacing.lg,
                  marginBottom: spacing.sm,
                }}
              >
                {shows.length > 0 ? (
                  <Pressable
                    onPress={() => setActiveTab('SHOW')}
                    style={[
                      styles.tab,
                      { backgroundColor: tokens.surface },
                      activeTab === 'SHOW' && { backgroundColor: tokens.primary },
                      { marginRight: spacing.sm },
                    ]}
                  >
                    <T
                      variant="caption"
                      style={{
                        color: activeTab === 'SHOW' ? tokens.primaryForeground : tokens.textMuted,
                        fontWeight: '700',
                      }}
                    >
                      📺 {t('lists:showsTab')} ({shows.length})
                    </T>
                  </Pressable>
                ) : null}
                {movies.length > 0 ? (
                  <Pressable
                    onPress={() => setActiveTab('MOVIE')}
                    style={[
                      styles.tab,
                      { backgroundColor: tokens.surface },
                      activeTab === 'MOVIE' && { backgroundColor: tokens.primary },
                    ]}
                  >
                    <T
                      variant="caption"
                      style={{
                        color: activeTab === 'MOVIE' ? tokens.primaryForeground : tokens.textMuted,
                        fontWeight: '700',
                      }}
                    >
                      🎬 {t('lists:moviesTab')} ({movies.length})
                    </T>
                  </Pressable>
                ) : null}
              </View>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          <EmptyState
            title={isOwner ? t('lists:noItemsYet') : t('lists:listEmpty')}
            subtitle={isOwner ? t('lists:tapAddItems') : undefined}
            icon="list-outline"
          />
        }
        renderItem={({ item: row }) => (
          <View style={{ flexDirection: 'row' }}>
            {row.map((item) => (
              <Pressable
                key={item.id}
                onPress={() =>
                  router.push(`/${item.mediaType === 'SHOW' ? 'show' : 'movie'}/${item.mediaId}`)
                }
                style={{ flex: 1, marginHorizontal: 2, marginBottom: 12 }}
              >
                <View style={{ position: 'relative' }}>
                  <Image
                    source={item.posterUrl ? { uri: item.posterUrl } : undefined}
                    style={{
                      width: '100%',
                      height: 160,
                      borderRadius: radius.sm,
                      backgroundColor: tokens.surfaceElevated,
                    }}
                    contentFit="cover"
                    transition={150}
                  />
                  {item.rating != null && item.rating > 0 ? (
                    <View
                      style={{
                        position: 'absolute',
                        top: 4,
                        left: 4,
                        flexDirection: 'row',
                        alignItems: 'center',
                        backgroundColor: tokens.mediaScrim,
                        borderRadius: radius.sm,
                        paddingHorizontal: 4,
                        paddingVertical: 2,
                      }}
                    >
                      <Ionicons name="star" size={10} color={tokens.warning} />
                      <T variant="micro" style={{ color: tokens.mediaText, marginLeft: 2 }}>
                        {item.rating.toFixed(1)}
                      </T>
                    </View>
                  ) : null}
                  {isOwner ? (
                    <Pressable
                      onPress={() => onRemove(item.id)}
                      style={{
                        position: 'absolute',
                        top: 4,
                        right: 4,
                        backgroundColor: tokens.mediaScrim,
                        borderRadius: 12,
                        width: 24,
                        height: 24,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <Ionicons name="close" size={14} color={tokens.mediaText} />
                    </Pressable>
                  ) : null}
                  <MediaLibraryBadge
                    id={item.mediaId}
                    kind={item.mediaType === 'SHOW' ? 'shows' : 'movies'}
                    inWatchlist={item.inWatchlist}
                    watched={item.watched}
                    style={{ top: isOwner ? 38 : 4 }}
                  />
                </View>
                <T variant="micro" numberOfLines={2} style={{ marginTop: 4 }}>
                  {item.title}
                </T>
                {item.year ? (
                  <T variant="micro" muted numberOfLines={1} style={{ marginTop: 2 }}>
                    {item.year}
                  </T>
                ) : null}
              </Pressable>
            ))}
            {/* Invisible spacers keep incomplete rows aligned with the 3-column grid */}
            {row.length < GRID_COLS
              ? Array.from({ length: GRID_COLS - row.length }).map((_, i) => (
                  <View key={`pad_${i}`} style={{ flex: 1, marginHorizontal: 2 }} />
                ))
              : null}
          </View>
        )}
        onEndReached={() => {
          if (itemsQuery.hasNextPage && !itemsQuery.isFetchingNextPage) itemsQuery.fetchNextPage();
        }}
        onEndReachedThreshold={0.5}
        ListFooterComponent={itemsQuery.isFetchingNextPage ? <Spinner /> : null}
      />

      {showEditModal ? (
        <EditListModal
          listId={id}
          title={list.title}
          description={list.description}
          visibility={list.visibility}
          onClose={() => setShowEditModal(false)}
        />
      ) : null}
    </Screen>
  );
}

function AddItemSearch({
  listId,
  existingIds,
  onAdd,
}: {
  listId: string;
  existingIds: string[];
  onAdd: (mediaId: string) => void;
}) {
  const { tokens } = useAppearance();
  const { t } = useTranslation(['lists']);
  const [query, setQuery] = useState('');
  // Debounce like Explore (400ms) — without it every keystroke hits /search.
  const [debouncedQ, setDebouncedQ] = useState('');
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQ(query.trim()), 400);
    return () => clearTimeout(id);
  }, [query]);
  const results = useSearch(debouncedQ);
  const found = useMemo(
    () => (results.data?.pages ?? []).flatMap((p: any) => p.items ?? []),
    [results.data],
  );
  const filtered = found.filter((i: any) => !existingIds.includes(i.id));

  const recentQuery = useRecentWatched();
  // One row per media item: 10 watched episodes of a show collapse to the show once.
  const recent = useMemo(() => {
    const seen = new Set<string>();
    const out: any[] = [];
    for (const item of (recentQuery.data?.pages ?? []).flatMap((p: any) => p.items ?? [])) {
      if (seen.has(item.mediaId) || existingIds.includes(item.mediaId)) continue;
      seen.add(item.mediaId);
      out.push(item);
    }
    return out;
  }, [recentQuery.data, existingIds]);

  return (
    <Card>
      {recent.length > 0 ? (
        <View style={{ marginBottom: spacing.sm }}>
          <T variant="micro" muted style={{ marginBottom: spacing.xs }}>
            {t('lists:recentlyWatched')}
          </T>
          <FlatList
            horizontal
            data={recent}
            keyExtractor={(item) => item.mediaId}
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            onEndReached={() => {
              if (recentQuery.hasNextPage && !recentQuery.isFetchingNextPage)
                recentQuery.fetchNextPage();
            }}
            onEndReachedThreshold={0.5}
            renderItem={({ item }) => (
              <Pressable
                onPress={() => onAdd(item.mediaId)}
                style={{ width: 72, marginRight: spacing.sm }}
              >
                <Image
                  source={item.posterUrl ? { uri: item.posterUrl } : undefined}
                  style={{
                    width: 72,
                    height: 108,
                    borderRadius: radius.sm,
                    backgroundColor: tokens.surfaceElevated,
                  }}
                  contentFit="cover"
                  transition={150}
                />
                <T variant="micro" numberOfLines={1} style={{ marginTop: 4 }}>
                  {item.title}
                </T>
              </Pressable>
            )}
          />
        </View>
      ) : null}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          backgroundColor: tokens.surfaceAlt,
          borderRadius: radius.md,
          paddingHorizontal: spacing.md,
        }}
      >
        <Ionicons name="search" size={18} color={tokens.textMuted} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder={t('lists:searchToAddShort')}
          placeholderTextColor={tokens.placeholder}
          autoCapitalize="none"
          style={{
            flex: 1,
            marginLeft: spacing.sm,
            color: tokens.textPrimary,
            paddingVertical: spacing.sm,
          }}
        />
        {query ? (
          <Pressable onPress={() => setQuery('')} hitSlop={8}>
            <Ionicons name="close-circle" size={18} color={tokens.textMuted} />
          </Pressable>
        ) : null}
      </View>
      {debouncedQ.length > 1 && results.isLoading ? <Spinner /> : null}
      {filtered.map((item: any) => {
        const year = cardYear(item);
        const country = item.country ?? item.originCountries?.[0];
        return (
          <Pressable
            key={item.id}
            onPress={() => onAdd(item.id)}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              paddingVertical: spacing.sm,
              borderBottomColor: tokens.border,
              borderBottomWidth: 1,
            }}
          >
            <Image
              source={
                (item.images?.poster ?? item.images?.backdrop)
                  ? { uri: item.images?.poster ?? item.images?.backdrop }
                  : undefined
              }
              style={{
                width: 32,
                height: 48,
                borderRadius: 4,
                backgroundColor: tokens.surfaceElevated,
              }}
              contentFit="cover"
            />
            <View style={{ flex: 1, marginLeft: spacing.sm }}>
              <T variant="caption" numberOfLines={1}>
                {item.title}
              </T>
              <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' }}>
                <T variant="micro" muted>
                  {[
                    item.type === 'SHOW' ? t('lists:showsTab') : t('lists:moviesTab'),
                    year ? String(year) : null,
                    country ? countryFlag(country) : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </T>
                {item.rating ? (
                  <>
                    <Ionicons
                      name="star"
                      size={10}
                      color={tokens.warning}
                      style={{ marginLeft: 6 }}
                    />
                    <T variant="micro" muted style={{ marginLeft: 2 }}>
                      {item.rating.toFixed(1)}
                    </T>
                  </>
                ) : null}
              </View>
            </View>
            <Ionicons name="add-circle" size={22} color={tokens.primary} />
          </Pressable>
        );
      })}
    </Card>
  );
}

function EditListModal({
  listId,
  title,
  description,
  visibility,
  onClose,
}: {
  listId: string;
  title: string;
  description?: string;
  visibility: string;
  onClose: () => void;
}) {
  const { tokens } = useAppearance();
  const { t } = useTranslation(['lists', 'common']);
  const deleteList = useDeleteList();
  const [editTitle, setEditTitle] = useState(title);
  const [editDesc, setEditDesc] = useState(description || '');
  const [editPublic, setEditPublic] = useState(visibility === 'PUBLIC');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await api.patch(`/lists/${listId}`, {
        title: editTitle,
        description: editDesc,
        visibility: editPublic ? 'PUBLIC' : 'PRIVATE',
      });
      onClose();
    } catch {
      showError({ description: t('lists:failedToSave') });
    } finally {
      setSaving(false);
    }
  };

  const del = () => {
    if (deleteList.isPending) return;
    showConfirm({
      title: t('lists:deleteListQuestion'),
      description: t('lists:deleteCannotUndo'),
      confirmLabel: t('common:delete'),
      destructive: true,
      onConfirm: async () => {
        try {
          await deleteList.mutateAsync(listId);
          onClose();
          router.back();
        } catch {
          showError({ description: t('lists:failedToDelete') });
        }
      },
    });
  };

  return (
    <Modal visible animationType="slide" transparent onRequestClose={onClose}>
      <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: tokens.overlay }}>
        <View
          style={{
            backgroundColor: tokens.background,
            borderTopLeftRadius: 20,
            borderTopRightRadius: 20,
            padding: spacing.xl,
            maxHeight: '80%',
          }}
        >
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              marginBottom: spacing.lg,
            }}
          >
            <T variant="h2">{t('lists:editList')}</T>
            <Pressable onPress={onClose}>
              <Ionicons name="close" size={24} color={tokens.textMuted} />
            </Pressable>
          </View>
          <TextField label={t('lists:titleField')} value={editTitle} onChangeText={setEditTitle} />
          <TextField
            label={t('lists:descFieldEdit')}
            value={editDesc}
            onChangeText={setEditDesc}
            placeholder={t('lists:descPlaceholderEdit')}
          />
          <Pressable
            onPress={() => setEditPublic(!editPublic)}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: spacing.lg,
            }}
          >
            <T variant="caption" muted>
              {t('lists:visibility')}
            </T>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <T variant="caption" style={{ marginRight: 8 }}>
                {editPublic ? t('lists:public') : t('lists:private')}
              </T>
              <View
                style={[
                  styles.toggle,
                  { backgroundColor: tokens.surface },
                  editPublic && { backgroundColor: tokens.primary },
                ]}
              >
                <View
                  style={[
                    styles.toggleKnob,
                    { backgroundColor: tokens.controlThumb },
                    editPublic && { transform: [{ translateX: 18 }] },
                  ]}
                />
              </View>
            </View>
          </Pressable>
          <Button
            title={t('lists:updateList')}
            onPress={save}
            loading={saving}
            icon="checkmark-outline"
          />
          <Pressable
            onPress={del}
            disabled={deleteList.isPending}
            style={{
              alignItems: 'center',
              marginTop: spacing.lg,
              paddingVertical: spacing.md,
              opacity: deleteList.isPending ? 0.6 : 1,
            }}
          >
            <T variant="caption" style={{ color: tokens.danger }}>
              {t('lists:deleteList')}
            </T>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  tab: { paddingHorizontal: spacing.md, paddingVertical: 8, borderRadius: 20 },
  toggle: { width: 44, height: 24, borderRadius: 12, padding: 3 },
  toggleKnob: { width: 18, height: 18, borderRadius: 9 },
});
