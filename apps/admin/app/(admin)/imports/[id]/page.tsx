'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';
import { Badge, StatCard, Table } from '@/components/ui';
import { showConfirm, showError, showInfo, showSuccess } from '@/lib/dialog';

const STATUS_FILTERS = [
  '',
  'NEEDS_REVIEW',
  'UNMATCHED',
  'MATCHED',
  'PENDING_MATCH',
  'DUPLICATE',
  'SKIPPED',
  'APPLIED',
];

const ENTITY_FILTERS = [
  ['', 'All types'],
  ['WATCHLIST_SHOW', 'Shows'],
  ['WATCHLIST_MOVIE', 'Movies'],
  ['WATCHED_MOVIE', 'Watched movies'],
  ['WATCHED_EPISODE', 'Episodes'],
  ['FAVORITE_SHOW,FAVORITE_MOVIE', 'Favorites'],
  ['LIST,LIST_ITEM', 'Lists'],
  ['EPISODE_RATING', 'Episode ratings'],
  ['MOVIE_RATING', 'Movie ratings'],
  ['SHOW_RATING', 'Show ratings'],
  ['EPISODE_EMOTION', 'Episode emotions'],
  ['MOVIE_EMOTION', 'Movie emotions'],
  ['EPISODE_COMMENT', 'Episode comments'],
  ['MOVIE_COMMENT', 'Movie comments'],
  ['SHOW_COMMENT', 'Show comments'],
  ['EPISODE_CHARACTER_VOTE,MOVIE_CHARACTER_VOTE', 'Character votes'],
];

const processingStatuses = new Set([
  'UPLOADED',
  'QUEUED',
  'EXTRACTING',
  'PARSING',
  'NORMALIZING',
  'MATCHING',
  'IMPORTING',
]);

const label = (value: string) => value.replace(/_/g, ' ').toLowerCase();

const badgeColor = (status: string) => {
  if (status === 'MATCHED' || status === 'APPLIED' || status === 'COMPLETED') return 'success';
  if (status === 'NEEDS_REVIEW' || status === 'READY_FOR_REVIEW') return 'warning';
  if (status === 'FAILED' || status === 'CANCELLED' || status === 'INVALID') return 'danger';
  if (status === 'PENDING_MATCH' || processingStatuses.has(status)) return 'accent';
  return 'default';
};

const describeItem = (item: any) => {
  const entityType = String(item.sourceEntityType);
  const normalized = item.normalizedData ?? {};
  const title =
    normalized.showTitle ?? normalized.movieTitle ?? normalized.title ?? '(no title available)';
  if (entityType.endsWith('_COMMENT')) {
    return typeof normalized.text === 'string' && normalized.text.length
      ? normalized.text.slice(0, 100)
      : title;
  }
  if (entityType.endsWith('_RATING') && normalized.normalizedRating) {
    return `${title} · ★ ${normalized.normalizedRating}/5`;
  }
  if (entityType.endsWith('_EMOTION') && normalized.normalizedEmotion) {
    return `${title} · ${String(normalized.normalizedEmotion).toLowerCase()}`;
  }
  if (entityType === 'EPISODE_CHARACTER_VOTE' || entityType === 'MOVIE_CHARACTER_VOTE') {
    return `${title} · character vote`;
  }
  if (entityType === 'LIST' && normalized.itemCount != null) {
    return `${title} · ${normalized.resolvedCount ?? 0}/${normalized.itemCount}`;
  }
  return title;
};

const sourceTitle = (item: any) => {
  const normalized = item?.normalizedData ?? {};
  return normalized.showTitle ?? normalized.movieTitle ?? normalized.title ?? '';
};

const mediaTypeFor = (item: any) => {
  const entityType = String(item?.sourceEntityType ?? '');
  const normalizedType = String(item?.normalizedData?.mediaType ?? '').toLowerCase();
  return /MOVIE/.test(entityType) || normalizedType === 'movie' ? 'MOVIE' : 'SHOW';
};

