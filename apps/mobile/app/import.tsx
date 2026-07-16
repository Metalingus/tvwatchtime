import React, { useEffect, useState } from 'react';
import { useRouter } from 'expo-router';
import { FlatList, Modal, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { Ionicons } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import { MediaType } from '@tvwatch/shared';
import { Header } from '../components/Header';
import { Button, Card, Chip, EmptyState, PosterImage, Screen, Spinner, T } from '../components/primitives';
import {
  useCancelImport,
  useConfirmImport,
  useFeatureFlags,
  useImport,
  useImportItems,
  usePatchImportItem,
  useResolveAllForShow,
  useSearch,
  useUploadImport,
} from '../api/hooks';
import { useAppearance } from '../context/PreferencesProvider';
import { radius, spacing } from '../theme/theme';
import { showError } from '../lib/dialog';
import { useTranslation } from 'react-i18next';

export default function ImportScreen() {
  const { tokens } = useAppearance();
  const { t } = useTranslation(['import', 'common']);
  const [importId, setImportId] = useState<string | null>(null);
  const [activeItem, setActiveItem] = useState<any | null>(null);
  const upload = useUploadImport();
  const importQ = useImport(importId ?? undefined);
  const itemsQ = useImportItems(importId ?? '', undefined, undefined);
  const flags = useFeatureFlags();
  const importsEnabled = flags.data?.imports_enabled ?? true;

  const STATUS_LABEL: Record<string, string> = {
    UPLOADED: t('import:status.uploaded'),
    QUEUED: t('import:status.queued'),
    EXTRACTING: t('import:status.extracting'),
    PARSING: t('import:status.parsing'),
    NORMALIZING: t('import:status.normalizing'),
    MATCHING: t('import:status.matching'),
    READY_FOR_REVIEW: t('import:status.ready'),
    IMPORTING: t('import:status.importing'),
    COMPLETED: t('import:status.completed'),
    FAILED: t('import:status.failed'),
    CANCELLED: t('import:status.cancelled'),
    ROLLED_BACK: t('import:status.rolledBack'),
  };

  const status = importQ.data?.status;
  const isProcessing = status && !['READY_FOR_REVIEW', 'COMPLETED', 'FAILED', 'CANCELLED', 'ROLLED_BACK'].includes(status);

  const pickFile = async () => {
    try {
      if (Platform.OS === 'web') {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.zip,.csv,.json';
        input.onchange = async () => {
          const file = input.files?.[0];
          if (!file) return;
          const fd = new FormData();
          fd.append('file', file);
          try {
            const r = await upload.mutateAsync(fd);
            setImportId(r.importId);
            importQ.refetch();
          } catch (e: any) {
            showError({ title: t('import:uploadFailed'), description: e?.message ?? t('import:couldNotUpload') });
          }
        };
        input.click();
        return;
      }

      const res = await DocumentPicker.getDocumentAsync({
        type: ['application/zip', 'text/csv', 'application/json', 'application/x-zip-compressed'],
        copyToCacheDirectory: true,
      });
      if (res.canceled || !res.assets?.[0]) return;
      const file = res.assets[0];
      const fd = new FormData();
      fd.append('file', { uri: file.uri, name: file.name, type: file.mimeType || 'application/octet-stream' } as any);
      const r = await upload.mutateAsync(fd);
      setImportId(r.importId);
      importQ.refetch();
    } catch (e: any) {
      showError({ title: t('import:uploadFailed'), description: e?.message ?? t('import:couldNotUpload') });
    }
  };

  const confirm = useConfirmImport();
  const cancel = useCancelImport();
  const qc = useQueryClient();
  const router = useRouter();

  // Cancel the import and navigate back immediately (fire-and-forget the backend cancel).
  const doCancel = () => {
    if (importId) cancel.mutate(importId);
    router.back();
  };

  if (!importId) {
    return (
      <Screen>
        <Header title={t('import:title')} showBack />
        {importsEnabled ? (
          <View style={{ padding: spacing.lg, gap: spacing.lg }}>
            <Card>
              <T variant="h2">{t('import:importFromTvTime')}</T>
              <T variant="caption" muted style={{ marginTop: spacing.sm }}>
                Upload the <T variant="caption" style={{ fontWeight: '700', color: tokens.primary }}>{t('import:zipFile')}</T> you received from TV Time's GDPR data export.
                {t('import:howItWorks')}
              </T>
              <Button title={t('import:selectZip')} icon="document-outline" onPress={pickFile} loading={upload.isPending} style={{ marginTop: spacing.md }} />
            </Card>
            <T variant="micro" muted>
              {t('import:limits')}
            </T>
          </View>
        ) : (
          <View style={{ padding: spacing.xl }}>
            <EmptyState title={t('import:disabledTitle')} subtitle={t('import:disabledDesc')} icon="cloud-offline-outline" />
          </View>
        )}
      </Screen>
    );
  }

  if (isProcessing) {
    return (
      <Screen>
        <Header title={t('import:title')} showBack />
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl }}>
          <Spinner />
          <T variant="h2" style={{ marginTop: spacing.lg }}>{STATUS_LABEL[status] ?? t('import:processing')}</T>
          <T variant="caption" muted style={{ marginTop: spacing.sm, textAlign: 'center' }}>
            {t('import:matchingDesc')}
          </T>
          <Button title={t('import:cancel')} variant="ghost" onPress={doCancel} style={{ marginTop: spacing.lg }} />
        </View>
      </Screen>
    );
  }

  if (status === 'FAILED') {
    return (
      <Screen>
        <Header title={t('import:title')} showBack />
        <EmptyState title={t('import:importFailed')} subtitle={importQ.data?.errorMessage ?? t('import:tryAgain')} icon="alert-circle-outline" cta={t('common:startOver')} onCta={() => setImportId(null)} />
      </Screen>
    );
  }

  if (status === 'COMPLETED') {
    return (
      <Screen>
        <Header title={t('import:title')} showBack />
        <View style={{ padding: spacing.lg, gap: spacing.lg }}>
          <Card>
            <T variant="h2">{t('import:importComplete')}</T>
            <T variant="body" style={{ marginTop: spacing.sm }}>{t('import:created', { value: confirm.data?.created ?? '—' })}</T>
            <T variant="body" muted>{t('import:skipped', { value: confirm.data?.skipped ?? '—' })}</T>
            <Button title={t('import:done')} onPress={() => {
              qc.invalidateQueries();
              setImportId(null);
            }} style={{ marginTop: spacing.md }} />
          </Card>
        </View>
      </Screen>
    );
  }

  // READY_FOR_REVIEW
  const imp = importQ.data;
  return (
    <Screen>
      <Header title={t('import:reviewImport')} showBack />
      <View style={styles.summary}>
        <Stat label={t('import:matched')} value={imp?.matchedCount} color={tokens.watched} />
        <Stat label={t('import:needsReview')} value={imp?.needsReviewCount} color={tokens.orange} />
        <Stat label={t('import:unmatched')} value={imp?.unmatchedCount} color={tokens.danger} />
        <Stat label={t('import:duplicates')} value={imp?.duplicateCount} color={tokens.textMuted} />
      </View>
      <ReviewItems importId={importId} tokens={tokens} onResolve={setActiveItem} />
      <View style={[styles.actions, { borderTopColor: tokens.divider }]}>
        <Button
          title={t('import:confirmImport')}
          variant="watched"
          icon="checkmark"
          loading={confirm.isPending}
          onPress={() =>
            confirm.mutate(importId, {
              onError: (e: any) => showError({ title: t('import:importFailed'), description: e?.message ?? t('common:tryAgain') }),
            })
          }
          style={{ flex: 1 }}
        />
        <Button title={t('import:cancel')} variant="ghost" onPress={doCancel} style={{ marginLeft: spacing.sm }} />
      </View>
      <ResolutionModal item={activeItem} importId={importId} tokens={tokens} onClose={() => setActiveItem(null)} />
    </Screen>
  );
}

