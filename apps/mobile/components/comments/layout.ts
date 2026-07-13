import { StyleSheet } from 'react-native';

/**
 * Max content width (px) for the centered comments feed / thread column.
 * Applies on tablet and desktop so cards never stretch across the full viewport.
 * Mobile uses the full available width.
 */
export const FEED_MAX_WIDTH = 780;

/**
 * Centered feed column: fills the screen on mobile, capped + horizontally
 * centered on tablet/desktop. Apply to the wrapper around the sort bar + list,
 * and to the composer's inner content, so everything stays aligned in one
 * narrow column like a social-network feed.
 */
export const feedColumn = StyleSheet.create({
  root: { width: '100%', maxWidth: FEED_MAX_WIDTH, alignSelf: 'center' as const },
});
