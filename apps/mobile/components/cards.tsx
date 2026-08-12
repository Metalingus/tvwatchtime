import React, { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleProp, StyleSheet, View, ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Swipeable } from 'react-native-gesture-handler';
import { Link, router } from 'expo-router';
import {
  Card,
  EmptyState,
  PosterImage,
  ProgressBar,
  SectionHeader,
  StatusChip,
  T,
  WatchButton,
  useWatchMenu,
  AnimatedFlatList,
} from './primitives';
import { useAppearance } from '../context/PreferencesProvider';
import { radius, spacing } from '../theme/theme';
import { useTranslation } from 'react-i18next';
import { firstNetwork } from '@tvwatch/shared';
import { useContentWidth } from '../hooks/useContentWidth';
import { useToggleMovieWatchlist, useToggleWatchlist } from '../api/hooks';

type MediaLibraryBadgeProps = {
  id: string;
  kind: 'shows' | 'movies';
  inWatchlist?: boolean;
  watched?: boolean;
  style?: StyleProp<ViewStyle>;
};

type WatchlistToggleBadgeProps = Omit<MediaLibraryBadgeProps, 'kind' | 'watched'> & {
  pending: boolean;
  toggle: (variables: { id: string; on: boolean }, options?: { onError?: () => void }) => void;
};

function WatchlistToggleBadge({
  id,
  inWatchlist = false,
  style,
  pending,
  toggle,
}: WatchlistToggleBadgeProps) {
  const { tokens } = useAppearance();
  const { t } = useTranslation(['showDetail']);
  const [selected, setSelected] = useState(inWatchlist);

  useEffect(() => setSelected(inWatchlist), [inWatchlist]);

  const onPress = (event: any) => {
    event.stopPropagation?.();
    event.preventDefault?.();
    if (pending) return;
    const previous = selected;
    const next = !previous;
    setSelected(next);
    toggle({ id, on: next }, { onError: () => setSelected(previous) });
  };

  return (
    <Pressable
      onPress={onPress}
      disabled={pending}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={t(selected ? 'inWatchlist' : 'addWatchlist')}
      accessibilityState={{ selected, busy: pending }}
      style={[styles.libraryBadgeHitTarget, style]}
    >
      <View
        style={[
          styles.libraryBadge,
          {
            backgroundColor: selected ? tokens.warning : tokens.mediaScrim,
            borderColor: tokens.warning,
            borderWidth: selected ? 0 : 1,
            opacity: pending ? 0.7 : 1,
          },
        ]}
      >
        <Ionicons
          name={selected ? 'bookmark' : 'bookmark-outline'}
          size={14}
          color={selected ? tokens.primaryForeground : tokens.warning}
        />
      </View>
    </Pressable>
  );
}

function ShowWatchlistBadge(props: Omit<MediaLibraryBadgeProps, 'kind' | 'watched'>) {
  const mutation = useToggleWatchlist();
  return <WatchlistToggleBadge {...props} pending={mutation.isPending} toggle={mutation.mutate} />;
}

function MovieWatchlistBadge(props: Omit<MediaLibraryBadgeProps, 'kind' | 'watched'>) {
  const mutation = useToggleMovieWatchlist();
  return <WatchlistToggleBadge {...props} pending={mutation.isPending} toggle={mutation.mutate} />;
}

/**
 * Viewer-library status/control for poster overlays. Watched movies render a
 * non-destructive green eye; every other card renders a large watchlist target.
 */
export function MediaLibraryBadge({
  id,
  kind,
  inWatchlist = false,
  watched = false,
  style,
}: MediaLibraryBadgeProps) {
  const { tokens } = useAppearance();
  const { t } = useTranslation(['common']);

  if (kind === 'movies' && watched) {
    return (
      <View
        pointerEvents="none"
        accessibilityLabel={t('watched')}
        style={[styles.libraryBadgeHitTarget, style]}
      >
        <View style={[styles.libraryBadge, { backgroundColor: tokens.watched }]}>
          <Ionicons name="eye" size={14} color={tokens.primaryForeground} />
        </View>
      </View>
    );
  }

  const props = { id, inWatchlist, style };
  return kind === 'shows' ? <ShowWatchlistBadge {...props} /> : <MovieWatchlistBadge {...props} />;
}

