/** Extra band below the header in which a tap counts as a missed header control. */
export const HEADER_NEAR_MISS_SLOP = 12;

/**
 * True when a hero tap landed in the header band (safe-area inset + header + slop) without
 * hitting a header control — a fat-fingered back/menu press must not open the gallery.
 * Unknown coordinates fall back to a normal hero tap.
 */
export function isHeaderNearMiss(
  touchWindowY: number | undefined,
  heroWindowY: number | undefined,
  headerBand: number,
): boolean {
  if (!Number.isFinite(touchWindowY) || !Number.isFinite(heroWindowY)) return false;
  return touchWindowY! - heroWindowY! < headerBand;
}
