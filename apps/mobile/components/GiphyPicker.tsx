import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { MasonryFlashList } from '@shopify/flash-list';
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

// Responsive grid tuning. Columns scale with the measured container width.
const TARGET_TILE_WIDTH = 150;
const GAP = spacing.sm;
const MIN_COLUMNS = 2;
const MAX_COLUMNS = 4;
const ESTIMATED_ITEM_SIZE = 180;
// Default aspect for the GIPHY "Powered By" horizontal badge until its real
// dimensions are read from the onLoad event.
const LOGO_DEFAULT_ASPECT = 2.6;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function GiphyPicker({ visible, lang, onClose, onSelect }: Props) {
  const { tokens, resolvedTheme } = useAppearance();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation(['comments', 'common']);
  const { width: winWidth } = useWindowDimensions();
  const [query, setQuery] = useState('');
  const [containerWidth, setContainerWidth] = useState(winWidth);
  const [logoAspect, setLogoAspect] = useState(LOGO_DEFAULT_ASPECT);
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

  // Measured container width drives the column count (reacts to resize,
  // rotation, split-screen, tablet). Fall back to the window width pre-layout.
  const effectiveWidth = containerWidth > 0 ? containerWidth : winWidth;
  const numColumns = clamp(
    Math.floor((effectiveWidth + GAP) / (TARGET_TILE_WIDTH + GAP)),
    MIN_COLUMNS,
    MAX_COLUMNS,
  );
  const columnSlot = effectiveWidth / numColumns;

  const handleSelect = (gif: GiphyGif) => {
    fireAnalytics(gif.analytics?.onclick);
    onSelect(gif);
  };

  const handleEndReached = () => {
    // Guard against duplicate pagination: the hook also dedups via loadingMoreRef.
    if (status !== 'loadingMore' && hasMore) loadMore();
  };

  const close = () => {
    setQuery('');
    onClose();
  };

  const renderCell = ({ item: gif }: { item: GiphyGif }) => {
    const aspect = gif.width && gif.height ? gif.width / gif.height : 1;
    return (
      <Pressable
        onPress={() => handleSelect(gif)}
        accessibilityRole="button"
        accessibilityLabel={gif.title || t('comments:gif')}
        style={[styles.cell, { paddingHorizontal: GAP / 2, paddingBottom: GAP }]}
      >
        <Image
          source={{ uri: gif.previewUrl }}
          style={[styles.cellImage, { aspectRatio: aspect, backgroundColor: tokens.surfaceElevated }]}
          contentFit="cover"
          cachePolicy="none"
          recyclingKey={gif.id}
          transition={150}
          onLoad={() => {
            // Fire GIPHY "onload" analytics once per id per picker session,
            // even across cell recycling.
            if (!onloadFiredRef.current.has(gif.id)) {
              onloadFiredRef.current.add(gif.id);
              fireAnalytics(gif.analytics?.onload);
            }
          }}
        />
      </Pressable>
    );
  };

  const showConfigError = !hasKey;
  const initialLoading = status === 'loading';
  const showError = status === 'error';
  const showEmpty = status === 'empty';

  const logoSource =
    resolvedTheme === 'dark'
      ? require('../assets/PoweredBy_200px-White_HorizLogo.png')
      : require('../assets/PoweredBy_200px-Black_HorizLogo.png');

  return (
    <Modal visible={visible} animationType="slide" transparent={false} onRequestClose={close} statusBarTranslucent>
      <View style={[styles.root, { backgroundColor: tokens.background, paddingTop: insets.top }]}>
        <View style={[styles.header, { borderBottomColor: tokens.border }]}>
          <View style={styles.headerLeft}>
            <T variant="h1">{t('comments:chooseGif')}</T>
            <Image
              source={logoSource}
              style={{ height: 16, width: 16 * logoAspect }}
              contentFit="contain"
              transition={0}
              accessible
              accessibilityRole="image"
              accessibilityLabel="Powered by GIPHY"
              onLoad={(e) => {
                const s = e.source;
                if (s && s.width && s.height) setLogoAspect(s.width / s.height);
              }}
            />
          </View>
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
          <View
            style={{ flex: 1 }}
            onLayout={(e) => setContainerWidth(e.nativeEvent.layout.width)}
          >
            {/* key remount on column change avoids dynamic-numColumns layout glitches */}
            <MasonryFlashList
              data={items}
              key={`masonry-${numColumns}`}
              numColumns={numColumns}
              estimatedItemSize={ESTIMATED_ITEM_SIZE}
              optimizeItemArrangement
              overrideItemLayout={(layout, item: GiphyGif) => {
                const aspect = item.width && item.height ? item.width / item.height : 1;
                // Estimated cell height so MasonryFlashList can pack the
                // shortest column. It self-corrects after measuring each cell.
                layout.size = (columnSlot - GAP) / aspect + GAP;
              }}
              keyExtractor={(gif: GiphyGif) => gif.id}
              renderItem={renderCell}
              onEndReached={handleEndReached}
              onEndReachedThreshold={0.5}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{ paddingHorizontal: GAP / 2, paddingBottom: insets.bottom + spacing.lg }}
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
          </View>
        )}
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
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
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
  cell: {},
  cellImage: { width: '100%', borderRadius: radius.md },
});