function PosterCardImpl({
  id,
  kind,
  title,
  poster,
  progress,
  rating,
  year,
  width = 130,
  style,
  typeBadge = false,
  showLibraryControl = false,
  showWatchlistControl = true,
  inWatchlist = false,
  watched = false,
}: {
  id: string;
  kind: 'shows' | 'movies';
  title: string;
  poster?: string | null;
  progress?: number;
  /** TMDB vote average (1..10) — shown as a star badge on the poster when > 0. */
  rating?: number | null;
  /** Release/start year — small caption line under the title. */
  year?: number | null;
  width?: number;
  style?: StyleProp<ViewStyle>;
  /** Mixed-type grids (search): small tv/film icon badge on the poster's bottom-left. */
  typeBadge?: boolean;
  /** Show the current viewer's watched/watchlist state and quick watchlist control. */
  showLibraryControl?: boolean;
  /** When false, suppress watchlist controls while retaining a watched-movie badge. */
  showWatchlistControl?: boolean;
  inWatchlist?: boolean;
  watched?: boolean;
}) {
  const { tokens } = useAppearance();
  const h = width * 1.5;
  const route = kind === 'shows' ? 'show' : 'movie';

  const cardStyle = StyleSheet.flatten([
    {
      width,
      marginRight: spacing.md,
      position: 'relative' as const,
    },
    style,
  ]);

  return (
    <View style={cardStyle}>
      <Link href={`/${route}/${id}` as any} asChild>
        <Pressable style={{ width }}>
          <View style={{ borderRadius: radius.md, overflow: 'hidden' }}>
            <PosterImage uri={poster} style={{ width, height: h }} transition={0} />

            {rating != null && rating > 0 ? (
              <View
                style={{
                  position: 'absolute',
                  top: 4,
                  left: 4,
                  flexDirection: 'row',
                  alignItems: 'center',
                  backgroundColor: tokens.mediaScrim,
                  borderRadius: radius.sm,
                  paddingHorizontal: 4,
                  paddingVertical: 2,
                }}
              >
                <Ionicons name="star" size={10} color={tokens.warning} />
                <T variant="micro" style={{ color: tokens.mediaText, marginLeft: 2 }}>
                  {rating.toFixed(1)}
                </T>
              </View>
            ) : null}

            {typeBadge ? (
              <View
                style={{
                  position: 'absolute',
                  bottom: 4,
                  left: 4,
                  backgroundColor: tokens.mediaScrim,
                  borderRadius: radius.sm,
                  padding: 3,
                }}
                pointerEvents="none"
              >
                <Ionicons
                  name={kind === 'shows' ? 'tv-outline' : 'film-outline'}
                  size={11}
                  color={tokens.mediaText}
                />
              </View>
            ) : null}

            {progress !== undefined ? (
              <View
                style={{
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  bottom: 0,
                  padding: 4,
                }}
              >
                <ProgressBar
                  value={progress}
                  color={progress >= 1 ? tokens.watched : tokens.primary}
                />
              </View>
            ) : null}
          </View>

          <T variant="caption" numberOfLines={2} style={{ marginTop: 6 }}>
            {title}
          </T>
          {year ? (
            <T variant="micro" muted numberOfLines={1} style={{ marginTop: 2 }}>
              {year}
            </T>
          ) : null}
        </Pressable>
      </Link>
      {showLibraryControl && (showWatchlistControl || (kind === 'movies' && watched)) ? (
        <MediaLibraryBadge id={id} kind={kind} inWatchlist={inWatchlist} watched={watched} />
      ) : null}
    </View>
  );
}