function Stat({ label, value, color }: { label: string; value?: number; color: string }) {
  return (
    <View style={styles.stat}>
      <T variant="title" style={{ color }}>{value ?? 0}</T>
      <T variant="micro" muted>{label}</T>
    </View>
  );
}

function ReviewItems({ importId, tokens, onResolve }: { importId: string; tokens: ReturnType<typeof useAppearance>['tokens']; onResolve: (item: any) => void }) {
  const { t } = useTranslation(['import', 'common']);
  const [statusFilter, setStatusFilter] = useState<string | undefined>(undefined);
  const [entityFilter, setEntityFilter] = useState<string | undefined>(undefined);
  const q = useImportItems(importId, statusFilter, entityFilter);
  // Dedupe by id (defensive); the list is now a single page so pagination drift is gone.
  const seen = new Set<string>();
  const items = (q.data?.items ?? []).filter((it) => (seen.has(it.id) ? false : seen.add(it.id)));

  const ENTITY_FILTERS: { key: string | undefined; label: string }[] = [
    { key: undefined, label: t('import:allTypes') },
    { key: 'WATCHLIST_SHOW', label: t('import:shows') },
    { key: 'WATCHLIST_MOVIE', label: t('import:movies') },
    { key: 'WATCHED_MOVIE', label: t('import:watchedMovies') },
    { key: 'WATCHED_EPISODE', label: t('import:episodes') },
    { key: 'EPISODE_RATING', label: t('import:episodeRatings') },
    { key: 'MOVIE_RATING', label: t('import:movieRatings') },
    { key: 'EPISODE_EMOTION', label: t('import:episodeEmotions') },
    { key: 'MOVIE_EMOTION', label: t('import:movieEmotions') },
    { key: 'EPISODE_COMMENT', label: t('import:episodeComments') },
    { key: 'MOVIE_COMMENT', label: t('import:movieComments') },
  ];

  const FILTERS: { key: string | undefined; label: string }[] = [
    { key: undefined, label: t('import:filters.all') },
    { key: 'matched', label: t('import:filters.matched') },
    { key: 'needs_review', label: t('import:filters.needsReview') },
    { key: 'unmatched', label: t('import:filters.unmatched') },
    { key: 'duplicate', label: t('import:filters.duplicates') },
  ];

  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      <View style={{ height: 40, justifyContent: 'center' }}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: spacing.lg }}>
          {ENTITY_FILTERS.map((f) => (
            <Chip key={f.label} label={f.label} active={entityFilter === f.key} onPress={() => setEntityFilter(f.key)} />
          ))}
        </ScrollView>
      </View>
      <View style={{ height: 40, justifyContent: 'center', marginTop: 4 }}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: spacing.lg }}>
          {FILTERS.map((f) => (
            <Chip key={f.label} label={f.label} active={statusFilter === f.key} onPress={() => setStatusFilter(f.key)} />
          ))}
        </ScrollView>
      </View>
      <FlatList
        data={items}
        keyExtractor={(i) => i.id}
        contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingBottom: 120 }}
        onRefresh={() => q.refetch()}
        refreshing={!!q.isFetching && !q.isLoading}
        renderItem={({ item }) => {
          const norm = item.normalizedData ?? {};
          const entityType = String(item.sourceEntityType);
          const season = norm.season ?? norm.seasonNumber;
          const episode = norm.episode ?? norm.episodeNumber;
          return (
            <Pressable onPress={() => onResolve(item)}>
              <Card style={styles.row}>
                <View style={{ flex: 1 }}>
                  <T variant="body" numberOfLines={1}>{describeItem(entityType, norm, t)}</T>
                  <T variant="micro" muted>
                    {entityType.replace(/_/g, ' ').toLowerCase()}
                    {season != null ? ` · S${season}E${episode ?? ''}` : ''}
                  </T>
                </View>
                <T variant="micro" style={{ color: statusColor(item.status, tokens) }}>{item.status}</T>
              </Card>
            </Pressable>
          );
        }}
        ListEmptyComponent={
          q.isLoading ? <Spinner /> : <T variant="caption" muted style={{ padding: spacing.xl, textAlign: 'center' }}>{t('import:noItems')}</T>
        }
      />
    </View>
  );
}

