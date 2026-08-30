import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Spinner, T } from '../primitives';
import { useAppearance } from '../../context/PreferencesProvider';
import { radius, spacing } from '../../theme/theme';

export interface MediaViewerItem {
  id?: string;
  source: string | { uri: string };
  accessibilityLabel?: string;
}

export interface MediaViewerProps {
  visible: boolean;
  /** Backward-compatible single source used by comment images and GIFs. */
  source?: string | { uri: string };
  /** Optional paged gallery. When provided, it supersedes `source`. */
  sources?: MediaViewerItem[];
  initialIndex?: number;
  onClose: () => void;
  isGif?: boolean;
  accessibilityLabel?: string;
  closeLabel?: string;
  previousLabel?: string;
  nextLabel?: string;
  galleryLabel?: string;
  onOpenGallery?: () => void;
  counterLabel?: (current: number, total: number) => string;
  actionLabel?: string;
  actionPending?: boolean;
  onAction?: (index: number) => void;
}

/**
 * Canonical full-screen media viewer for both comments and provider artwork galleries.
 * It preserves the existing native/web close behavior while adding horizontal paging,
 * a total counter, and an optional action for the currently visible image.
 */
export function MediaViewer({
  visible,
  source,
  sources,
  initialIndex = 0,
  onClose,
  isGif = false,
  accessibilityLabel,
  closeLabel,
  previousLabel,
  nextLabel,
  galleryLabel,
  onOpenGallery,
  counterLabel,
  actionLabel,
  actionPending = false,
  onAction,
}: MediaViewerProps) {
  const { tokens } = useAppearance();
  const insets = useSafeAreaInsets();
  const { width: sw, height: sh } = useWindowDimensions();
  const items = useMemo<MediaViewerItem[]>(
    () => (sources?.length ? sources : source ? [{ source, accessibilityLabel }] : []),
    [accessibilityLabel, source, sources],
  );
  const startIndex = Math.max(0, Math.min(initialIndex, Math.max(0, items.length - 1)));
  const [index, setIndex] = useState(startIndex);
  const [loaded, setLoaded] = useState<Set<number>>(new Set());
  const listRef = useRef<FlatList<MediaViewerItem>>(null);
  const indexRef = useRef(startIndex);
  const pushedRef = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  indexRef.current = index;

  const goTo = useCallback(
    (nextIndex: number) => {
      const target = Math.max(0, Math.min(items.length - 1, nextIndex));
      indexRef.current = target;
      setIndex(target);
      listRef.current?.scrollToIndex({ index: target, animated: true });
    },
    [items.length],
  );

  useEffect(() => {
    if (!visible) {
      setLoaded(new Set());
      return;
    }
    setIndex(startIndex);
    if (Platform.OS !== 'web') return;

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current();
      if (event.key === 'ArrowLeft') goTo(indexRef.current - 1);
      if (event.key === 'ArrowRight') goTo(indexRef.current + 1);
    };
    const onPop = () => {
      pushedRef.current = false;
      onCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('popstate', onPop);
    window.history.pushState({ mediaViewer: true }, '');
    pushedRef.current = true;
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('popstate', onPop);
      if (pushedRef.current) {
        pushedRef.current = false;
        window.history.back();
      }
    };
  }, [goTo, startIndex, visible]);

  if (!visible || !items.length) return null;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={[styles.bg, { backgroundColor: tokens.overlayStrong }]}>
        <FlatList
          ref={listRef}
          data={items}
          style={{ width: sw, height: sh, flexGrow: 0 }}
          horizontal
          pagingEnabled
          snapToInterval={sw}
          snapToAlignment="start"
          decelerationRate="fast"
          disableIntervalMomentum
          bounces={false}
          initialScrollIndex={startIndex}
          getItemLayout={(_, itemIndex) => ({
            length: sw,
            offset: sw * itemIndex,
            index: itemIndex,
          })}
          keyExtractor={(item, itemIndex) => item.id ?? String(itemIndex)}
          showsHorizontalScrollIndicator={false}
          onMomentumScrollEnd={(event) => {
            const nextIndex = Math.max(
              0,
              Math.min(items.length - 1, Math.round(event.nativeEvent.contentOffset.x / sw)),
            );
            indexRef.current = nextIndex;
            setIndex(nextIndex);
          }}
          renderItem={({ item, index: itemIndex }) => {
            const src = typeof item.source === 'string' ? { uri: item.source } : item.source;
            return (
              <Pressable style={[styles.page, { width: sw }]} onPress={onClose}>
                {!loaded.has(itemIndex) ? (
                  <View style={styles.loading} pointerEvents="none">
                    <Spinner />
                  </View>
                ) : null}
                <Pressable onPress={(event) => event.stopPropagation()}>
                  <Image
                    source={src as any}
                    style={{ width: sw, height: sh * 0.82 }}
                    contentFit="contain"
                    cachePolicy="memory-disk"
                    transition={150}
                    onLoad={() =>
                      setLoaded((current) => {
                        const next = new Set(current);
                        next.add(itemIndex);
                        return next;
                      })
                    }
                    accessible
                    accessibilityRole="image"
                    accessibilityLabel={
                      item.accessibilityLabel ?? accessibilityLabel ?? (isGif ? 'GIF' : 'Image')
                    }
                  />
                </Pressable>
              </Pressable>
            );
          }}
        />

        {items.length > 1 ? (
          <>
            <Pressable
              style={[
                styles.arrow,
                styles.arrowLeft,
                { backgroundColor: tokens.mediaScrim, opacity: index === 0 ? 0.35 : 1 },
              ]}
              onPress={() => goTo(index - 1)}
              disabled={index === 0}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel={previousLabel ?? 'Previous image'}
            >
              <Ionicons name="chevron-back" size={34} color={tokens.mediaText} />
            </Pressable>
            <Pressable
              style={[
                styles.arrow,
                styles.arrowRight,
                {
                  backgroundColor: tokens.mediaScrim,
                  opacity: index === items.length - 1 ? 0.35 : 1,
                },
              ]}
              onPress={() => goTo(index + 1)}
              disabled={index === items.length - 1}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel={nextLabel ?? 'Next image'}
            >
              <Ionicons name="chevron-forward" size={34} color={tokens.mediaText} />
            </Pressable>
          </>
        ) : null}

        <Pressable
          style={[styles.closeBtn, { top: insets.top + spacing.sm }]}
          onPress={onClose}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel={closeLabel ?? 'Close'}
        >
          <Ionicons name="close" size={30} color={tokens.mediaText} />
        </Pressable>

        {onOpenGallery ? (
          <Pressable
            style={[
              styles.galleryBtn,
              { top: insets.top + spacing.sm, backgroundColor: tokens.mediaScrim },
            ]}
            onPress={onOpenGallery}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel={galleryLabel ?? 'View gallery'}
          >
            <Ionicons name="grid-outline" size={25} color={tokens.mediaText} />
          </Pressable>
        ) : null}

        {items.length > 1 ? (
          <View
            style={[
              styles.counter,
              { top: insets.top + spacing.md, backgroundColor: tokens.mediaScrim },
            ]}
          >
            <T variant="caption" style={{ color: tokens.mediaText }}>
              {counterLabel
                ? counterLabel(index + 1, items.length)
                : `${index + 1} / ${items.length}`}
            </T>
          </View>
        ) : null}

        {onAction && actionLabel ? (
          <Pressable
            style={({ pressed }) => [
              styles.action,
              {
                bottom: insets.bottom + spacing.lg,
                backgroundColor: tokens.primary,
                opacity: pressed || actionPending ? 0.75 : 1,
              },
            ]}
            disabled={actionPending}
            onPress={() => onAction(index)}
            accessibilityRole="button"
            accessibilityLabel={actionLabel}
          >
            {actionPending ? (
              <ActivityIndicator size="small" color={tokens.primaryForeground} />
            ) : (
              <Ionicons name="image-outline" size={18} color={tokens.primaryForeground} />
            )}
            <T variant="body" style={{ color: tokens.primaryForeground }}>
              {actionLabel}
            </T>
          </Pressable>
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  bg: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  page: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  loading: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 2,
    justifyContent: 'center',
    alignItems: 'center',
  },
  closeBtn: { position: 'absolute', right: spacing.lg, zIndex: 10, padding: spacing.sm },
  galleryBtn: {
    position: 'absolute',
    left: spacing.lg,
    zIndex: 10,
    width: 46,
    height: 46,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  arrow: {
    position: 'absolute',
    top: '50%',
    zIndex: 10,
    width: 52,
    height: 52,
    marginTop: -26,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  arrowLeft: { left: spacing.lg },
  arrowRight: { right: spacing.lg },
  counter: {
    position: 'absolute',
    alignSelf: 'center',
    zIndex: 10,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  action: {
    position: 'absolute',
    alignSelf: 'center',
    zIndex: 10,
    minHeight: 44,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
});
