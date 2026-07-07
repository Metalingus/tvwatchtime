import React, { useRef } from 'react';
import { Dimensions, FlatList, Pressable, StyleSheet, useWindowDimensions, View, ViewStyle } from 'react-native';
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
} from './primitives';
import { colors, radius, spacing, typography } from '../theme/theme';

// ---------------- Poster grid card ----------------
export function PosterCard({ id, kind, title, poster, progress, width = 130, style }: { id: string; kind: 'shows' | 'movies'; title: string; poster?: string | null; progress?: number; width?: number; style?: ViewStyle }) {
  const h = width * 1.5;
  const route = kind === 'shows' ? 'show' : 'movie';
  const base: ViewStyle = { width, marginRight: spacing.md };
  return (
    <Link href={`/${route}/${id}` as any} asChild>
      <Pressable style={style ? [base, style] : base}>
        <View style={{ borderRadius: radius.md, overflow: 'hidden' }}>
          <PosterImage uri={poster} style={{ width, height: h }} />
          {progress !== undefined ? (
            <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: 4 }}>
              <ProgressBar value={progress} color={progress >= 1 ? colors.watched : colors.primary} />
            </View>
          ) : null}
        </View>
        <T variant="caption" numberOfLines={2} style={{ marginTop: 6 }}>
          {title}
        </T>
      </Pressable>
    </Link>
  );
}

export function PosterGrid({ data, kind, emptyTitle, emptyCta, minCardWidth = 110 }: { data: any[]; kind: 'shows' | 'movies'; emptyTitle: string; emptyCta?: string; minCardWidth?: number }) {
  const { width } = useWindowDimensions();
  if (!data || data.length === 0) return <EmptyState title={emptyTitle} cta={emptyCta} icon="layers-outline" />;
  const containerW = width - spacing.lg * 2;
  const gap = spacing.sm;
  const cols = Math.max(2, Math.floor((containerW + gap) / (minCardWidth + gap)));
  const cellW = Math.floor((containerW - gap * (cols - 1)) / cols);
  const rows: any[][] = [];
  for (let i = 0; i < data.length; i += cols) rows.push(data.slice(i, i + cols));
  return (
    <View>
      {rows.map((row, ri) => (
        <View key={ri} style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: spacing.sm }}>
          {row.map((it) => (
            <PosterCard key={it.id} id={it.id} kind={kind} title={it.title} poster={it.images?.poster ?? it.posterUrl} progress={it.userProgress ?? (it.watched ? 1 : undefined)} width={cellW} style={{ marginRight: 0 }} />
          ))}
          {Array.from({ length: cols - row.length }).map((_, fi) => (
            <View key={'f' + fi} style={{ width: cellW }} />
          ))}
        </View>
      ))}
    </View>
  );
}

// ---------------- Horizontal carousel ----------------
export function Carousel({ title, action, onAction, data, kind, width = 120 }: { title: string; action?: string; onAction?: () => void; data: any[]; kind: 'shows' | 'movies'; width?: number }) {
  if (!data || data.length === 0) return null;
  return (
    <View style={{ marginBottom: spacing.lg }}>
      <View style={{ paddingHorizontal: spacing.lg }}>
        <SectionHeader title={title} action={action} onAction={onAction} />
      </View>
      <FlatList
        horizontal
        data={data}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: spacing.lg }}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <PosterCard id={item.id} kind={kind} title={item.title} poster={item.images?.poster ?? item.posterUrl} progress={item.userProgress} width={width} />
        )}
      />
    </View>
  );
}