// Memoized: big grids (Movies tab, My Shows) rebuild their row arrays on every
// paginated append, and re-rendering every visible PosterCard made the posters
// flicker. `style` is intentionally excluded from the comparison — call sites
// only pass static layout constants (e.g. { marginRight: 0 }).
export const PosterCard = React.memo(
  PosterCardImpl,
  (prev, next) =>
    prev.id === next.id &&
    prev.kind === next.kind &&
    prev.title === next.title &&
    prev.poster === next.poster &&
    prev.progress === next.progress &&
    prev.rating === next.rating &&
    prev.year === next.year &&
    prev.width === next.width &&
    prev.typeBadge === next.typeBadge &&
    prev.showLibraryControl === next.showLibraryControl &&
    prev.showWatchlistControl === next.showWatchlistControl &&
    prev.inWatchlist === next.inWatchlist &&
    prev.watched === next.watched,
);

export function PosterGrid({
  data,
  kind,
  emptyTitle,
  emptyCta,
  minCardWidth = 96,
}: {
  data: any[];
  kind: 'shows' | 'movies';
  emptyTitle: string;
  emptyCta?: string;
  minCardWidth?: number;
}) {
  const width = useContentWidth();
  if (!data || data.length === 0)
    return <EmptyState title={emptyTitle} cta={emptyCta} icon="layers-outline" />;
  const containerW = width - spacing.lg * 2;
  const gap = spacing.sm;
  // Minimum 3 cards per row — 2-wide poster grids look sparse on phones.
  const cols = Math.max(3, Math.floor((containerW + gap) / (minCardWidth + gap)));
  const cellW = Math.floor((containerW - gap * (cols - 1)) / cols);
  const rows: any[][] = [];
  for (let i = 0; i < data.length; i += cols) rows.push(data.slice(i, i + cols));
  return (
    <View>
      {rows.map((row, ri) => (
        <View
          key={ri}
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            marginBottom: spacing.sm,
          }}
        >
          {row.map((it) => (
            <PosterCard
              key={it.id}
              id={it.id}
              kind={kind}
              title={it.title}
              poster={it.images?.poster ?? it.posterUrl}
              progress={it.userProgress ?? (it.watched ? 1 : undefined)}
              rating={it.rating}
              year={cardYear(it)}
              width={cellW}
              style={{ marginRight: 0 }}
            />
          ))}
          {Array.from({ length: cols - row.length }).map((_, fi) => (
            <View key={'f' + fi} style={{ width: cellW }} />
          ))}
        </View>
      ))}
    </View>
  );
}

// Progress bars are only meaningful for shows the user tracks: in mixed lists
// (explore/trending/related) an untouched show would otherwise render an empty bar.
export function cardProgress(item: any): number | undefined {
  if (item.inWatchlist || item.favorite || (item.userProgress ?? 0) > 0) return item.userProgress;
  return undefined;
}

// Cards get a unified `year` from lite/list DTOs; full ShowDto/MovieDto expose
// yearStart/releaseYear instead. Pick whichever the row carries.
export function cardYear(item: any): number | null {
  return item?.year ?? item?.yearStart ?? item?.releaseYear ?? null;
}

// ---------------- Horizontal carousel ----------------
export function Carousel({
  title,
  action,
  onAction,
  data,
  kind,
  width = 120,
  showLibraryControl = false,
}: {
  title: string;
  action?: string;
  onAction?: () => void;
  data: any[];
  kind: 'shows' | 'movies';
  width?: number;
  showLibraryControl?: boolean;
}) {
  if (!data || data.length === 0) return null;
  return (
    <View style={{ marginBottom: spacing.lg }}>
      <View style={{ paddingHorizontal: spacing.lg }}>
        <SectionHeader title={title} action={action} onAction={onAction} />
      </View>
      {/* AnimatedFlatList: refreshed rails morph (insert/reorder/remove)
          instead of swapping wholesale under the user's finger. */}
      <AnimatedFlatList
        horizontal
        data={data}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: spacing.lg }}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <PosterCard
            id={item.id}
            kind={kind}
            title={item.title}
            poster={item.images?.poster ?? item.posterUrl}
            progress={cardProgress(item)}
            rating={item.rating}
            year={cardYear(item)}
            width={width}
            showLibraryControl={showLibraryControl}
            inWatchlist={item.inWatchlist}
            watched={item.watched}
          />
        )}
      />
    </View>
  );
}

