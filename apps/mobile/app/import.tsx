import React, { useEffect, useRef, useState } from 'react';
import { useRouter, useNavigation, useLocalSearchParams } from 'expo-router';
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { Ionicons } from '@expo/vector-icons';
import { useQueryClient, useQuery } from '@tanstack/react-query';
import { MediaType } from '@tvwatch/shared';
import { Header } from '../components/Header';
import { api } from '../api/client';
import {
  Button,
  Card,
  Chip,
  EmptyState,
  ProgressBar,
  Screen,
  Spinner,
  T,
} from '../components/primitives';
import {
  useCancelImport,
  useConfirmImport,
  useFeatureFlags,
  useImport,
  useImportItems,
  usePatchImportItem,
  useResolveAllForShow,
  useResolveByName,
  useUploadImport,
} from '../api/hooks';
import { ResolveMediaModal } from '../components/ResolveMediaModal';
import { useAppearance } from '../context/PreferencesProvider';
import { radius, spacing } from '../theme/theme';
import { showError, showInfo, showSuccess, showConfirm, showDialog } from '../lib/dialog';
import { useTranslation } from 'react-i18next';

export default function ImportScreen() {
  const { tokens } = useAppearance();
  const { t } = useTranslation(['import', 'common']);
  const router = useRouter();
  const qc = useQueryClient();
  // Opened from quick-setup onboarding (/import?returnTo=onboarding): after a
  // completed import, return to the onboarding completion screen instead of
  // dropping back onto the upload form.
  const { returnTo } = useLocalSearchParams<{ returnTo?: string }>();
  const [importId, setImportId] = useState<string | null>(null);
  const [activeItem, setActiveItem] = useState<any | null>(null);
  const upload = useUploadImport();
  const importQ = useImport(importId ?? undefined);
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
  const isProcessing =
    status &&
    !['READY_FOR_REVIEW', 'COMPLETED', 'FAILED', 'CANCELLED', 'ROLLED_BACK'].includes(status);

  // Guard every back path (header back, system back/gesture, browser back) while the
  // review is unconfirmed, via react-navigation's beforeRemove (works native + web —
  // usePreventRemove is native-only). The explicit Cancel button bypasses via leaveNow.
  const [leaveNow, setLeaveNow] = useState(false);
  const navigation = useNavigation();
  const guardArmed = useRef(false);
  guardArmed.current = status === 'READY_FOR_REVIEW' && !leaveNow;
  useEffect(() => {
    const sub = navigation.addListener('beforeRemove', (e: any) => {
      if (!guardArmed.current) return;
      e.preventDefault();
      showConfirm({
        title: t('import:leaveTitle'),
        description: t('import:leaveDesc'),
        confirmLabel: t('import:leaveConfirm'),
        destructive: true,
        onConfirm: () => navigation.dispatch(e.data.action),
      });
    });
    return sub;
  }, [navigation, t]);
  useEffect(() => {
    if (leaveNow) router.back();
  }, [leaveNow]);

  // Resume prompt: when the import screen opens with no active import, offer to continue
  // the user's latest unfinished import — or start fresh (which cancels the old ones so
  // they never trigger the prompt again; re-uploading stays idempotent).
  const resumableQ = useQuery({
    queryKey: ['importResumable'],
    queryFn: () => api.get<{ import: any }>('/imports/resumable'),
    enabled: !importId && importsEnabled,
    staleTime: 30_000,
  });
  const [resumePrompted, setResumePrompted] = useState(false);
  useEffect(() => {
    const pending = resumableQ.data?.import;
    if (importId || resumePrompted || !pending) return;
    setResumePrompted(true);
    showDialog({
      title: t('import:resumeTitle'),
      description: t('import:resumeDesc', {
        count: (pending.needsReviewCount ?? 0) + (pending.unmatchedCount ?? 0),
      }),
      buttons: [
        {
          label: t('import:resumeContinue'),
          variant: 'primary',
          onPress: () => setImportId(pending.id),
        },
        {
          label: t('import:resumeStartNew'),
          variant: 'secondary',
          onPress: async () => {
            try {
              await api.post('/imports/dismiss-pending', {});
              qc.invalidateQueries({ queryKey: ['importResumable'] });
            } catch {
              // Best-effort dismiss — the upload UI is already up either way.
            }
          },
        },
        { label: t('common:cancel'), variant: 'ghost' },
      ],
    });
  }, [resumableQ.data?.import, importId, resumePrompted, qc, t]);

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
            showError({
              title: t('import:uploadFailed'),
              description: e?.message ?? t('import:couldNotUpload'),
            });
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
      fd.append('file', {
        uri: file.uri,
        name: file.name,
        type: file.mimeType || 'application/octet-stream',
      } as any);
      const r = await upload.mutateAsync(fd);
      setImportId(r.importId);
      importQ.refetch();
    } catch (e: any) {
      showError({
        title: t('import:uploadFailed'),
        description: e?.message ?? t('import:couldNotUpload'),
      });
    }
  };

  const confirm = useConfirmImport();
  const cancel = useCancelImport();

  // Cancel the import and leave via the guard-bypassing state (the backend cancel is
  // fire-and-forget; the route pop happens after leaveNow unregisters the guard).
  const doCancel = () => {
    if (importId) cancel.mutate(importId);
    setLeaveNow(true);
  };

  if (!importId) {
    return (
      <Screen>
        <Header title={t('import:title')} showBack />
        {importsEnabled ? (
          <View style={{ padding: spacing.lg, gap: spacing.lg }}>
            <Card>
              <T variant="h2">{t('import:importFromTvTimeOrTrakt')}</T>
              <T variant="caption" muted style={{ marginTop: spacing.sm }}>
                {t('import:uploadPrefix')}
                <T variant="caption" style={{ fontWeight: '700', color: tokens.primary }}>
                  {t('import:zipFile')}
                </T>
                {t('import:uploadSuffix')} {t('import:howItWorks')}
              </T>
              <Button
                title={t('import:selectZip')}
                icon="document-outline"
                onPress={pickFile}
                loading={upload.isPending}
                style={{ marginTop: spacing.md }}
              />
            </Card>
            <T variant="micro" muted>
              {t('import:limits')}
            </T>
          </View>
        ) : (
          <View style={{ padding: spacing.xl }}>
            <EmptyState
              title={t('import:disabledTitle')}
              subtitle={t('import:disabledDesc')}
              icon="cloud-offline-outline"
            />
          </View>
        )}
      </Screen>
    );
  }

  if (isProcessing) {
    const pct = Math.min(100, Math.max(0, Math.round(importQ.data?.progress ?? 0)));
    return (
      <Screen>
        <Header title={t('import:title')} showBack />
        <View
          style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl }}
        >
          <Spinner />
          <T variant="h2" style={{ marginTop: spacing.lg }}>
            {STATUS_LABEL[status] ?? t('import:processing')}
          </T>
          <View style={{ alignSelf: 'stretch', marginTop: spacing.lg }}>
            <ProgressBar value={pct / 100} />
            <T variant="caption" muted style={{ marginTop: spacing.xs, textAlign: 'center' }}>
              {t('import:progressPercent', { pct })}
            </T>
          </View>
          <T variant="caption" muted style={{ marginTop: spacing.sm, textAlign: 'center' }}>
            {t('import:matchingDesc')}
          </T>
          <Button
            title={t('import:cancel')}
            variant="ghost"
            onPress={doCancel}
            style={{ marginTop: spacing.lg }}
          />
        </View>
      </Screen>
    );
  }

  if (status === 'FAILED') {
    return (
      <Screen>
        <Header title={t('import:title')} showBack />
        <EmptyState
          title={t('import:importFailed')}
          subtitle={importQ.data?.errorMessage ?? t('import:tryAgain')}
          icon="alert-circle-outline"
          cta={t('common:startOver')}
          onCta={() => setImportId(null)}
        />
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
            <T variant="body" style={{ marginTop: spacing.sm }}>
              {t('import:created', { count: confirm.data?.created ?? 0 })}
            </T>
            <T variant="body" muted>
              {t('import:skipped', { count: confirm.data?.skipped ?? 0 })}
            </T>
            <Button
              title={t('import:done')}
              onPress={() => {
                qc.invalidateQueries();
                setImportId(null);
                if (returnTo === 'onboarding') {
                  router.replace('/onboarding/done?source=import' as any);
                }
              }}
              style={{ marginTop: spacing.md }}
            />
          </Card>
        </View>
      </Screen>
    );
  }

  // READY_FOR_REVIEW
  const imp = importQ.data;
  const processingDuration = formatImportDuration(imp?.createdAt, imp?.processedAt);
  const totals = imp?.importTotals;
  const totalsParts: string[] = [];
  if (processingDuration)
    totalsParts.push(t('import:succeededIn', { duration: processingDuration }));
  if (totals) {
    if (totals.shows) totalsParts.push(`${totals.shows} ${t('import:shows').toLowerCase()}`);
    if (totals.movies) totalsParts.push(`${totals.movies} ${t('import:movies').toLowerCase()}`);
    if (totals.lists) totalsParts.push(`${totals.lists} ${t('import:lists').toLowerCase()}`);
    if (totals.comments)
      totalsParts.push(`${totals.comments} ${t('import:comments').toLowerCase()}`);
    if (totals.reactions)
      totalsParts.push(`${totals.reactions} ${t('import:emotions').toLowerCase()}`);
    if (totals.ratings) totalsParts.push(`${totals.ratings} ${t('import:ratings').toLowerCase()}`);
    if (totals.characterVotes)
      totalsParts.push(`${totals.characterVotes} ${t('import:characterVotes').toLowerCase()}`);
  }
  return (
    <Screen>
      <Header title={t('import:reviewImport')} showBack />
      {totalsParts.length ? (
        <T variant="micro" muted style={styles.durationLine}>
          {totalsParts.join(' · ')}
        </T>
      ) : null}
      <View style={styles.summary}>
        <Stat label={t('import:matched')} value={imp?.matchedCount} color={tokens.watched} />
        <Stat label={t('import:needsReview')} value={imp?.needsReviewCount} color={tokens.orange} />
        <Stat label={t('import:unresolved')} value={imp?.unmatchedCount} color={tokens.textMuted} />
        <Stat label={t('import:duplicates')} value={imp?.duplicateCount} color={tokens.textMuted} />
      </View>
      <ReviewItems
        importId={importId}
        tokens={tokens}
        onResolve={setActiveItem}
        initialStatus={
          imp?.needsReviewCount
            ? 'needs_review'
            : imp?.unmatchedCount
              ? 'unmatched'
              : 'needs_review'
        }
      />
      <View style={[styles.actions, { borderTopColor: tokens.divider }]}>
        <Button
          title={t('import:confirmImport')}
          variant="watched"
          icon="checkmark"
          loading={confirm.isPending}
          onPress={() =>
            confirm.mutate(importId, {
              onError: (e: any) =>
                showError({
                  title: t('import:importFailed'),
                  description: e?.message ?? t('common:tryAgain'),
                }),
            })
          }
          style={{ flex: 1 }}
        />
        <Button
          title={t('import:cancel')}
          variant="ghost"
          onPress={doCancel}
          style={{ marginLeft: spacing.sm }}
        />
      </View>
      <ImportResolutionModal
        item={activeItem}
        importId={importId}
        onClose={() => setActiveItem(null)}
      />
    </Screen>
  );
}