// ---------------- Episode card (watch list row) ----------------
export function EpisodeCard({ item, onToggleWatched }: { item: any; onToggleWatched?: () => void }) {
  const swipeRef = useRef<any>(null);
  return (
    <Swipeable
      ref={swipeRef}
      friction={2}
      rightThreshold={40}
      renderRightActions={() => (
        <View style={styles.swipeAction}>
          <Ionicons name={item.episode.watched ? 'checkmark-done' : 'checkmark-circle-outline'} size={24} color="#0F1115" />
          <T variant="micro" style={{ color: '#0F1115', marginTop: 2 }}>{item.episode.watched ? 'Watched' : 'Watch'}</T>
        </View>
      )}
      onSwipeableRightOpen={() => {
        onToggleWatched?.();
        swipeRef.current?.close();
      }}
    >
      <Link href={`/episode/${item.episode.id}` as any} asChild>
        <Pressable style={styles.epCard}>
        <View style={styles.epStillWrap}>
          <PosterImage uri={item.episode.stillUrl ?? item.backdropUrl} style={styles.epStill} />
          <Pressable onPress={() => router.push(`/show/${item.showId}` as any)} style={styles.epPill}>
            <T variant="micro" numberOfLines={1} style={{ color: '#0F1115' }}>
              {item.showTitle}
            </T>
          </Pressable>
        </View>
        <View style={{ flex: 1, marginLeft: spacing.md, justifyContent: 'space-between' }}>
          <View>
            <View style={[styles.row, { alignItems: 'center' }]}>
              <T variant="caption" muted>
                S{String(item.episode.seasonNumber).padStart(2, '0')} | E{String(item.episode.number).padStart(2, '0')}
              </T>
              {item.label ? <View style={{ marginLeft: spacing.sm }}><StatusChip label={item.label} /></View> : null}
              {item.remainingUnwatched ? (
                <T variant="caption" style={{ marginLeft: 'auto', color: colors.primary }}>
                  +{item.remainingUnwatched}
                </T>
              ) : null}
            </View>
            <T variant="h2" numberOfLines={2} style={{ marginTop: 2 }}>
              {item.episode.title}
            </T>
          </View>
          <View style={[styles.row, { alignItems: 'center' }]}>
            <T variant="caption" muted>
              {item.network ?? ''}
            </T>
            <View style={{ marginLeft: 'auto' }}>
              <WatchButton watched={item.episode.watched} onPress={onToggleWatched} />
            </View>
          </View>
        </View>
      </Pressable>
    </Link>
    </Swipeable>
  );
}

// ---------------- Stats card ----------------
export function StatsCard({ title, big, subtitle, children, style }: { title?: string; big?: string; subtitle?: string; children?: React.ReactNode; style?: ViewStyle }) {
  return (
    <Card style={[{ marginBottom: spacing.md }, style]}>
      {title ? <T variant="caption" muted>{title}</T> : null}
      {big ? <T variant="title" style={{ marginTop: spacing.xs }}>{big}</T> : null}
      {subtitle ? <T variant="caption" muted style={{ marginTop: 2 }}>{subtitle}</T> : null}
      {children}
    </Card>
  );
}

// ---------------- Badge grid ----------------
const BADGE_COLS = 3;

export function BadgeGrid({ badges }: { badges: any[] }) {
  const rows: any[][] = [];
  for (let i = 0; i < badges.length; i += BADGE_COLS) rows.push(badges.slice(i, i + BADGE_COLS));
  return (
    <View>
      {rows.map((row, ri) => (
        <View key={ri} style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: spacing.sm }}>
          {row.map((b) => (
            <View key={b.id} style={[styles.badge, { opacity: b.unlocked ? 1 : 0.4 }]}>
              <T style={{ fontSize: 28 }}>{b.icon}</T>
              <T variant="micro" style={{ marginTop: 4, textAlign: 'center' }}>
                {b.name}
              </T>
              {!b.unlocked ? <T variant="micro" muted style={{ marginTop: 2 }}>{b.current}/{b.target}</T> : null}
            </View>
          ))}
          {Array.from({ length: BADGE_COLS - row.length }).map((_, fi) => (
            <View key={'f' + fi} style={styles.badgeSpacer} />
          ))}
        </View>
      ))}
    </View>
  );
}

// ---------------- Notification item ----------------
export function NotificationItem({ item, onPress }: { item: any; onPress?: () => void }) {
  const icon = notifIcon(item.category);
  return (
    <Pressable onPress={onPress} style={[styles.notif, { opacity: item.read ? 0.6 : 1 }]}>
      <View style={[styles.notifIcon, { backgroundColor: item.read ? colors.surfaceElevated : colors.primary }]}>
        <Ionicons name={icon} size={18} color="#0F1115" />
      </View>
      <View style={{ flex: 1, marginLeft: spacing.md }}>
        <T variant="body" numberOfLines={2}>
          {item.title}
        </T>
        {item.body ? <T variant="caption" muted numberOfLines={1}>{item.body}</T> : null}
        <T variant="micro" muted style={{ marginTop: 2 }}>
          {timeAgo(item.createdAt)}
        </T>
      </View>
      {!item.read ? <View style={styles.dot} /> : null}
    </Pressable>
  );
}

