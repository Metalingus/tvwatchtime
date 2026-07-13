import React, { useEffect, useRef, useState } from 'react';
import { Modal, Platform, Pressable, StyleSheet, useWindowDimensions } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { Spinner } from '../primitives';
import { useAppearance } from '../../context/PreferencesProvider';
import { spacing } from '../../theme/theme';

export interface MediaViewerProps {
  visible: boolean;
  /** Image source: a remote URI string or an expo-image source object. */
  source: string | { uri: string };
  onClose: () => void;
  isGif?: boolean;
  accessibilityLabel?: string;
}

/**
 * Shared full-screen media lightbox for comment images and GIFs.
 *
 * - Close via the close button, Android hardware back (onRequestClose), Escape
 *   on web, and the browser back button on web (via a pushed history entry).
 * - GIFs keep animating (expo-image animates GIF sources by default).
 * - `contentFit="contain"` preserves the original aspect ratio and centers the
 *   media when it does not fill the viewport.
 *
 * This is the single canonical viewer reused by CommentImage (edit dialog) and
 * CommentMedia (feed/thread cards) — do not introduce a second implementation.
 */
export function MediaViewer({ visible, source, onClose, isGif = false, accessibilityLabel }: MediaViewerProps) {
  const { tokens } = useAppearance();
  const { width: sw, height: sh } = useWindowDimensions();
  const [loaded, setLoaded] = useState(false);
  const pushedRef = useRef(false);
  // Keep the latest onClose in a ref so the web history/keys effect only depends
  // on `visible` (otherwise an unstable onClose re-runs the effect and thrashes
  // the browser history while the viewer is open).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!visible) {
      setLoaded(false);
      return;
    }
    if (Platform.OS !== 'web') return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    const onPop = () => {
      // Browser back (or our own history.back() cleanup) closes the viewer.
      pushedRef.current = false;
      onCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('popstate', onPop);
    // Push a history entry so the browser back button closes the viewer instead
    // of navigating away from the app.
    window.history.pushState({ mediaViewer: true }, '');
    pushedRef.current = true;

    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('popstate', onPop);
      // If we still own the pushed entry (closed via button/Escape rather than
      // back), pop it so the browser history stays consistent.
      if (pushedRef.current) {
        pushedRef.current = false;
        window.history.back();
      }
    };
  }, [visible]);

  if (!visible) return null;

  const src = typeof source === 'string' ? { uri: source } : source;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={[styles.bg, { backgroundColor: tokens.overlayStrong }]} onPress={onClose}>
        <Pressable
          style={styles.closeBtn}
          onPress={onClose}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel ?? 'Close'}
        >
          <Ionicons name="close" size={30} color={tokens.mediaText} />
        </Pressable>
        {!loaded ? <Spinner /> : null}
        <Pressable style={styles.imageWrap} onPress={(e) => e.stopPropagation()}>
          <Image
            source={src as any}
            style={{ width: sw, height: sh * 0.82 }}
            contentFit="contain"
            cachePolicy="memory-disk"
            transition={150}
            onLoad={() => setLoaded(true)}
            accessible
            accessibilityRole="image"
            accessibilityLabel={accessibilityLabel ?? (isGif ? 'GIF' : 'Image')}
          />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  bg: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  closeBtn: { position: 'absolute', top: 50, right: 20, zIndex: 10, padding: spacing.sm },
  imageWrap: { justifyContent: 'center', alignItems: 'center' },
});
