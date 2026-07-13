import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Dimensions,
  FlatList,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { EmptyState, T } from './primitives';
import { useAppearance } from '../context/PreferencesProvider';
import { radius, spacing } from '../theme/theme';
import { fireAnalytics } from '../lib/giphy/analytics';
import { selectGiphyApiKey, type GiphyGif } from '../lib/giphy/client';
import { useGiphyResults } from '../lib/giphy/useGiphyResults';

interface Props {
  visible: boolean;
  lang: string;
  onClose: () => void;
  onSelect: (gif: GiphyGif) => void;
}

function useColumns(): number {
  const width = Dimensions.get('window').width;
  if (Platform.OS === 'web') {
    if (width >= 900) return 4;
    if (width >= 640) return 3;
    return 2;
  }
  return 2;
}

const ROW_GAP = spacing.sm;

export function GiphyPicker({ visible, lang, onClose, onSelect }: Props) {
  const { tokens } = useAppearance();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation(['comments', 'common']);
  const [query, setQuery] = useState('');
  const columns = useColumns();
  const onloadFiredRef = useRef<Set<string>>(new Set());

  const hasKey = useMemo(() => !!selectGiphyApiKey(), []);
  const { items, status, hasMore, isSearch, loadMore, reload } = useGiphyResults(
    query,
    lang,
    visible && hasKey,
  );

  // Per-session onload analytics tracking — reset each time the picker opens.
  useEffect(() => {
    if (visible) onloadFiredRef.current = new Set();
  }, [visible]);

  // Web: Escape closes + background scroll lock while the modal is open.
  useEffect(() => {
    if (!visible || Platform.OS !== 'web') return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKey);
    };
  }, [visible, onClose]);

  const screenWidth = Dimensions.get('window').width;
  const gridWidth = Platform.OS === 'web' ? Math.min(screenWidth, 760) : screenWidth;
  const colWidth = Math.max(80, Math.floor((gridWidth - (columns - 1) * ROW_GAP) / columns));

  const rows = useMemo(() => {
    const out: GiphyGif[][] = [];
    for (let i = 0; i < items.length; i += columns) out.push(items.slice(i, i + columns));
    return out;
  }, [items, columns]);

  const handleSelect = (gif: GiphyGif) => {
    fireAnalytics(gif.analytics?.onclick);
    onSelect(gif);
  };

  const close = () => {
    setQuery('');
    onClose();
  };

  const renderCell = (gif: GiphyGif) => {
    const aspect = gif.width && gif.height ? gif.width / gif.height : 1;
    const cellHeight = Math.max(80, Math.round(colWidth / aspect));
    return (
      <Pressable
        onPress={() => handleSelect(gif)}
        accessibilityRole="button"
        accessibilityLabel={gif.title || t('comments:gif')}
        style={({ pressed }) => [
          styles.cell,
          { width: colWidth, height: cellHeight, backgroundColor: tokens.surfaceElevated, opacity: pressed ? 0.85 : 1 },
        ]}
        onLayout={() => {
          if (!onloadFiredRef.current.has(gif.id)) {
            onloadFiredRef.current.add(gif.id);
            fireAnalytics(gif.analytics?.onload);
          }
        }}
      >
        <Image
          source={{ uri: gif.previewUrl }}
          style={styles.cellImage}
          contentFit="cover"
          cachePolicy="memory"
          recyclingKey={gif.id}
          transition={150}
        />
      </Pressable>
    );
  };

  const renderRow = ({ item: row }: { item: GiphyGif[] }) => {
    const spacers = columns - row.length;
    return (
      <View style={[styles.row, { marginBottom: ROW_GAP }]}>
        {row.map((gif, idx) => (
          <View key={gif.id} style={[styles.cellWrap, { width: colWidth, marginRight: idx < row.length - 1 ? ROW_GAP : 0 }]}>
            {renderCell(gif)}
          </View>
        ))}
        {spacers > 0
          ? Array.from({ length: spacers }).map((_, i) => (
              <View key={`spacer-${i}`} style={{ width: colWidth }} />
            ))
          : null}
      </View>
    );
  };

  const showConfigError = !hasKey;
  const initialLoading = status === 'loading';
  const showError = status === 'error';
  const showEmpty = status === 'empty';

  return (
    <Modal visible={visible} animationType="slide" transparent={false} onRequestClose={close} statusBarTranslucent>
      <View style={[styles.root, { backgroundColor: tokens.background, paddingTop: insets.top }]}>
        <View style={[styles.header, { borderBottomColor: tokens.border }]}>
          <T variant="h1">{t('comments:chooseGif')}</T>
          <Pressable onPress={close} hitSlop={12} accessibilityRole="button" accessibilityLabel={t('common:close')}>
            <Ionicons name="close" size={26} color={tokens.textPrimary} />
          </Pressable>
        </View>

        {!showConfigError ? (
          <View style={[styles.searchWrap, { backgroundColor: tokens.surface, borderColor: tokens.border }]}>
            <Ionicons name="search-outline" size={18} color={tokens.textMuted} style={{ marginLeft: spacing.md }} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder={t('comments:searchGifs')}
              placeholderTextColor={tokens.placeholder}
              accessibilityLabel={t('comments:searchGifs')}
              maxLength={50}
              style={[styles.searchInput, { color: tokens.textPrimary }]}
            />
            {query.length > 0 ? (
              <Pressable
                onPress={() => setQuery('')}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel={t('common:clear')}
                style={{ paddingHorizontal: spacing.md }}
              >
                <Ionicons name="close-circle" size={18} color={tokens.textMuted} />
              </Pressable>
            ) : null}
          </View>
        ) : null}

        {showConfigError ? (
          <View style={styles.center}>
            <Ionicons name="warning-outline" size={48} color={tokens.textMuted} />
            <T variant="h2" style={{ marginTop: spacing.md }}>{t('comments:giphyConfigError')}</T>
          </View>
        ) : initialLoading ? (
          <View style={styles.center}>
            <ActivityIndicator color={tokens.primary} size="large" />
            <T variant="body" muted style={{ marginTop: spacing.md }}>
              {isSearch ? t('comments:searchGifs') : t('comments:trendingGifs')}
            </T>
          </View>
        ) : showError ? (
          <View style={styles.center}>
            <EmptyState title={t('comments:unableToLoadGifs')} icon="cloud-offline-outline" />
            <Pressable
              onPress={reload}
              style={[styles.retryBtn, { backgroundColor: tokens.primary }]}
              accessibilityRole="button"
              accessibilityLabel={t('comments:retry')}
            >
              <T variant="h2" style={{ color: tokens.primaryForeground }}>{t('comments:retry')}</T>
            </Pressable>
          </View>
        ) : showEmpty ? (
          <View style={styles.center}>
            <EmptyState title={t('comments:noGifs')} icon="sad-outline" />
          </View>
        ) : (
          <FlatList
            data={rows}
            keyExtractor={(row, i) => row[0]?.id ?? `row-${i}`}
            renderItem={renderRow}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ padding: spacing.sm, paddingBottom: insets.bottom + spacing.lg }}
            onEndReached={() => loadMore()}
            onEndReachedThreshold={0.5}
            ListFooterComponent={
              status === 'loadingMore' ? (
                <ActivityIndicator color={tokens.primary} style={{ padding: spacing.md }} />
              ) : !hasMore && items.length > 0 ? (
                <T variant="micro" muted style={{ textAlign: 'center', paddingVertical: spacing.md }}>
                  {t('comments:reachedEnd')}
                </T>
              ) : null
            }
          />
        )}

        <View style={[styles.attribution, { borderTopColor: tokens.border, paddingBottom: insets.bottom + spacing.xs }]}>
          <T variant="micro" muted>Powered by GIPHY</T>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
  },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: spacing.md,
    marginVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  searchInput: {
    flex: 1,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.sm,
    fontSize: 14,
  },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  retryBtn: {
    marginTop: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xl,
    borderRadius: radius.pill,
  },
  row: { flexDirection: 'row', justifyContent: 'flex-start', alignItems: 'flex-start' },
  cellWrap: {},
  cell: { borderRadius: radius.md, overflow: 'hidden' },
  cellImage: { flex: 1, borderRadius: radius.md },
  attribution: { alignItems: 'center', paddingVertical: spacing.xs, borderTopWidth: 1 },
});