// ---------------- Episode card (watch list row) ----------------
/** Horizontal space reserved for the absolute watch button (26px + a small gap). */
const WATCH_BTN_CLEARANCE = 26 + spacing.xs;

function EpisodeCardImpl({
  item,
  onMarkWatched,
  onRewatch,
  onUnwatchOnce,
  onUnwatch,
}: {
  item: any;
  onMarkWatched?: () => void;
  onRewatch?: () => void;
  onUnwatchOnce?: () => void;
  onUnwatch?: () => void;
}) {
  const swipeRef = useRef<any>(null);
  const { tokens } = useAppearance();
  const { t } = useTranslation(['common']);
  const menu = useWatchMenu();
  const watched = !!item.episode.watched;
  const handleWatch = () =>
    menu({
      watched,
      watchCount: item.episode.watchCount ?? 0,
      onMarkWatched,
      onRewatch,
      onUnwatchOnce,
      onUnwatch,
    });

  const cardContent = (
    <View style={[styles.epCard, { backgroundColor: tokens.surface }]}>
      {/* Header: show title (tap → show page) + network. Sibling of the nav
          pressable below so it keeps its own action; the still stays clear. */}
      <View style={styles.epHeader}>
        <Pressable
          onPress={() => router.push(`/show/${item.showId}` as any)}
          hitSlop={6}
          style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'flex-end' }}
        >
          {/* flexShrink lets a long title truncate while the chevron stays visible.
              includeFontPadding:false (Android) removes the extra top font padding;
              flex-end aligns the chevron with the bottom of the text. */}
          <T
            variant="caption"
            numberOfLines={1}
            style={[
              { fontWeight: '700', color: tokens.primary, flexShrink: 1 },
              Platform.OS === 'android' ? { includeFontPadding: false } : null,
            ]}
          >
            {item.showTitle}
          </T>
          <Ionicons
            name="chevron-forward"
            size={12}
            color={tokens.primary}
            style={{ marginLeft: 2 }}
          />
        </Pressable>
        {item.network ? (
          <T variant="micro" muted style={{ marginLeft: spacing.sm }}>
            {firstNetwork(item.network)}
          </T>
        ) : null}
      </View>

      {/* Body: tapping the still or episode info navigates to the episode. No flex here:
          the card's height is content-driven (inside Swipeable), and a flex child in an
          auto-height column parent collapses to 0 on Android. */}
      <Pressable
        onPress={() => router.push(`/episode/${item.episode.id}` as any)}
        style={{ flexDirection: 'row' }}
      >
        <View style={styles.epStillWrap}>
          <PosterImage
            uri={item.episode.stillUrl ?? item.backdropUrl}
            style={styles.epStill}
            transition={0}
          />
        </View>
        <View style={{ flex: 1, marginLeft: spacing.md }}>
          <View style={[styles.row, { alignItems: 'center' }]}>
            <T variant="caption" muted>
              S{String(item.episode.seasonNumber).padStart(2, '0')} | E
              {String(item.episode.number).padStart(2, '0')}
            </T>
            {item.label ? (
              <View style={{ marginLeft: spacing.sm }}>
                <StatusChip label={item.label} />
              </View>
            ) : null}
            {item.remainingUnwatched > 1 ? (
              <T variant="caption" style={{ marginLeft: 'auto', color: tokens.primary }}>
                +{item.remainingUnwatched - 1}
              </T>
            ) : null}
          </View>
          {/* paddingRight keeps the title clear of the absolutely-positioned watch
              button (26px at the card's bottom-right) — without it a two-line title
              slides underneath the checkbox. Only the title needs it: the S/E row
              above sits clear of the button zone, so the +N counter keeps hugging
              the card's right edge. */}
          <T
            variant="h2"
            numberOfLines={2}
            style={{ marginTop: 2, paddingRight: WATCH_BTN_CLEARANCE }}
          >
            {item.episode.title}
          </T>
        </View>
      </Pressable>

      {/* Watch button: absolute sibling so it does its own action. */}
      <View style={styles.epWatchBtn}>
        <WatchButton watched={watched} watchCount={item.episode.watchCount} onPress={handleWatch} />
      </View>
    </View>
  );

  // Web: no swipe, just render card with watch button
  if (Platform.OS === 'web') return cardContent;

  // Mobile: swipeable wrapper
  return (
    <Swipeable
      ref={swipeRef}
      friction={2}
      rightThreshold={40}
      renderRightActions={() => (
        <View style={[styles.swipeAction, { backgroundColor: tokens.watched }]}>
          <Ionicons
            name={item.episode.watched ? 'checkmark-done' : 'checkmark-circle-outline'}
            size={24}
            color={tokens.primaryForeground}
          />
          <T variant="micro" style={{ color: tokens.primaryForeground, marginTop: 2 }}>
            {item.episode.watched ? t('common:watched') : t('common:watch')}
          </T>
        </View>
      )}
      onSwipeableRightOpen={() => {
        handleWatch();
        swipeRef.current?.close();
      }}
    >
      {cardContent}
    </Swipeable>
  );
}