function Stat({ label, value, color }: { label: string; value?: number; color: string }) {
  return (
    <View style={styles.stat}>
      <T variant="title" style={{ color }}>
        {value ?? 0}
      </T>
      <T variant="micro" muted>
        {label}
      </T>
    </View>
  );
}

/** Compact processing duration: "45s" · "2m 45s" · "1h 12m". */
function formatImportDuration(createdAt?: string, processedAt?: string): string | null {
  if (!createdAt || !processedAt) return null;
  const ms = new Date(processedAt).getTime() - new Date(createdAt).getTime();
  if (!(ms > 0)) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs ? `${m}m ${rs}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

function ReviewItems({
  importId,
  tokens,
  onResolve,
  initialStatus,
}: {
  importId: string;
  tokens: ReturnType<typeof useAppearance>['tokens'];
  onResolve: (item: any) => void;
  initialStatus: 'needs_review' | 'unmatched';
}) {
  const { t } = useTranslation(['import', 'common']);
  const [statusFilter, setStatusFilter] = useState<string | undefined>(initialStatus);
  const [entityFilter, setEntityFilter] = useState<string | undefined>(undefined);
  const q = useImportItems(importId, statusFilter, entityFilter);
  const resolveByName = useResolveByName(importId);
  // Dedupe by id (defensive); the list is now a single page so pagination drift is gone.
  const seen = new Set<string>();
  const items = (q.data?.items ?? []).filter((it) => (seen.has(it.id) ? false : seen.add(it.id)));

  const ENTITY_FILTERS: { key: string | undefined; label: string }[] = [
    { key: undefined, label: t('import:allTypes') },
    { key: 'WATCHLIST_SHOW', label: t('import:shows') },
    { key: 'WATCHLIST_MOVIE', label: t('import:movies') },
    { key: 'WATCHED_MOVIE', label: t('import:watchedMovies') },
    { key: 'WATCHED_EPISODE', label: t('import:episodes') },
    { key: 'FAVORITE_SHOW,FAVORITE_MOVIE', label: t('import:favorites') },
    { key: 'LIST,LIST_ITEM', label: t('import:lists') },
    { key: 'EPISODE_RATING', label: t('import:episodeRatings') },
    { key: 'MOVIE_RATING', label: t('import:movieRatings') },
    { key: 'EPISODE_EMOTION', label: t('import:episodeEmotions') },
    { key: 'MOVIE_EMOTION', label: t('import:movieEmotions') },
    { key: 'EPISODE_COMMENT', label: t('import:episodeComments') },
    { key: 'MOVIE_COMMENT', label: t('import:movieComments') },
    {
      key: 'EPISODE_CHARACTER_VOTE,MOVIE_CHARACTER_VOTE',
      label: t('import:characterVotes'),
    },
  ];

  const FILTERS: { key: string | undefined; label: string }[] = [
    { key: undefined, label: t('import:filters.all') },
    { key: 'matched', label: t('import:filters.matched') },
    { key: 'needs_review', label: t('import:filters.needsReview') },
    { key: 'unmatched', label: t('import:unresolved') },
    { key: 'pending_match', label: t('import:filters.pendingMatch') },
    { key: 'duplicate', label: t('import:filters.duplicates') },
  ];

  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      <View style={{ height: 40, justifyContent: 'center' }}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: spacing.lg }}
        >
          {ENTITY_FILTERS.map((f) => (
            <Chip
              key={f.label}
              label={f.label}
              active={entityFilter === f.key}
              onPress={() => setEntityFilter(f.key)}
            />
          ))}
        </ScrollView>
      </View>
      <View style={{ height: 40, justifyContent: 'center', marginTop: 4 }}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: spacing.lg }}
        >
          {FILTERS.map((f) => (
            <Chip
              key={f.label}
              label={f.label}
              active={statusFilter === f.key}
              onPress={() => setStatusFilter(f.key)}
            />
          ))}
        </ScrollView>
      </View>
      <FlatList
        key={`${statusFilter ?? 'all'}:${entityFilter ?? 'all'}`}
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
                  <T variant="body" numberOfLines={1}>
                    {describeItem(entityType, norm, t)}
                  </T>
                  <T variant="micro" muted>
                    {entityType.replace(/_/g, ' ').toLowerCase()}
                    {season != null ? ` · S${season}E${episode ?? ''}` : ''}
                  </T>
                </View>
                <T variant="micro" style={{ color: statusColor(item.status, tokens) }}>
                  {statusLabel(item.status, t)}
                </T>
              </Card>
            </Pressable>
          );
        }}
        ListEmptyComponent={
          q.isLoading || q.isFetching ? (
            <Spinner />
          ) : q.isError ? (
            <View style={{ padding: spacing.xl, alignItems: 'center', gap: spacing.md }}>
              <T variant="caption" muted style={{ textAlign: 'center' }}>
                {t('import:tryAgain')}
              </T>
              <Button title={t('common:tryAgain')} variant="ghost" onPress={() => q.refetch()} />
            </View>
          ) : (
            <T variant="caption" muted style={{ padding: spacing.xl, textAlign: 'center' }}>
              {t('import:noItems')}
            </T>
          )
        }
      />
      {statusFilter === 'needs_review' && (
        <Pressable
          style={[
            styles.fab,
            { backgroundColor: tokens.primary, shadowColor: tokens.overlayStrong },
          ]}
          disabled={resolveByName.isPending}
          onPress={() =>
            resolveByName.mutate(
              { status: statusFilter, entity: entityFilter },
              {
                onSuccess: (r) =>
                  r.resolved > 0
                    ? showSuccess({
                        title: t('import:resolveByName'),
                        description: t('import:resolveByNameResult', {
                          resolved: r.resolved,
                          examined: r.examined,
                        }),
                      })
                    : showInfo({
                        title: t('import:resolveByName'),
                        description: t('import:resolveByNameNone'),
                      }),
                onError: (e: any) =>
                  showError({
                    title: t('import:resolveByName'),
                    description: e?.message ?? t('common:tryAgain'),
                  }),
              },
            )
          }
        >
          {resolveByName.isPending ? (
            <ActivityIndicator color={tokens.primaryForeground} size="small" />
          ) : (
            <>
              <Ionicons name="sparkles" size={16} color={tokens.primaryForeground} />
              <T variant="caption" style={{ color: tokens.primaryForeground, fontWeight: '700' }}>
                {t('import:resolveByName')}
              </T>
            </>
          )}
        </Pressable>
      )}
    </View>
  );
}

function statusColor(s: string, tokens: ReturnType<typeof useAppearance>['tokens']): string {
  switch (s) {
    case 'MATCHED':
      return tokens.watched;
    case 'PENDING_MATCH':
      return tokens.primary;
    case 'NEEDS_REVIEW':
      return tokens.orange;
    case 'DUPLICATE':
      return tokens.textMuted;
    default:
      return tokens.textMuted;
  }
}

/** Friendly status label for review rows (raw status otherwise). */
function statusLabel(s: string, t: (k: string, o?: any) => string): string {
  if (s === 'PENDING_MATCH') return t('import:filters.pendingMatch');
  return s;
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
  const isCharacterVote =
    entityType === 'EPISODE_CHARACTER_VOTE' || entityType === 'MOVIE_CHARACTER_VOTE';

  // Target title: episode/show use showTitle, movie uses movieTitle, legacy items use title.
  const title = norm.showTitle ?? norm.movieTitle ?? norm.title ?? t('import:noTitle');

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
  if (isCharacterVote) {
    return `${title}  ·  ${t('import:characterVoteLabel')}`;
  }
  if (entityType === 'LIST') {
    // The list itself: show how many of its objects resolved (resolved/total).
    const resolved = norm.resolvedCount;
    const total = norm.itemCount;
    return resolved != null && total != null ? `${title}  ·  ${resolved}/${total}` : title;
  }
  return title;
}

/**
 * Import-specific wiring around the shared media-resolve modal: derives the item's
 * titles/season context and adds the bulk apply-to-season/whole-show + skip actions.
 */
function ImportResolutionModal({
  item,
  importId,
  onClose,
}: {
  item: any | null;
  importId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation(['import', 'common']);
  const patch = usePatchImportItem(importId);
  const resolveAll = useResolveAllForShow(importId);

  const norm = item?.normalizedData ?? {};
  const entityType = item ? String(item.sourceEntityType) : '';
  // LIST_ITEM (and list-staged favorites) carry their kind in normalizedData.mediaType —
  // without it a movie list item would search shows (and resolve against one).
  const normMediaType = String(norm?.mediaType ?? '').toLowerCase();
  const isMovie = /MOVIE/.test(entityType) || normMediaType === 'movie';
  // Episode info for watched episodes / episode ratings/emotions/comments (S16E9 etc.).
  const season = norm.season ?? norm.seasonNumber;
  const episode = norm.episode ?? norm.episodeNumber;
  const episodeTag = season != null ? `S${season}E${episode ?? ''}` : '';
  const sourceTitle = norm.showTitle ?? norm.movieTitle ?? norm.title ?? t('import:noTitle');
  const showSourceTitle = norm.showTitle ?? norm.title;

  const resolve = async (
    result: any,
    bulk: { applyToSeason: boolean; applyToWholeShow: boolean },
  ) => {
    if (!item) return;
    try {
      // A MOVIE target always resolves JUST this item: an episode→movie match is 1:1
      // (a season's episodes are different movies — never the same one), so the
      // apply-to-season/whole-show bulk path is intentionally bypassed for movies.
      const targetIsMovie = result?.type === MediaType.MOVIE;
      if (
        !targetIsMovie &&
        !isMovie &&
        showSourceTitle &&
        (bulk.applyToSeason || bulk.applyToWholeShow)
      ) {
        const resolveSeason = bulk.applyToWholeShow ? null : (season ?? null);
        const r = await resolveAll.mutateAsync({
          matchedMediaId: result.id,
          sourceTitle: showSourceTitle,
          season: resolveSeason,
        });
        // Bulk transparency: a single pick can resolve a whole season/show at once —
        // tell the user exactly how many items moved instead of a silent counter jump.
        if (r.matched > 1) {
          showInfo({
            title: t('import:resolvedBulk', { count: r.matched, title: showSourceTitle }),
          });
        }
      } else {
        await patch.mutateAsync({ itemId: item.id, matchedMediaId: result.id });
      }
      onClose();
    } catch (e: any) {
      showError({ description: e?.message ?? t('common:tryAgain') });
    }
  };
  const skip = async () => {
    if (!item) return;
    try {
      await patch.mutateAsync({ itemId: item.id, userResolution: 'skip' });
      onClose();
    } catch (e: any) {
      showError({ description: e?.message ?? t('common:tryAgain') });
    }
  };

  return (
    <ResolveMediaModal
      visible={!!item}
      sourceTitle={sourceTitle}
      isMovie={isMovie}
      // Prefill stays empty for untitled items (sourceTitle falls back to "(no title)").
      initialQuery={(norm.showTitle ?? norm.movieTitle ?? norm.title ?? '').trim()}
      targetSeason={season ?? null}
      onClose={onClose}
      importResolve={{
        subtitle:
          entityType.replace(/_/g, ' ').toLowerCase() + (episodeTag ? ` · ${episodeTag}` : ''),
        season: season ?? null,
        showBulkOptions: !isMovie && !!showSourceTitle,
        onConfirm: resolve,
        onSkip: skip,
        skipPending: patch.isPending,
      }}
    />
  );
}

const styles = StyleSheet.create({
  summary: { flexDirection: 'row', justifyContent: 'space-around', padding: spacing.md },
  stat: { flex: 1, alignItems: 'center' },
  actions: {
    flexDirection: 'row',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderTopWidth: 1,
  },
  row: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.sm },
  durationLine: {
    textAlign: 'left',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xs,
  },
  fab: {
    position: 'absolute',
    right: spacing.lg,
    bottom: spacing.xl,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    elevation: 6,
    shadowOpacity: 0.25,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
  },
});