export default function ImportDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<any>(null);
  const [itemsData, setItemsData] = useState<any>(null);
  const [statusFilter, setStatusFilter] = useState('NEEDS_REVIEW');
  const [entityFilter, setEntityFilter] = useState('');
  const [loadingItems, setLoadingItems] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [resolveItem, setResolveItem] = useState<any>(null);
  const [mediaQuery, setMediaQuery] = useState('');
  const [mediaResults, setMediaResults] = useState<any[]>([]);
  const [searchingMedia, setSearchingMedia] = useState(false);
  const previousImportStatus = useRef<string>();

  const loadDetail = useCallback(async () => {
    try {
      const response = await api.get(`/admin/imports/${id}`);
      setDetail(response.data);
      setError('');
    } catch (requestError: any) {
      setError(requestError.response?.data?.message ?? 'Could not load this import.');
    }
  }, [id]);

  const loadItems = useCallback(async () => {
    setLoadingItems(true);
    try {
      const params: Record<string, string | number> = { page: 1, pageSize: 500 };
      if (statusFilter) params.status = statusFilter;
      if (entityFilter) params.entity = entityFilter;
      const response = await api.get(`/admin/imports/${id}/items`, { params });
      setItemsData(response.data);
    } catch (requestError: any) {
      setError(requestError.response?.data?.message ?? 'Could not load import items.');
    } finally {
      setLoadingItems(false);
    }
  }, [entityFilter, id, statusFilter]);

  const refresh = useCallback(async () => {
    await Promise.all([loadDetail(), loadItems()]);
  }, [loadDetail, loadItems]);

  useEffect(() => {
    loadDetail();
  }, [loadDetail]);

  useEffect(() => {
    loadItems();
  }, [loadItems]);

  useEffect(() => {
    if (!detail?.status || !processingStatuses.has(detail.status)) return;
    const timer = window.setInterval(loadDetail, 2500);
    return () => window.clearInterval(timer);
  }, [detail?.status, loadDetail]);

  useEffect(() => {
    const previousStatus = previousImportStatus.current;
    previousImportStatus.current = detail?.status;
    if (
      detail?.status === 'READY_FOR_REVIEW' &&
      previousStatus &&
      processingStatuses.has(previousStatus)
    ) {
      loadItems();
    }
  }, [detail?.status, loadItems]);

  const autoResolve = () => {
    showConfirm({
      title: 'Auto-resolve unresolved items?',
      description:
        'Titles are accepted only when the existing verified matcher finds a safe media match. Ambiguous rows remain for review.',
      confirmLabel: 'Auto-resolve',
      onConfirm: async () => {
        setBusy('resolve');
        try {
          const response = await api.post(`/admin/imports/${id}/auto-resolve`, {
            entity: entityFilter || undefined,
          });
          await refresh();
          const result = response.data;
          if (result.resolved > 0) {
            showSuccess({
              title: 'Auto-resolution complete',
              description: `${result.resolved} of ${result.examined} examined items were resolved.`,
            });
          } else {
            showInfo({
              title: 'No safe matches found',
              description: 'The remaining items still require manual review or can be skipped.',
            });
          }
        } catch (requestError: any) {
          showError({
            title: 'Auto-resolution failed',
            description: requestError.response?.data?.message ?? 'Please try again.',
          });
        } finally {
          setBusy('');
        }
      },
    });
  };

  const confirmImport = () => {
    showConfirm({
      title: `Apply this import to ${detail?.user?.username ?? 'the user'}?`,
      description: `${detail?.needsReviewCount ?? 0} items still need review and ${detail?.unmatchedCount ?? 0} are unmatched. Those rows will not be applied. Matched rows will modify the user's library.`,
      confirmLabel: 'Confirm and apply',
      onConfirm: async () => {
        setBusy('confirm');
        try {
          const response = await api.post(`/admin/imports/${id}/confirm`, {});
          await refresh();
          showSuccess({
            title: 'Import applied',
            description: `${response.data.created} records created; ${response.data.skipped} skipped.`,
          });
        } catch (requestError: any) {
          showError({
            title: 'Import failed',
            description: requestError.response?.data?.message ?? 'Please try again.',
          });
        } finally {
          setBusy('');
        }
      },
    });
  };

  const openResolver = async (item: any) => {
    const query = sourceTitle(item);
    setResolveItem(item);
    setMediaQuery(query);
    setMediaResults([]);
    if (query) await searchMedia(query, item);
  };

  const searchMedia = async (query: string, item = resolveItem) => {
    if (!query.trim() || !item) return;
    setSearchingMedia(true);
    try {
      const response = await api.get('/admin/media', {
        params: { search: query.trim(), type: mediaTypeFor(item), page: 1, pageSize: 20 },
      });
      setMediaResults(response.data.items ?? []);
    } catch (requestError: any) {
      showError({
        title: 'Media search failed',
        description: requestError.response?.data?.message ?? 'Please try again.',
      });
    } finally {
      setSearchingMedia(false);
    }
  };

  const resolveTo = async (matchedMediaId: string) => {
    if (!resolveItem) return;
    setBusy('item');
    try {
      await api.patch(`/admin/imports/${id}/items/${resolveItem.id}`, { matchedMediaId });
      setResolveItem(null);
      await refresh();
    } catch (requestError: any) {
      showError({
        title: 'Could not resolve item',
        description: requestError.response?.data?.message ?? 'Please try again.',
      });
    } finally {
      setBusy('');
    }
  };

  const skipItem = async () => {
    if (!resolveItem) return;
    setBusy('item');
    try {
      await api.patch(`/admin/imports/${id}/items/${resolveItem.id}`, {
        userResolution: 'skip',
      });
      setResolveItem(null);
      await refresh();
    } catch (requestError: any) {
      showError({
        title: 'Could not skip item',
        description: requestError.response?.data?.message ?? 'Please try again.',
      });
    } finally {
      setBusy('');
    }
  };

  const canReview = detail?.status === 'READY_FOR_REVIEW';
  const canConfirm = canReview || (detail?.status === 'FAILED' && detail?.processedAt != null);
  const totals = detail?.importTotals;
  const totalsLine = useMemo(() => {
    if (!totals) return '';
    return [
      totals.shows ? `${totals.shows} shows` : '',
      totals.movies ? `${totals.movies} movies` : '',
      totals.lists ? `${totals.lists} lists` : '',
      totals.comments ? `${totals.comments} comments` : '',
      totals.reactions ? `${totals.reactions} emotions` : '',
      totals.ratings ? `${totals.ratings} ratings` : '',
      totals.characterVotes ? `${totals.characterVotes} character votes` : '',
    ]
      .filter(Boolean)
      .join(' · ');
  }, [totals]);

  if (!detail && !error)
    return <div className="py-20 text-center text-white/40">Loading import...</div>;

  return (
    <div className="space-y-6">
      <div>
        <Link href="/imports" className="text-sm text-white/40 hover:text-accent">
          ← User imports
        </Link>
        <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold">Import review</h1>
              {detail ? (
                <Badge color={badgeColor(detail.status)}>{label(detail.status)}</Badge>
              ) : null}
            </div>
            {detail ? (
              <div className="mt-2 text-sm text-white/50">
                <Link href={`/users/${detail.user.id}`} className="text-accent hover:underline">
                  {detail.user.username}
                </Link>{' '}
                · {detail.user.email} · {detail.originalFilename || 'Unknown file'}
              </div>
            ) : null}
            {totalsLine ? <div className="mt-1 text-xs text-white/30">{totalsLine}</div> : null}
          </div>
          <div className="flex gap-2">
            <button
              disabled={!canReview || !!busy}
              onClick={autoResolve}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-bold text-bg disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy === 'resolve' ? 'Resolving...' : 'Auto-resolve unresolved'}
            </button>
            <button
              disabled={!canConfirm || !!busy}
              onClick={confirmImport}
              className="rounded-lg bg-success px-4 py-2 text-sm font-bold text-bg disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy === 'confirm' ? 'Applying...' : 'Confirm and apply'}
            </button>
          </div>
        </div>
      </div>

      {error ? (
        <div className="rounded-xl border border-danger/30 bg-danger/10 p-4 text-sm text-danger">
          {error}
        </div>
      ) : null}

      {detail ? (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
          <StatCard label="Progress" value={`${detail.progress}%`} />
          <StatCard label="Matched" value={detail.matchedCount ?? 0} color="text-success" />
          <StatCard
            label="Needs review"
            value={detail.needsReviewCount ?? 0}
            color="text-warning"
          />
          <StatCard label="Unmatched" value={detail.unmatchedCount ?? 0} />
          <StatCard label="Duplicates" value={detail.duplicateCount ?? 0} />
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {STATUS_FILTERS.map((status) => (
            <button
              key={status || 'ALL'}
              onClick={() => setStatusFilter(status)}
              className={`rounded-full px-3 py-1.5 text-xs transition ${
                statusFilter === status
                  ? 'bg-accent text-bg'
                  : 'bg-surface-alt text-white/50 hover:text-white'
              }`}
            >
              {status ? label(status) : 'all statuses'}
            </button>
          ))}
        </div>
        <select
          value={entityFilter}
          onChange={(event) => setEntityFilter(event.target.value)}
          className="rounded-lg border border-border bg-surface-alt px-3 py-2 text-sm text-white focus:border-accent focus:outline-none"
        >
          {ENTITY_FILTERS.map(([value, text]) => (
            <option key={value || 'all'} value={value}>
              {text}
            </option>
          ))}
        </select>
      </div>

      {itemsData ? (
        <>
          <div className="text-xs text-white/30">
            Showing {itemsData.items.length} of {itemsData.total} items for this filter
          </div>
          <Table headers={['Item', 'Type', 'Episode', 'Confidence', 'Status', 'Action']}>
            {itemsData.items.map((item: any) => {
              const normalized = item.normalizedData ?? {};
              const season = normalized.season ?? normalized.seasonNumber;
              const episode = normalized.episode ?? normalized.episodeNumber;
              const reviewable =
                canReview && ['NEEDS_REVIEW', 'UNMATCHED'].includes(String(item.status));
              return (
                <tr key={item.id} className="border-b border-border/50 hover:bg-surface-alt/20">
                  <td className="max-w-xl px-4 py-3">
                    <div className="truncate text-sm">{describeItem(item)}</div>
                    {item.errorMessage ? (
                      <div className="mt-1 truncate text-xs text-danger">{item.errorMessage}</div>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-xs text-white/40">
                    {label(String(item.sourceEntityType))}
                  </td>
                  <td className="px-4 py-3 text-sm">
                    {season != null ? `S${season}E${episode ?? ''}` : '—'}
                  </td>
                  <td className="px-4 py-3 text-sm">
                    {Math.round(Number(item.confidenceScore ?? 0) * 100)}%
                  </td>
                  <td className="px-4 py-3">
                    <Badge color={badgeColor(item.status)}>{label(item.status)}</Badge>
                  </td>
                  <td className="px-4 py-3">
                    {reviewable ? (
                      <button
                        onClick={() => openResolver(item)}
                        className="text-xs text-accent hover:underline"
                      >
                        Resolve
                      </button>
                    ) : (
                      <span className="text-xs text-white/20">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </Table>
          {!itemsData.items.length && !loadingItems ? (
            <div className="py-16 text-center text-sm text-white/40">
              No items match these filters.
            </div>
          ) : null}
        </>
      ) : null}
      {loadingItems ? (
        <div className="py-8 text-center text-sm text-white/40">Loading items...</div>
      ) : null}

      {resolveItem ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={() => setResolveItem(null)}
        >
          <div
            className="max-h-[85vh] w-full max-w-2xl overflow-auto rounded-xl border border-border bg-surface p-6"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-bold">Resolve import item</h2>
                <p className="mt-1 text-sm text-white/40">{describeItem(resolveItem)}</p>
              </div>
              <button
                onClick={() => setResolveItem(null)}
                className="text-white/40 hover:text-white"
              >
                ✕
              </button>
            </div>
            <form
              className="mt-5 flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                searchMedia(mediaQuery);
              }}
            >
              <input
                value={mediaQuery}
                onChange={(event) => setMediaQuery(event.target.value)}
                className="flex-1 rounded-lg border border-border bg-surface-alt px-3 py-2 text-sm text-white focus:border-accent focus:outline-none"
                placeholder="Search the correct title..."
              />
              <button
                disabled={searchingMedia}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-bold text-bg disabled:opacity-40"
              >
                {searchingMedia ? 'Searching...' : 'Search'}
              </button>
            </form>
            <div className="mt-4 divide-y divide-border">
              {mediaResults.map((media) => (
                <button
                  key={media.id}
                  disabled={busy === 'item'}
                  onClick={() => resolveTo(media.id)}
                  className="flex w-full items-center justify-between gap-4 px-2 py-3 text-left hover:bg-surface-alt disabled:opacity-40"
                >
                  <div>
                    <div className="text-sm font-medium">{media.title}</div>
                    <div className="text-xs text-white/30">
                      {media.type.toLowerCase()} ·{' '}
                      {media.show?.yearStart ?? media.movie?.releaseYear ?? 'year unknown'}
                    </div>
                  </div>
                  <span className="text-xs text-accent">Use this match</span>
                </button>
              ))}
            </div>
            {!searchingMedia && !mediaResults.length ? (
              <div className="py-8 text-center text-sm text-white/30">No search results yet.</div>
            ) : null}
            <div className="mt-5 flex justify-between border-t border-border pt-4">
              <button
                disabled={busy === 'item'}
                onClick={skipItem}
                className="rounded-lg bg-danger/15 px-4 py-2 text-sm text-danger disabled:opacity-40"
              >
                Skip this item
              </button>
              <button
                onClick={() => setResolveItem(null)}
                className="rounded-lg bg-surface-alt px-4 py-2 text-sm text-white/60"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
