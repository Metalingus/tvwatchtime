import React, { useMemo, useState } from 'react';
import { ActivityIndicator, Dimensions, StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import { useTranslation } from 'react-i18next';
import { T } from './primitives';
import { useAppearance } from '../context/PreferencesProvider';
import { radius, spacing } from '../theme/theme';
import { mediaAspectRatio, commentMediaLayouts } from './comments/media-layout';

/**
 * Renders a posted GIPHY GIF inside a comment/reply. The GIF streams directly
 * from the stored GIPHY URL — never downloaded, proxied, or persisted by us.
 * Uses contentFit="contain" so reaction GIFs are not cropped, with a bounded
 * responsive width and graceful fallback if the remote becomes unavailable.
 */
export function CommentGif({ gifUrl, maxWidth = 300 }: { gifUrl: string; maxWidth?: number }) {
  const { tokens } = useAppearance();
  const { t } = useTranslation(['comments']);
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const imageSource = useMemo(() => ({ uri: gifUrl }), [gifUrl]);
  const loaded = loadedUrl === gifUrl;
  const failed = failedUrl === gifUrl;
  const [size, setSize] = useState<{ url: string; width: number; height: number } | null>(null);
  const remembered = size?.url === gifUrl ? size : commentMediaLayouts.get('gif:' + gifUrl);
  const ratio = mediaAspectRatio(remembered?.width, remembered?.height);

  const screenWidth = Dimensions.get('window').width;
  const width = Math.min(maxWidth, Math.max(160, screenWidth * 0.8));

  if (failed) {
    return (
      <View
        style={[
          styles.fallback,
          { width, backgroundColor: tokens.surfaceElevated, borderColor: tokens.border },
        ]}
      >
        <T variant="micro" muted>
          {t('comments:gifUnavailable')}
        </T>
      </View>
    );
  }

  return (
    <View style={[styles.container, { width, backgroundColor: tokens.surfaceElevated }]}>
      {!loaded ? (
        <View style={styles.loadingOverlay}>
          <ActivityIndicator color={tokens.primary} size="small" />
        </View>
      ) : null}
      <Image
        source={imageSource}
        style={[styles.image, { aspectRatio: ratio ?? 16 / 9 }]}
        contentFit="contain"
        cachePolicy="memory-disk"
        transition={0}
        onLoad={(event) => {
          setLoadedUrl(gifUrl);
          const { width, height } = event.source;
          if (mediaAspectRatio(width, height) === undefined) return;
          commentMediaLayouts.set('gif:' + gifUrl, width, height);
          setSize((previous) =>
            previous?.url === gifUrl && previous.width === width && previous.height === height
              ? previous
              : { url: gifUrl, width, height },
          );
        }}
        onError={() => setFailedUrl(gifUrl)}
        recyclingKey={gifUrl}
        accessible
        accessibilityRole="image"
        accessibilityLabel="GIF"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginTop: spacing.sm,
    borderRadius: radius.md,
    overflow: 'hidden',
    justifyContent: 'center',
  },
  image: {
    width: '100%',
    borderRadius: radius.md,
  },
  loadingOverlay: {
    position: 'absolute',
    alignSelf: 'center',
    top: 0,
    bottom: 0,
    justifyContent: 'center',
    zIndex: 1,
  },
  fallback: {
    marginTop: spacing.sm,
    padding: spacing.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