// Memoized: watch-next lists render hundreds of these inside a ScrollView, and every
// mark-watched tap re-renders the parent (isPending flip + optimistic cache swap).
// React Query's structural sharing (and the optimistic transforms) keep `item`
// identity stable for unchanged rows, and the callbacks only close over stable
// mutation fns — so comparing item identity alone safely skips untouched cards.
export const EpisodeCard = React.memo(EpisodeCardImpl, (prev, next) => prev.item === next.item);

// ---------------- Stats card ----------------
export function StatsCard({
  title,
  big,
  subtitle,
  children,
  style,
}: {
  title?: string;
  big?: string;
  subtitle?: string;
  children?: React.ReactNode;
  style?: ViewStyle;
}) {
  return (
    <Card style={[{ marginBottom: spacing.md }, style]}>
      {title ? (
        <T variant="caption" muted>
          {title}
        </T>
      ) : null}
      {big ? (
        <T variant="title" style={{ marginTop: spacing.xs }}>
          {big}
        </T>
      ) : null}
      {subtitle ? (
        <T variant="caption" muted style={{ marginTop: 2 }}>
          {subtitle}
        </T>
      ) : null}
      {children}
    </Card>
  );
}

// ---------------- Badge grid ----------------
const BADGE_COLS = 3;

export function BadgeGrid({ badges }: { badges: any[] }) {
  const { tokens } = useAppearance();
  const [gridWidth, setGridWidth] = React.useState(0);
  const cellWidth = gridWidth > 0 ? (gridWidth - BADGE_COLS * 2 * spacing.xs) / BADGE_COLS : 0;
  const rows: any[][] = [];
  for (let i = 0; i < badges.length; i += BADGE_COLS) rows.push(badges.slice(i, i + BADGE_COLS));
  return (
    <View onLayout={(e) => setGridWidth(e.nativeEvent.layout.width)}>
      {cellWidth > 0
        ? rows.map((row, ri) => (
            <View
              key={ri}
              style={{
                flexDirection: 'row',
                justifyContent: 'space-between',
                marginBottom: spacing.sm,
              }}
            >
              {row.map((b) => (
                <View
                  key={b.id}
                  style={[
                    styles.badge,
                    {
                      width: cellWidth,
                      backgroundColor: tokens.surface,
                      opacity: b.unlocked ? 1 : 0.4,
                    },
                  ]}
                >
                  <T style={{ fontSize: 28 }}>{b.icon}</T>
                  <T variant="micro" style={{ marginTop: 4, textAlign: 'center' }}>
                    {b.name}
                  </T>
                  {!b.unlocked ? (
                    <T variant="micro" muted style={{ marginTop: 2 }}>
                      {b.current}/{b.target}
                    </T>
                  ) : null}
                </View>
              ))}
              {Array.from({ length: BADGE_COLS - row.length }).map((_, fi) => (
                <View key={'f' + fi} style={{ width: cellWidth, marginHorizontal: spacing.xs }} />
              ))}
            </View>
          ))
        : null}
    </View>
  );
}

