import React, { useEffect, useMemo, useState } from 'react';
import { Modal, Platform, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { GalleryImageDto } from '@tvwatch/shared';
import { useAppearance } from '../context/PreferencesProvider';
import { spacing } from '../theme/theme';
import { T } from './primitives';

const GAP = spacing.sm;
const TARGET_TILE_WIDTH = 180;
const MIN_COLUMNS = 2;
const MAX_COLUMNS = 6;

export function ArtworkGalleryGrid({
  visible,
  images,
  title,
  closeLabel,
  imageLabel,
  onClose,
  onSelect,
}: {
  visible: boolean;
  images: GalleryImageDto[];
  title: string;
  closeLabel: string;
  imageLabel: (current: number, total: number) => string;
  onClose: () => void;
  onSelect: (index: number) => void;
}) {
  const { tokens } = useAppearance();
  const insets = useSafeAreaInsets();
  const { width: windowWidth } = useWindowDimensions();
  const [containerWidth, setContainerWidth] = useState(windowWidth);
  const columns = useMemo(
    () =>
      Math.max(
        MIN_COLUMNS,
        Math.min(MAX_COLUMNS, Math.floor((containerWidth + GAP) / (TARGET_TILE_WIDTH + GAP))),
      ),
    [containerWidth],
  );

  useEffect(() => {
    if (!visible || Platform.OS !== 'web') return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose, visible]);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View
        style={[
          styles.root,
          {
            backgroundColor: tokens.background,
            paddingTop: insets.top,
            paddingBottom: insets.bottom,
          },
        ]}
      >
        <View style={[styles.header, { borderBottomColor: tokens.border }]}>
          <T variant="h1">{title}</T>
          <Pressable
            onPress={onClose}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel={closeLabel}
          >
            <Ionicons name="close" size={28} color={tokens.textPrimary} />
          </Pressable>
        </View>
        <View
          style={{ flex: 1 }}
          onLayout={(event) => setContainerWidth(event.nativeEvent.layout.width)}
        >
          <FlashList
            data={images}
            key={`artwork-masonry-${columns}`}
            numColumns={columns}
            masonry
            optimizeItemArrangement
            keyExtractor={(image) => image.id}
            contentContainerStyle={{
              paddingHorizontal: GAP / 2,
              paddingTop: GAP,
              paddingBottom: spacing.lg,
            }}
            renderItem={({ item, index }) => {
              const rawAspect =
                item.width && item.height
                  ? item.width / item.height
                  : item.kind === 'POSTER'
                    ? 2 / 3
                    : 16 / 9;
              const aspectRatio = Math.max(0.5, Math.min(2.2, rawAspect));
              return (
                <Pressable
                  onPress={() => onSelect(index)}
                  style={{ paddingHorizontal: GAP / 2, paddingBottom: GAP }}
                  accessibilityRole="button"
                  accessibilityLabel={imageLabel(index + 1, images.length)}
                >
                  <Image
                    source={{ uri: item.previewUrl ?? item.url }}
                    style={{ aspectRatio, backgroundColor: tokens.surfaceElevated }}
                    contentFit="cover"
                    cachePolicy="memory-disk"
                    recyclingKey={item.id}
                    transition={150}
                  />
                </Pressable>
              );
            }}
          />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    minHeight: 56,
    paddingHorizontal: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
});
