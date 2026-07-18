export interface CommunityGroup {
  /** Stable slug used as the comment thread id (threadType 'GROUP'). Never renamed once shipped. */
  id: string;
  /** Ionicons glyph name used by the mobile app. */
  icon: string;
  /** Pinned groups are featured at the top of the groups list. */
  pinned: boolean;
}

/**
 * Curated community discussion forums. Groups have no DB table: a group's discussion
 * is a comment thread keyed by (threadType 'GROUP', threadId = group id). Display
 * names are localized in the mobile app under `groups:names.<id>`.
 */
export const COMMUNITY_GROUPS: readonly CommunityGroup[] = [
  { id: 'general-discussion', icon: 'chatbubbles-outline', pinned: true },
  { id: 'what-should-i-watch', icon: 'bulb-outline', pinned: true },
  { id: 'action-adventure', icon: 'flash-outline', pinned: false },
  { id: 'anime', icon: 'sparkles-outline', pinned: false },
  { id: 'animation', icon: 'color-wand-outline', pinned: false },
  { id: 'comedy', icon: 'happy-outline', pinned: false },
  { id: 'crime-mystery-thriller', icon: 'finger-print-outline', pinned: false },
  { id: 'documentary-true-crime', icon: 'videocam-outline', pinned: false },
  { id: 'drama', icon: 'heart-half-outline', pinned: false },
  { id: 'fantasy-supernatural', icon: 'planet-outline', pinned: false },
  { id: 'horror', icon: 'skull-outline', pinned: false },
  { id: 'reality-competition', icon: 'trophy-outline', pinned: false },
  { id: 'romance', icon: 'heart-outline', pinned: false },
  { id: 'science-fiction', icon: 'rocket-outline', pinned: false },
  { id: 'kids-family', icon: 'people-outline', pinned: false },
  { id: 'soap-operas-telenovelas', icon: 'tv-outline', pinned: false },
  { id: 'sports-wrestling', icon: 'barbell-outline', pinned: false },
  { id: 'history-war', icon: 'shield-outline', pinned: false },
  { id: 'food-travel-lifestyle', icon: 'restaurant-outline', pinned: false },
  { id: 'k-dramas-asian-dramas', icon: 'flower-outline', pinned: false },
] as const;

const GROUP_ID_SET: ReadonlySet<string> = new Set(COMMUNITY_GROUPS.map((g) => g.id));

export function isCommunityGroupId(id: string | undefined | null): boolean {
  return !!id && GROUP_ID_SET.has(id);
}