// ---------------- Notification item ----------------
export function NotificationItem({ item, onPress }: { item: any; onPress?: () => void }) {
  const { tokens } = useAppearance();
  const icon = notifIcon(item.category);
  return (
    <Pressable
      onPress={onPress}
      style={[styles.notif, { backgroundColor: tokens.surface, opacity: item.read ? 0.6 : 1 }]}
    >
      <View
        style={[
          styles.notifIcon,
          { backgroundColor: item.read ? tokens.surfaceElevated : tokens.primary },
        ]}
      >
        {/* Read: icon sits on surfaceElevated, so it needs a normal text color —
            primaryForeground is near-black in both themes and vanishes on dark slate. */}
        <Ionicons
          name={icon}
          size={18}
          color={item.read ? tokens.textMuted : tokens.primaryForeground}
        />
      </View>
      <View style={{ flex: 1, marginLeft: spacing.md }}>
        <T variant="body" numberOfLines={2}>
          {item.title}
        </T>
        {item.body ? (
          <T variant="caption" muted numberOfLines={1}>
            {item.body}
          </T>
        ) : null}
        <T variant="micro" muted style={{ marginTop: 2 }}>
          {timeAgo(item.createdAt)}
        </T>
      </View>
      {!item.read ? <View style={[styles.dot, { backgroundColor: tokens.primary }]} /> : null}
    </Pressable>
  );
}

// ---------------- Upcoming card ----------------
export function UpcomingCard({ item }: { item: any }) {
  const { tokens } = useAppearance();
  const air = new Date(item.airDate);
  const dateLabel = air.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  return (
    <Link href={`/episode/${item.id}` as any} asChild>
      <Pressable style={StyleSheet.flatten([styles.upCard, { backgroundColor: tokens.surface }])}>
        <PosterImage
          uri={item.posterUrl}
          style={{ width: 56, height: 84, borderRadius: radius.sm }}
          transition={0}
        />
        <View style={{ flex: 1, marginLeft: spacing.md }}>
          <View style={[styles.row, { alignItems: 'center' }]}>
            <T variant="h2" numberOfLines={1} style={{ flex: 1 }}>
              {item.title}
            </T>
            {item.label ? <StatusChip label={item.label} /> : null}
          </View>
          <T variant="caption" muted>
            S{String(item.seasonNumber).padStart(2, '0')} E
            {String(item.episodeNumber).padStart(2, '0')} · {item.episodeTitle}
          </T>
          <View style={[styles.row, { alignItems: 'center', marginTop: 4 }]}>
            <Ionicons name="time-outline" size={13} color={tokens.textMuted} />
            <T variant="caption" muted style={{ marginLeft: 4 }}>
              {dateLabel}
              {item.airTime ? ` · ${item.airTime}` : ''}
            </T>
            {item.network ? (
              <T variant="micro" style={{ marginLeft: 'auto', color: tokens.primary }}>
                {firstNetwork(item.network)}
              </T>
            ) : null}
          </View>
        </View>
      </Pressable>
    </Link>
  );
}

