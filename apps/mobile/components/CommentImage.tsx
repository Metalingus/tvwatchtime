import React, { useState } from 'react';
import { Pressable } from 'react-native';
import { Image } from 'expo-image';
import Constants from 'expo-constants';
import { MediaViewer } from './comments/MediaViewer';
import { useAppearance } from '../context/PreferencesProvider';
import { radius } from '../theme/theme';

const BASE_URL = (Constants.expoConfig?.extra as any)?.apiBaseUrl || 'http://localhost:4000/api';

/**
 * Comment image thumbnail with a tap-to-open full-screen viewer.
 *
 * The full-screen lightbox is the shared `MediaViewer` (the single canonical
 * implementation also used by CommentMedia for feed/thread cards). This
 * component is kept for the small thumbnails in the edit dialog; feed/thread
 * cards render media via `CommentMedia` instead.
 */
export function CommentImage({
  imageId,
  width = 120,
  height = 80,
  blurhash,
}: {
  imageId: string;
  width?: number;
  height?: number;
  blurhash?: string | null;
}) {
  const [viewer, setViewer] = useState(false);
  const { tokens } = useAppearance();
  const uri = `${BASE_URL}/comment-images/${imageId}`;

  return (
    <>
      <Pressable onPress={() => setViewer(true)} accessibilityRole="image" accessibilityLabel="Image">
        <Image
          source={{ uri }}
          style={{ width, height, borderRadius: radius.md, backgroundColor: tokens.surfaceElevated }}
          contentFit="cover"
          placeholder={blurhash ? ({ blurhash } as any) : undefined}
          transition={200}
        />
      </Pressable>

      <MediaViewer
        visible={viewer}
        source={uri}
        onClose={() => setViewer(false)}
        accessibilityLabel="Image"
      />
    </>
  );
}