function statusColor(s: string, tokens: ReturnType<typeof useAppearance>['tokens']): string {
  switch (s) {
    case 'MATCHED': return tokens.watched;
    case 'NEEDS_REVIEW': return tokens.orange;
    case 'UNMATCHED': return tokens.danger;
    case 'DUPLICATE': return tokens.textMuted;
    default: return tokens.textMuted;
  }
}

/** Build a human-readable primary label for a staged import item of any entity type. */
function describeItem(
  entityType: string,
  norm: Record<string, any>,
  t: (k: string, o?: any) => string,
): string {
  const isRating = entityType.endsWith('_RATING');
  const isEmotion = entityType.endsWith('_EMOTION');
  const isComment = entityType.endsWith('_COMMENT');

  // Target title: episode/show use showTitle, movie uses movieTitle, legacy items use title.
  const title =
    norm.showTitle ?? norm.movieTitle ?? norm.title ?? t('import:noTitle');

  if (isComment) {
    // Short excerpt of the user's OWN comment (their data, their screen).
    return typeof norm.text === 'string' && norm.text.length
      ? norm.text.slice(0, 60)
      : t('import:noTitle');
  }
  if (isRating) {
    const stars = norm.normalizedRating ? `★ ${norm.normalizedRating}/5` : '';
    return stars ? `${title}  ·  ${stars}` : title;
  }
  if (isEmotion) {
    const emo = norm.normalizedEmotion ? String(norm.normalizedEmotion).toLowerCase() : '';
    return emo ? `${title}  ·  ${emo}` : title;
  }
  return title;
}