// ---------------- Upcoming card ----------------
export function UpcomingCard({ item }: { item: any }) {
  const air = new Date(item.airDate);
  const dateLabel = air.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  return (
    <Link href={`/episode/${item.id}` as any} asChild>
      <Pressable style={styles.upCard}>
        <PosterImage uri={item.posterUrl} style={{ width: 56, height: 84, borderRadius: radius.sm }} />
        <View style={{ flex: 1, marginLeft: spacing.md }}>
          <View style={[styles.row, { alignItems: 'center' }]}>
            <T variant="h2" numberOfLines={1} style={{ flex: 1 }}>
              {item.title}
            </T>
            {item.label ? <StatusChip label={item.label} /> : null}
          </View>
          <T variant="caption" muted>
            S{String(item.seasonNumber).padStart(2, '0')} E{String(item.episodeNumber).padStart(2, '0')} · {item.episodeTitle}
          </T>
          <View style={[styles.row, { alignItems: 'center', marginTop: 4 }]}>
            <Ionicons name="time-outline" size={13} color={colors.textMuted} />
            <T variant="caption" muted style={{ marginLeft: 4 }}>
              {dateLabel}
              {item.airTime ? ` · ${item.airTime}` : ''}
            </T>
            {item.network ? (
              <T variant="micro" style={{ marginLeft: 'auto', color: colors.primary }}>
                {item.network}
              </T>
            ) : null}
          </View>
        </View>
      </Pressable>
    </Link>
  );
}

// ---------------- Bar chart (SVG) ----------------
export function BarChart({ data, color = colors.primary, height = 90 }: { data: { label: string; value: number }[]; color?: string; height?: number }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <View style={{ marginTop: spacing.sm }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', height }}>
        {data.map((d, i) => (
          <View key={i} style={{ flex: 1, marginHorizontal: 1, justifyContent: 'flex-end' }}>
            <View style={{ height: `${(d.value / max) * 100}%`, backgroundColor: color, borderRadius: 3, minHeight: 2 }} />
          </View>
        ))}
      </View>
      <View style={{ flexDirection: 'row', marginTop: 4 }}>
        {data.map((d, i) => (
          <T key={i} variant="micro" dim style={{ flex: 1, textAlign: 'center' }}>
            {d.label}
          </T>
        ))}
      </View>
    </View>
  );
}

function notifIcon(category: string): keyof typeof Ionicons.glyphMap {
  switch (category) {
    case 'BADGE': return 'ribbon';
    case 'FOLLOW': return 'person-add';
    case 'COMMENT_LIKE':
    case 'COMMENT_REPLY': return 'chatbubble';
    case 'EPISODE_TODAY':
    case 'EPISODE_SOON':
    case 'EPISODE_AIRED':
    case 'PREMIERE': return 'tv';
    case 'MOVIE_RELEASE': return 'film';
    case 'WATCHLIST_REMINDER': return 'notifications';
    default: return 'notifications';
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
  grid: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: spacing.lg },
  epCard: { flexDirection: 'row', backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.sm, marginBottom: spacing.sm },
  swipeAction: { justifyContent: 'center', alignItems: 'center', width: 90, marginRight: spacing.sm, marginBottom: spacing.sm, borderRadius: radius.md, backgroundColor: colors.watched },
  epStillWrap: { width: 130, height: 74, borderRadius: radius.sm, overflow: 'hidden', position: 'relative' },
  epStill: { width: '100%', height: '100%' },
  epPill: { position: 'absolute', top: 6, left: 6, backgroundColor: colors.primary, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, maxWidth: 110 },
  upCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.sm, marginBottom: spacing.sm },
  row: { flexDirection: 'row' },
  badge: { flex: 1, alignItems: 'center', backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.md },
  badgeSpacer: { flex: 1 },
  notif: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.sm },
  notifIcon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.primary },
});