// ---------------- Bar chart (SVG) ----------------
export function BarChart({
  data,
  color,
  height = 90,
  formatValue,
}: {
  data: { label: string; value: number }[];
  color?: string;
  height?: number;
  formatValue?: (value: number) => string;
}) {
  const { tokens } = useAppearance();
  const barColor = color ?? tokens.primary;
  const [selected, setSelected] = React.useState<number | null>(null);
  // Measured pixel height of the bar row. Percentage bar heights (`height: '60%'`)
  // resolve against a stretch-sized flex parent: fine under Yoga (native), but 0
  // under react-native-web — every bar collapsed to minHeight. Pixels work on both.
  const [rowH, setRowH] = React.useState(0);
  const max = Math.max(1, ...data.map((d) => d.value));
  const sel = selected != null ? data[selected] : null;
  return (
    <View style={{ marginTop: spacing.sm }}>
      <View style={{ height: 18, justifyContent: 'center' }}>
        {sel ? (
          <T variant="micro" style={{ color: barColor, textAlign: 'center' }}>
            {sel.label} · {formatValue ? formatValue(sel.value) : sel.value}
          </T>
        ) : null}
      </View>
      <View
        style={{ flexDirection: 'row', alignItems: 'flex-end', height }}
        onLayout={(e) => setRowH(e.nativeEvent.layout.height)}
      >
        {data.map((d, i) => (
          <Pressable
            key={i}
            onPress={() => setSelected(selected === i ? null : i)}
            accessibilityRole="button"
            style={{
              flex: 1,
              marginHorizontal: 1,
              justifyContent: 'flex-end',
              alignSelf: 'stretch',
            }}
          >
            <View
              style={{
                height: Math.max(2, Math.round((d.value / max) * rowH)),
                backgroundColor: barColor,
                borderRadius: 3,
                opacity: selected == null || selected === i ? 1 : 0.35,
              }}
            />
          </Pressable>
        ))}
      </View>
      <View style={{ flexDirection: 'row', marginTop: 4 }}>
        {data.map((d, i) => (
          <T
            key={i}
            variant="micro"
            dim
            style={[{ flex: 1, textAlign: 'center' }, selected === i ? { color: barColor } : null]}
          >
            {d.label}
          </T>
        ))}
      </View>
    </View>
  );
}

function notifIcon(category: string): keyof typeof Ionicons.glyphMap {
  switch (category) {
    case 'BADGE':
      return 'ribbon';
    case 'FOLLOW':
      return 'person-add';
    case 'COMMENT_LIKE':
    case 'COMMENT_REPLY':
      return 'chatbubble';
    case 'EPISODE_TODAY':
    case 'EPISODE_SOON':
    case 'EPISODE_AIRED':
    case 'PREMIERE':
      return 'tv';
    case 'MOVIE_RELEASE':
      return 'film';
    case 'WATCHLIST_REMINDER':
      return 'notifications';
    case 'PROVIDER_ALERT':
      return 'play-circle';
    case 'CONTACT':
      return 'mail';
    default:
      return 'notifications';
  }
}

export function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(iso).toLocaleDateString();
}

const styles = StyleSheet.create({
  libraryBadgeHitTarget: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 44,
    height: 44,
    alignItems: 'flex-end',
    justifyContent: 'flex-start',
    zIndex: 4,
  },
  libraryBadge: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  grid: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: spacing.lg },
  epCard: {
    position: 'relative',
    borderRadius: radius.md,
    padding: spacing.sm,
    marginBottom: spacing.sm,
  },
  epHeader: { height: 20, flexDirection: 'row', alignItems: 'center', marginBottom: spacing.xs },
  swipeAction: {
    justifyContent: 'center',
    alignItems: 'center',
    width: 90,
    marginRight: spacing.sm,
    marginBottom: spacing.sm,
    borderRadius: radius.md,
  },
  epStillWrap: {
    width: 130,
    height: 74,
    borderRadius: radius.sm,
    overflow: 'hidden',
    position: 'relative',
  },
  epStill: { width: '100%', height: '100%' },
  epWatchBtn: { position: 'absolute', right: spacing.sm, bottom: spacing.sm },
  upCard: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radius.md,
    padding: spacing.sm,
    marginBottom: spacing.sm,
  },
  row: { flexDirection: 'row' },
  badge: {
    alignItems: 'center',
    borderRadius: radius.md,
    padding: spacing.md,
    marginHorizontal: spacing.xs,
  },
  notif: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  notifIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
});