/** Subtitle for a search result: type · seasons (shows) · year. */
function resultMeta(r: any, t: (k: string, o?: any) => string): string {
  const parts: string[] = [(r.type ?? '').toLowerCase()];
  if (r.type === MediaType.SHOW) {
    if (r.seasonsCount) parts.push(t('import:seasons', { count: r.seasonsCount }));
    if (r.yearStart) parts.push(String(r.yearStart));
  } else if (r.releaseYear) {
    parts.push(String(r.releaseYear));
  }
  return parts.filter(Boolean).join(' · ');
}

/** Modal to manually resolve a staged item: skip it, or search & pick the correct media. */
function ResolutionModal({
  item,
  importId,
  tokens,
  onClose,
}: {
  item: any | null;
  importId: string;
  tokens: ReturnType<typeof useAppearance>['tokens'];
  onClose: () => void;
}) {
  const { t } = useTranslation(['import', 'common']);
  const [query, setQuery] = useState('');
  // Apply-to-all defaults to the active season; the user can switch to "whole show". Mutually
  // exclusive; both off = resolve just the single item.
  const [applyToSeason, setApplyToSeason] = useState(true);
  const [applyToWholeShow, setApplyToWholeShow] = useState(false);
  const patch = usePatchImportItem(importId);
  const resolveAll = useResolveAllForShow(importId);

  // On open: prefill the search with the show/movie name and reset the checkboxes (season on).
  useEffect(() => {
    setApplyToSeason(true);
    setApplyToWholeShow(false);
    const n: any = item?.normalizedData ?? {};
    setQuery((n.showTitle ?? n.movieTitle ?? n.title ?? '').trim());
  }, [item?.id]);

  // Hooks must run unconditionally (Rules of Hooks). Derive values defensively so that
  // `useSearch` stays disabled (empty query) when no item is active.
  const entityType = item ? String(item.sourceEntityType) : '';
  const isMovie = /MOVIE/.test(entityType);
  const searchType = isMovie ? MediaType.MOVIE : MediaType.SHOW;
  const trimmed = item ? query.trim() : '';
  const search = useSearch(trimmed, searchType);
  const resolveStyles = buildResolveStyles(tokens);

  if (!item) return null;
  const norm = item.normalizedData ?? {};
  const results = trimmed.length > 1 ? search.data?.items ?? [] : [];
  // Episode info for watched episodes / episode ratings/emotions/comments (S16E9 etc.).
  const season = norm.season ?? norm.seasonNumber;
  const episode = norm.episode ?? norm.episodeNumber;
  const episodeTag = season != null ? `S${season}E${episode ?? ''}` : '';
  const sourceTitle = norm.showTitle ?? norm.movieTitle ?? norm.title ?? t('import:noTitle');
  const showSourceTitle = norm.showTitle ?? norm.title; // episodes of this show (watched uses `title`)

  const resolve = async (matchedMediaId: string) => {
    try {
      // Checkboxes only apply to TV items (not movies). whole-show wins over season.
      if (!isMovie && showSourceTitle && (applyToSeason || applyToWholeShow)) {
        const resolveSeason = applyToWholeShow ? null : season ?? null;
        await resolveAll.mutateAsync({ matchedMediaId, sourceTitle: showSourceTitle, season: resolveSeason });
      } else {
        await patch.mutateAsync({ itemId: item.id, matchedMediaId });
      }
      onClose();
    } catch (e: any) {
      showError({ description: e?.message ?? t('common:tryAgain') });
    }
  };
  const skip = async () => {
    try {
      await patch.mutateAsync({ itemId: item.id, userResolution: 'skip' });
      onClose();
    } catch (e: any) {
      showError({ description: e?.message ?? t('common:tryAgain') });
    }
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={resolveStyles.backdrop} onPress={onClose}>
        <Pressable
          style={[resolveStyles.sheet, { backgroundColor: tokens.surface }]}
          onPress={(e) => e.stopPropagation()}
        >
          <View style={resolveStyles.header}>
            <T variant="h2" numberOfLines={1}>{t('import:resolve')}</T>
            <Pressable onPress={onClose} hitSlop={8}>
              <Ionicons name="close" size={24} color={tokens.textPrimary} />
            </Pressable>
          </View>

          <T variant="caption" style={{ marginTop: spacing.xs }}>
            {t('import:sourceTitle')}:{' '}
            <T variant="caption" style={{ fontWeight: '700', color: tokens.textPrimary }}>
              {sourceTitle}
            </T>
          </T>
          <T variant="micro" muted style={{ marginTop: 2 }}>
            {entityType.replace(/_/g, ' ').toLowerCase()}{episodeTag ? ` · ${episodeTag}` : ''}
          </T>

          {!isMovie && showSourceTitle ? (
            <View style={{ marginTop: spacing.sm }}>
              <Pressable
                style={{ flexDirection: 'row', alignItems: 'center' }}
                onPress={() =>
                  setApplyToSeason((prev) => {
                    const next = !prev;
                    if (next) setApplyToWholeShow(false);
                    return next;
                  })
                }
                hitSlop={6}
              >
                <Ionicons
                  name={applyToSeason ? 'checkbox' : 'square-outline'}
                  size={22}
                  color={applyToSeason ? tokens.primary : tokens.textMuted}
                />
                <T variant="caption" style={{ marginLeft: spacing.xs, flex: 1 }}>
                  {season != null ? t('import:applyToAllSeason', { season }) : t('import:applyToAllEpisodes')}
                </T>
              </Pressable>
              <Pressable
                style={{ flexDirection: 'row', alignItems: 'center', marginTop: 4 }}
                onPress={() =>
                  setApplyToWholeShow((prev) => {
                    const next = !prev;
                    if (next) setApplyToSeason(false);
                    return next;
                  })
                }
                hitSlop={6}
              >
                <Ionicons
                  name={applyToWholeShow ? 'checkbox' : 'square-outline'}
                  size={22}
                  color={applyToWholeShow ? tokens.primary : tokens.textMuted}
                />
                <T variant="caption" style={{ marginLeft: spacing.xs, flex: 1 }}>
                  {t('import:applyToWholeShow')}
                </T>
              </Pressable>
            </View>
          ) : null}

          <Button
            title={t('import:skipItem')}
            variant="ghost"
            icon="close-circle-outline"
            onPress={skip}
            loading={patch.isPending}
            style={{ marginTop: spacing.md }}
          />

          <T variant="caption" muted style={{ marginTop: spacing.md, marginBottom: spacing.xs }}>
            {t('import:searchToMatch')}
          </T>
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={t('import:searchPlaceholder')}
            placeholderTextColor={tokens.textMuted}
            style={[resolveStyles.input, { color: tokens.textPrimary, borderColor: tokens.divider }]}
            autoFocus
          />

          {search.isFetching && query.trim().length > 1 ? (
            <Spinner />
          ) : results.length === 0 ? (
            query.trim().length > 1 ? (
              <T variant="micro" muted style={{ padding: spacing.md, textAlign: 'center' }}>
                {t('import:noResults')}
              </T>
            ) : null
          ) : (
            <ScrollView style={{ maxHeight: 300 }} keyboardShouldPersistTaps="handled">
              {results.map((r: any) => (
                <Pressable key={r.id} onPress={() => resolve(r.id)} style={resolveStyles.resultRow}>
                  <PosterImage uri={r.images?.poster ?? r.posterUrl} style={resolveStyles.poster} />
                  <View style={{ flex: 1 }}>
                    <T variant="body" numberOfLines={1}>{r.title}</T>
                    <T variant="micro" muted>{resultMeta(r, t)}</T>
                  </View>
                  <Ionicons name="checkmark-circle-outline" size={22} color={tokens.primary} />
                </Pressable>
              ))}
            </ScrollView>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function buildResolveStyles(tokens: ReturnType<typeof useAppearance>['tokens']) {
  return StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: tokens.overlayStrong, justifyContent: 'flex-end' },
    sheet: { borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: spacing.lg, paddingBottom: 32 },
    header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    input: { borderWidth: 1, borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, fontSize: 16 },
    resultRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: spacing.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: tokens.divider,
    },
    poster: { width: 38, height: 57, marginRight: spacing.sm, borderRadius: radius.sm, backgroundColor: tokens.surfaceElevated },
  });
}

const styles = StyleSheet.create({
  summary: { flexDirection: 'row', justifyContent: 'space-around', padding: spacing.md },
  stat: { alignItems: 'center' },
  actions: { flexDirection: 'row', paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderTopWidth: 1 },
  row: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.sm },
});