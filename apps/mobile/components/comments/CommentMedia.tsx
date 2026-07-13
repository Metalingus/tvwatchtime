import React, { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import { Image } from 'expo-image';
import Constants from 'expo-constants';
import { useTranslation } from 'react-i18next';
import type { CommentImageDto } from '@tvwatch/shared';
import { T } from '../primitives';
import { useAppearance } from '../../context/PreferencesProvider';
import { radius, spacing } from '../../theme/theme';
import { MediaViewer } from './MediaViewer';

const BASE_URL = (Constants.expoConfig?.extra as any)?.apiBaseUrl || 'http://localhost:4000/api';
const DEFAULT_IMAGE_RATIO = 4 / 3;
const DEFAULT_GIF_RATIO = 16 / 9;

/**
 * Renders a comment's image or GIF attachment inside a feed/thread card.
 *
 * - Fills the available card width (`width: '100%'` + `aspectRatio`) so media is
 *   never a tiny strip beside a huge empty area.
 * - Preserves the original aspect ratio; height is capped (viewport-based on
 *   mobile, ~560px on desktop). Tall media is letterboxed and centered via
 *   `contentFit="contain"`.
 * - Tapping the media opens the shared full-screen `MediaViewer` and stops
 *   propagation so it never triggers the card's open-thread action.
 */
export function CommentMedia({
  image,
  gifUrl,
}: {
  image?: CommentImageDto | null;
  gifUrl?: string | null;
}) {
  const { tokens } = useAppearance();
  const { t } = useTranslation(['comments', 'common']);
  const { height: screenH } = useWindowDimensions();
  const [viewer, setViewer] = useState(false);
  const [gifRatio, setGifRatio] = useState<number>(DEFAULT_GIF_RATIO);

  const maxH = Math.min(screenH * 0.6, 560);

  // Image still processing/moderating — show a bounded placeholder.
  if (image && image.status !== 'ready' && image.status !== 'rejected' && image.status !== 'deleted') {
    return (
      <View style={[styles.placeholder, { backgroundColor: tokens.surfaceElevated, height: Math.min(maxH, 220) }]}>
        <ActivityIndicator color={tokens.primary} size="small" />
        <T variant="micro" style={{ color: tokens.textMuted, marginTop: spacing.xs }}>
          {t('common:processing')}
        </T>
      </View>
    );
  }

  const hasImage = !!image && image.status === 'ready';
  const hasGif = !!gifUrl;
  if (!hasImage && !hasGif) return null;

  const ratio = hasImage
    ? image!.width && image!.height
      ? image!.width / image!.height
      : DEFAULT_IMAGE_RATIO
    : gifRatio;
  const src = hasImage ? { uri: `${BASE_URL}/comment-images/${image!.id}` } : { uri: gifUrl! };
  const label = hasGif ? t('comments:gif') : t('comments:imageTitle');

  return (
    <>
      <Pressable
        onPress={(e) => {
          e?.stopPropagation?.();
          setViewer(true);
        }}
        style={styles.mediaWrap}
        accessibilityRole="button"
        accessibilityLabel={t('comments:viewMedia')}
      >
        <Image
          source={src as any}
          style={[styles.media, { aspectRatio: ratio, maxHeight: maxH }]}
          contentFit="contain"
          placeholder={image?.blurhash ? ({ blurhash: image.blurhash } as any) : undefined}
          transition={200}
          cachePolicy="memory-disk"
          onLoad={(e: any) => {
            const w = e?.source?.width;
            const h = e?.source?.height;
            if (hasGif && w && h) setGifRatio(w / h);
          }}
        />
      </Pressable>

      <MediaViewer
        visible={viewer}
        source={src}
        onClose={() => setViewer(false)}
        isGif={hasGif}
        accessibilityLabel={label}
      />
    </>
  );
}

const styles = StyleSheet.create({
  mediaWrap: { marginTop: spacing.sm, width: '100%' },
  media: { width: '100%', borderRadius: radius.md, backgroundColor: 'transparent' },
  placeholder: {
    width: '100%',
    borderRadius: radius.md,
    marginTop: spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
