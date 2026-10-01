'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Badge } from '@/components/ui';
import IdentityPanel from './IdentityPanel';

/**
 * Metadata Health: identity defects first (Data identity panel), then content completeness.
 * Every recurring repair runs as a Scheduled Job; each card names the job that fixes it. The
 * buttons left here are per-title inspection tools and repairs no job runs.
 */

interface MetadataHealth {
  total: number;
  neverHydrated: number;
  moviesMissingOverview: number;
  byClassification: Record<string, number>;
  animeOnTmdb: number;
  animeOnTmdbNoTvdbId: number;
  animeOnTmdbDuplicates: number;
  animeTvdbUnresolvable: number;
  castMissingCharacterIds: number;
  pendingCharacterVoteItems: number;
  pendingCharacterVoteShows: number;
  pendingCharacterVoteMovies: number;
  pendingCharacterVoteShowsWithoutTvdb: number;
  nonEnglishBase: number;
  nonEnglishContent: number | null;
  nonEnglishContentParked: number | null;
  nonEnglishContentDeep: {
    totalEligible: number;
    unverified: number;
    remainingInPass: number;
    cursorPosition: number;
    cursorActive: boolean;
    verifierVersion: number;
  };
  bannerAsPoster: number;
  missingRating: number;
  recommendationsMissing: number;
  moviesMissingCountry: number;
  castDuplicateMedia: number;
  castDuplicateRows: number;
  castDuplicateVotes: number;
  dualStructureShows: number;
}

/** Live progress of one background repair job (from /admin/metadata-health/repair-progress). */
interface RepairProgress {
  running: boolean;
  /** True when the job claimed to be running but produced no update for 30+ min
   *  (its promise hung — the run never resolved). Safe to re-run. */
  stalled?: boolean;
  processed: number;
  total: number;
  succeeded: number;
  failed: number;
  remapped?: number;
  legacyQuarantined?: number;
  episodesRemoved?: number;
  transferred?: number;
  candidates?: number;
  activated?: number;
  blocked?: number;
  current?: string;
  finishedAt?: string;
  report?: {
    mode: 'dry-run' | 'repair';
    nextCursor: string | null;
    scanned: number;
    candidates: number;
    activated: number;
    blocked: number;
    results?: unknown[];
    targeted?: boolean;
    passComplete?: boolean;
    repairPassRestarted?: boolean;
  };
}

interface CanonicalizationStats {
  active: number;
  copying: number;
  failed: number;
  scanEligible: number;
  scanRemaining: number;
  scanProcessed: number;
  scanCursor: string | null;
  scanPassComplete: boolean;
  scanCompletedAt: string | null;
}

interface CastReview {
  review: {
    mediaId: string;
    title: string;
    rows: { id: string; member: string; character: string | null; votes: number }[];
  }[];
}

type Notice = { tone: 'info' | 'success' | 'error'; text: string };

/** Scheduled Jobs that keep each card converged (names as shown on the Scheduled Jobs page). */
const JOBS = {
  identity: 'Identity maintenance',
  completeness: 'Metadata completeness',
  english: 'English content repair',
} as const;

const REPAIR_LABELS: Record<string, string> = {
  'character-ids': 'Character IDs backfill',
  'anime-rehydrate': 'Anime → TVDB rehydration',
  'english-base': 'English base restore',
  'english-content': 'English content verify',
  'banner-posters': 'Banner poster repair',
  ratings: 'Rating backfill',
  recommendations: 'Recommendations backfill',
  'movie-countries': 'Movie countries backfill',
  'cast-dedup': 'Cast dedup',
  'structure-reconcile': 'Structure reconcile',
  'media-canonicalization': 'Cross-media canonicalization',
};

/** One-line guidance per stat: what it means and what fixes it. */
const STAT_HINTS: Record<string, string> = {
  total: 'All visible media rows (shows + movies). Merged-away duplicates are excluded.',
  neverHydrated:
    'Stub rows (search results, imports) that were never fully hydrated. They hydrate on first view; “Hydrate stubs” below completes a batch on demand.',
  moviesMissingOverview: 'Movies with no description. Filled when the movie is next hydrated.',
  animeOnTmdb:
    'Anime whose episode list belongs to TVDB but still has TMDB-only episodes. Identity maintenance re-hydrates them from TVDB and remaps user data. Rows whose TVDB id belongs to another row are duplicates, merged by the identity backlog instead.',
  dualStructureShows:
    'Shows whose active episodes mix TMDB and TVDB graphs. Identity maintenance re-hydrates each from its owning provider and remaps user data.',
  castMissingCharacterIds:
    'TVDB character ids missing on cast rows (needed to replay imported character votes). Pending votes replay automatically after the cast refresh.',
  castDuplicates:
    'Titles not yet scanned for duplicate cast credits. High-confidence duplicates are merged automatically (votes are moved first); name-only pairs need the manual review below.',
  nonEnglishBase:
    'Rows stored with a non-English base title. Re-hydrated with an English base; rows the provider has no English title for are parked for a week.',
  nonEnglishContent:
    'Rows whose visible title/overview (or episode text) looks non-English. Verified against the provider and re-hydrated only on a real mismatch. Deep mode checks every row, including pure-ASCII foreign text.',
  bannerAsPoster:
    'Posters that are really wide TVDB banners, or TVDB URLs with a duplicated host. Not scheduled: run the fix when this grows.',
  missingRating:
    'Missing or stale TMDB community ratings (TVDB has no public 0–10 rating, so TVDB-owned shows borrow TMDB’s).',
  recommendationsMissing: 'TMDB-linked rows whose recommendations were never synced.',
  moviesMissingCountry:
    'Movies with no production country (the explore country filter cannot match them). Rows TMDB has no country for are rechecked yearly.',
  mediaCanonicalization:
    'TVDB aggregate shows whose TMDB season-components can be folded into them. Not scheduled: dry-run first; repair copies and verifies user data before redirecting a source.',
};

const CLASSIFICATION_LABELS: Record<string, { label: string; color: string }> = {
  GENERAL: { label: 'General', color: 'default' },
  ANIME: { label: 'Anime', color: 'info' },
  MANGA: { label: 'Manga', color: 'warning' },
  UNKNOWN: { label: 'Unclassified', color: 'default' },
};

const btn =
  'rounded border border-blue-600 px-2 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50 disabled:opacity-50 dark:hover:bg-blue-950';
const btnMuted =
  'rounded border border-zinc-400 px-2 py-1 text-xs font-medium text-zinc-600 hover:bg-zinc-50 disabled:opacity-50 dark:text-zinc-300 dark:hover:bg-zinc-800';
const btnDanger =
  'rounded border border-red-600 px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:hover:bg-red-950';
const input =
  'rounded border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-600 dark:bg-zinc-800';

const errorText = (e: any) => e?.response?.data?.message ?? e?.message ?? 'error';

export default function MetadataHealthPage() {
  const { user } = useAuth();
  const [stats, setStats] = useState<MetadataHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [healthNotice, setHealthNotice] = useState<string | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const healthRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [enContentStats, setEnContentStats] = useState(false);
  const [enContentDeep, setEnContentDeep] = useState(false);
  const [enContentCount, setEnContentCount] = useState('500');
  const [bannerCount, setBannerCount] = useState('500');
  const [batchCount, setBatchCount] = useState('200');
  const [syncStart, setSyncStart] = useState('');
  const [reconMediaId, setReconMediaId] = useState('');
  const [dedupInspectId, setDedupInspectId] = useState('');
  const [dedupReview, setDedupReview] = useState<CastReview | null>(null);
  const [canonicalStats, setCanonicalStats] = useState<CanonicalizationStats>({
    active: 0,
    copying: 0,
    failed: 0,
    scanEligible: 0,
    scanRemaining: 0,
    scanProcessed: 0,
    scanCursor: null,
    scanPassComplete: false,
    scanCompletedAt: null,
  });
  const [canonicalCount, setCanonicalCount] = useState('25');
  const [canonicalMediaId, setCanonicalMediaId] = useState('');
  const [canonicalDryRunCursor, setCanonicalDryRunCursor] = useState('');
  const [canonicalResult, setCanonicalResult] = useState<string | null>(null);
  const [repairs, setRepairs] = useState<Record<string, RepairProgress>>({});
  const canonicalReportHandledRef = useRef<string | null>(null);

  const canView = user?.role && ['ADMIN', 'SUPER_ADMIN'].includes(user.role);

  const load = (refresh = false) => {
    if (healthRetryRef.current) {
      clearTimeout(healthRetryRef.current);
      healthRetryRef.current = null;
    }
    // Keep the cards on screen while a background refresh is polled.
    if (!stats) setLoading(true);
    setHealthError(null);
    api
      .get('/admin/media-canonicalization/stats')
      .then((r) => setCanonicalStats(r.data))
      .catch(() => undefined);
    const params = new URLSearchParams();
    if (enContentStats) params.set('content', '1');
    if (enContentDeep) params.set('deep', '1');
    if (refresh) params.set('refresh', '1');
    const qs = params.toString();
    api
      .get(`/admin/metadata-health${qs ? `?${qs}` : ''}`)
      .then((r) => {
        const health = r.data?._health as
          | { status?: string; stale?: boolean; computedAt?: string | null; error?: string }
          | undefined;
        if (typeof r.data?.total === 'number') setStats(r.data);
        if (health?.status === 'refreshing') {
          setHealthNotice(
            health.stale
              ? `Showing the snapshot from ${health.computedAt ? new Date(health.computedAt).toLocaleString() : 'the last run'} while the numbers refresh…`
              : 'Calculating the first metadata-health snapshot in the background…',
          );
          healthRetryRef.current = setTimeout(() => load(), 3000);
        } else if (health?.status === 'failed') {
          setHealthNotice(null);
          setHealthError(health.error ?? 'The health computation failed.');
        } else {
          setHealthNotice(null);
        }
      })
      .catch((error) => setHealthError(errorText(error)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (canView) load();
  }, [canView, enContentStats, enContentDeep]);

  useEffect(
    () => () => {
      if (healthRetryRef.current) clearTimeout(healthRetryRef.current);
    },
    [],
  );

  // Live repair progress — poll every 3s while the page is open.
  useEffect(() => {
    if (!canView) return;
    const loadRepairs = () =>
      api
        .get('/admin/metadata-health/repair-progress')
        .then((r) => {
          const progress = r.data as Record<string, RepairProgress>;
          setRepairs(progress);
          const canonical = progress['media-canonicalization'];
          if (
            canonical?.finishedAt &&
            canonical.report &&
            canonicalReportHandledRef.current !== canonical.finishedAt
          ) {
            canonicalReportHandledRef.current = canonical.finishedAt;
            const report = canonical.report;
            if (report.mode === 'dry-run' && !report.targeted) {
              setCanonicalDryRunCursor(report.nextCursor ?? '');
            }
            const modeLabel =
              report.mode === 'dry-run' ? 'DRY-RUN — no data changed.' : 'REPAIR completed.';
            setCanonicalResult(
              `${modeLabel} Scanned ${report.scanned}; candidates ${report.candidates}; activated ${report.activated}; blocked ${report.blocked}; ${report.passComplete ? 'repair pass complete' : `next cursor ${report.nextCursor ?? 'end of pass'}`}. ${JSON.stringify(report.results ?? [])}`,
            );
            load(true);
          }
        })
        .catch(() => undefined);
    loadRepairs();
    const id = setInterval(loadRepairs, 3000);
    return () => clearInterval(id);
  }, [canView]);

  /** Starts a background repair; the progress panel shows it and a refresh follows. */
  const start = async (key: string, path: string, message: string, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(key);
    setNotice(null);
    try {
      await api.post(path);
      setNotice({ tone: 'info', text: message });
    } catch (e) {
      setNotice({ tone: 'error', text: `Could not start: ${errorText(e)}` });
    } finally {
      setBusy(null);
    }
  };

  /** Inspect one title for name-only duplicate cast pairs (synchronous). */
  const inspectCastDedup = () => {
    const mediaId = dedupInspectId.trim();
    if (!mediaId) return;
    setBusy('dedup-inspect');
    setDedupReview(null);
    setNotice(null);
    api
      .post(`/admin/cast-dedup/run?mode=report&mediaId=${encodeURIComponent(mediaId)}`, null, {
        timeout: 120_000,
      })
      .then((r) => {
        setDedupReview(r.data);
        if (!(r.data?.review ?? []).length)
          setNotice({ tone: 'info', text: 'No name-only duplicate cast pairs on this title.' });
      })
      .catch((e) => setNotice({ tone: 'error', text: `Inspect failed: ${errorText(e)}` }))
      .finally(() => setBusy(null));
  };

  const mergeCastPair = (mediaId: string, keepCastId: string, mergeCastId: string) => {
    if (
      !window.confirm(
        'Merge the second row into the kept row? Votes are re-pointed before the duplicate is deleted. This cannot be undone.',
      )
    )
      return;
    setBusy('dedup-merge');
    api
      .post('/admin/cast-dedup/merge', { mediaId, keepCastId, mergeCastId })
      .then((r) => {
        setNotice({
          tone: 'success',
          text: `Merged: ${r.data.votesMoved} vote(s) moved, ${r.data.rowsDeleted} row(s) deleted.`,
        });
        inspectCastDedup();
      })
      .catch((e) => setNotice({ tone: 'error', text: `Merge failed: ${errorText(e)}` }))
      .finally(() => setBusy(null));
  };

  /** Structure reconcile for ONE title (awaited; a full re-hydration can take a while). */
  const runStructureReconcile = (mode: 'dry-run' | 'repair') => {
    const mediaId = reconMediaId.trim();
    if (!mediaId) return;
    if (
      mode === 'repair' &&
      !window.confirm(
        'Re-hydrate this title from its episode-list owner and remap all user data? Run Dry-run first and review the matches.',
      )
    )
      return;
    setBusy(`recon-${mode}`);
    setNotice(null);
    api
      .post(
        `/admin/structure-reconcile/run?mode=${mode}&mediaId=${encodeURIComponent(mediaId)}`,
        null,
        { timeout: 300_000 },
      )
      .then((r) => {
        const t = r.data?.titles?.[0];
        const remap = t?.remap
          ? ` — mapped ${t.remap.mapped}, transferred ${t.remap.transferred}, deleted ${t.remap.episodesRemoved} episodes/${t.remap.seasonsRemoved} seasons, legacy ${t.remap.legacyQuarantined}, unmapped ${t.remap.unmapped}, confidence ${JSON.stringify(t.mappingConfidence)}, rules ${JSON.stringify(t.remap.matchRules)}`
          : '';
        const missing = t?.missingProviderIds?.length
          ? `; missing IDs ${t.missingProviderIds.join(', ')}`
          : '';
        setNotice({
          tone: 'success',
          text: t
            ? `${t.title}: ${t.action} (${String(t.structureProvider ?? 'unknown').toUpperCase()}/${t.authorityReason ?? 'unknown'}${missing}; stale ${t.stale}, fresh ${t.fresh})${remap}`
            : `Nothing to reconcile (another structure repair may be running).`,
        });
      })
      .catch((e) =>
        setNotice({ tone: 'error', text: `Structure reconcile failed: ${errorText(e)}` }),
      )
      .finally(() => setBusy(null));
  };

  const runMediaCanonicalization = (mode: 'dry-run' | 'repair', targeted = false) => {
    const mediaId = canonicalMediaId.trim();
    if (targeted && !mediaId) return;
    if (
      mode === 'repair' &&
      !window.confirm(
        'Copy and verify user data into the canonical show, then hide/redirect each proven source only after the verification gate passes?',
      )
    )
      return;
    setBusy('canonical');
    setCanonicalResult(null);
    const count = Math.max(1, Number(canonicalCount) || 25);
    const query = targeted
      ? `mode=${mode}&mediaId=${encodeURIComponent(mediaId)}`
      : `mode=${mode}&count=${count}${
          mode === 'dry-run' && canonicalDryRunCursor
            ? `&cursor=${encodeURIComponent(canonicalDryRunCursor)}`
            : ''
        }`;
    api
      .post(`/admin/media-canonicalization/run?${query}`)
      .then((r) => {
        setCanonicalResult(
          r.data?.message ?? `Canonicalization (${mode}) started. Watch Repair progress above.`,
        );
        if (r.data?.started !== false) {
          setRepairs((previous) => ({
            ...previous,
            'media-canonicalization': {
              running: true,
              processed: 0,
              total: targeted ? 1 : count,
              succeeded: 0,
              failed: 0,
              candidates: 0,
              activated: 0,
              blocked: 0,
              current: targeted ? mediaId : `Preparing ${mode} batch`,
            },
          }));
        }
      })
      .catch((e) => setCanonicalResult(`Canonicalization failed: ${errorText(e)}`))
      .finally(() => setBusy(null));
  };

  if (!canView) return <p className="p-6 text-sm text-zinc-500">Admins only.</p>;

  const pct = (n: number) => (stats && stats.total > 0 ? Math.round((n / stats.total) * 100) : 0);
  const deepStats = stats?.nonEnglishContentDeep;
  const deepCursorPct =
    deepStats && deepStats.totalEligible > 0
      ? Math.min(100, Math.round((deepStats.cursorPosition / deepStats.totalEligible) * 100))
      : 0;
  const enContentLoaded = stats?.nonEnglishContent != null;
  const canonicalBusy = busy === 'canonical' || repairs['media-canonicalization']?.running === true;
  const noticeStyle: Record<Notice['tone'], string> = {
    info: 'border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-200',
    success:
      'border-green-200 bg-green-50 text-green-800 dark:border-green-800 dark:bg-green-950 dark:text-green-200',
    error:
      'border-red-200 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200',
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Metadata Health</h1>
          <p className="text-xs text-zinc-500">
            Repairs run automatically as{' '}
            <Link href="/cron" className="text-blue-600 hover:underline">
              Scheduled Jobs
            </Link>
            ; each card names the job that fixes it.
          </p>
        </div>
        <button onClick={() => load(true)} className="text-sm text-blue-600 hover:underline">
          Refresh numbers
        </button>
      </div>

      {/* Identity defects first: they corrupt users' libraries; content quality follows. */}
      <IdentityPanel />

      {healthNotice && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-200">
          {healthNotice}
        </div>
      )}
      {healthError && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
          Metadata health failed to load: {healthError}{' '}
          <button onClick={() => load(true)} className="underline">
            Retry
          </button>
        </div>
      )}
      {notice && (
        <div className={`rounded-lg border p-3 text-sm ${noticeStyle[notice.tone]}`}>
          {notice.text}
        </div>
      )}

      {/* Live repair progress (polls every 3s; finished jobs stay visible ~60s) */}
      {Object.keys(repairs).length > 0 && (
        <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-700">
          <h2 className="mb-3 font-medium">Repair progress</h2>
          <div className="space-y-3">
            {Object.entries(repairs).map(([job, p]) => {
              const pctDone =
                p.total > 0 ? Math.min(100, Math.round((p.processed / p.total) * 100)) : 0;
              const canonicalCounts =
                job === 'media-canonicalization'
                  ? ` · ${p.candidates ?? 0} candidates / ${p.activated ?? 0} activated / ${p.blocked ?? 0} blocked`
                  : '';
              return (
                <div key={job}>
                  <div className="flex items-center justify-between gap-2 text-sm">
                    <span className="font-medium">
                      {REPAIR_LABELS[job] ?? job}
                      {p.stalled ? (
                        <span className="ml-2 text-xs font-normal text-red-600 dark:text-red-400">
                          stalled — no progress for 30+ min (hung run); safe to re-run
                        </span>
                      ) : (
                        !p.running && (
                          <span className="ml-2 text-xs font-normal text-green-600 dark:text-green-400">
                            done
                          </span>
                        )
                      )}
                    </span>
                    <span className="shrink-0 text-xs text-zinc-400">
                      {p.processed}/{p.total} · {p.succeeded} ok / {p.failed} fail
                      {canonicalCounts}
                      {job === 'structure-reconcile' && (
                        <>
                          {' '}
                          · {p.remapped ?? 0} mapped / {p.legacyQuarantined ?? 0} legacy /{' '}
                          {p.episodesRemoved ?? 0} removed / {p.transferred ?? 0} data moved
                        </>
                      )}
                    </span>
                  </div>
                  <div className="mt-1 h-2 w-full overflow-hidden rounded bg-zinc-200 dark:bg-zinc-700">
                    <div
                      className={`h-2 rounded transition-all ${p.stalled ? 'bg-red-600' : p.running ? 'bg-blue-600' : 'bg-green-600'}`}
                      style={{ width: `${p.total > 0 ? pctDone : p.running ? 5 : 100}%` }}
                    />
                  </div>
                  {p.running && p.current && (
                    <p className="mt-0.5 truncate text-xs text-zinc-400">{p.current}</p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {loading && !stats ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : stats ? (
        <>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
            <MetricCard label="Total Media" value={stats.total} hint={STAT_HINTS.total} />
            <MetricCard
              label="Never Hydrated"
              value={stats.neverHydrated}
              sub={`${pct(stats.neverHydrated)}% of total · hydrate on first view`}
              hint={STAT_HINTS.neverHydrated}
            />
            <MetricCard
              label="Movies Missing Overview"
              value={stats.moviesMissingOverview}
              sub={`${pct(stats.moviesMissingOverview)}% of total`}
              hint={STAT_HINTS.moviesMissingOverview}
            />
            <MetricCard
              label="Mixed Episode Graphs"
              value={stats.dualStructureShows ?? 0}
              sub="active episodes from both TMDB and TVDB"
              hint={STAT_HINTS.dualStructureShows}
              job={JOBS.identity}
              highlight={(stats.dualStructureShows ?? 0) > 0}
            />
            <MetricCard
              label="Anime on TMDB Episodes"
              value={stats.animeOnTmdb}
              sub={`${stats.animeOnTmdbNoTvdbId} missing a TVDB id · ${stats.animeOnTmdbDuplicates ?? 0} duplicates (backlog) · ${stats.animeTvdbUnresolvable} parked`}
              hint={STAT_HINTS.animeOnTmdb}
              job={JOBS.identity}
              highlight={stats.animeOnTmdb > 0}
            />
            <MetricCard
              label="Cast Missing Character IDs"
              value={stats.castMissingCharacterIds}
              sub={`${stats.pendingCharacterVoteItems.toLocaleString()} pending imported votes · ${stats.pendingCharacterVoteShows.toLocaleString()} shows · ${stats.pendingCharacterVoteMovies.toLocaleString()} movies · ${stats.pendingCharacterVoteShowsWithoutTvdb.toLocaleString()} shows without TVDB id`}
              hint={STAT_HINTS.castMissingCharacterIds}
              job={JOBS.completeness}
              highlight={stats.castMissingCharacterIds > 0}
            />
            <MetricCard
              label="Duplicate Cast"
              value={stats.castDuplicateMedia ?? 0}
              sub={`titles to scan · ${stats.castDuplicateRows ?? 0} excess rows · ${stats.castDuplicateVotes ?? 0} votes on duplicate rows`}
              hint={STAT_HINTS.castDuplicates}
              job={JOBS.completeness}
            />
            <MetricCard
              label="Rating Supplement Due"
              value={stats.missingRating}
              sub="missing or stale TMDB community rating"
              hint={STAT_HINTS.missingRating}
              job={JOBS.completeness}
            />
            <MetricCard
              label="Missing Recommendations"
              value={stats.recommendationsMissing}
              hint={STAT_HINTS.recommendationsMissing}
              job={JOBS.completeness}
            />
            <MetricCard
              label="Movies Missing Country"
              value={stats.moviesMissingCountry}
              hint={STAT_HINTS.moviesMissingCountry}
              job={JOBS.completeness}
            />
            <MetricCard
              label="Non-English Base"
              value={stats.nonEnglishBase}
              sub="rows missing a trusted English base"
              hint={STAT_HINTS.nonEnglishBase}
              job={JOBS.english}
            />
            <MetricCard
              label="Non-English Content (suspected)"
              value={stats.nonEnglishContent == null ? 'Not loaded' : stats.nonEnglishContent}
              sub={
                stats.nonEnglishContent == null
                  ? 'expensive scan skipped on page load'
                  : `${enContentDeep ? 'media + episode text' : 'media titles/overviews'}${(stats.nonEnglishContentParked ?? 0) > 0 ? ` · ${stats.nonEnglishContentParked?.toLocaleString()} parked` : ''}`
              }
              hint={STAT_HINTS.nonEnglishContent}
              job={JOBS.english}
              action={
                <div className="flex flex-wrap items-center gap-2">
                  {!enContentLoaded && !enContentDeep && (
                    <button onClick={() => setEnContentStats(true)} className={btn}>
                      Load count
                    </button>
                  )}
                  <label className="flex items-center gap-1 text-xs text-zinc-500 dark:text-zinc-400">
                    <input
                      type="checkbox"
                      checked={enContentDeep}
                      onChange={(e) => setEnContentDeep(e.target.checked)}
                    />
                    deep scan (all rows)
                  </label>
                  {enContentDeep && (
                    <>
                      <input
                        type="number"
                        min={1}
                        value={enContentCount}
                        onChange={(e) => setEnContentCount(e.target.value)}
                        className={`w-20 ${input}`}
                        title="Rows per run"
                      />
                      <button
                        onClick={() =>
                          start(
                            'en-deep',
                            `/admin/repair-english-content/run?count=${Math.max(1, Number(enContentCount) || 500)}&deep=1`,
                            'Deep English verify started. Watch Repair progress above.',
                          )
                        }
                        disabled={busy === 'en-deep'}
                        className={btn}
                      >
                        Run deep verify
                      </button>
                    </>
                  )}
                  {enContentDeep && deepStats && (
                    <div className="basis-full rounded border border-rose-200 bg-white/70 p-2 text-xs text-zinc-600 dark:border-rose-800 dark:bg-zinc-900/60 dark:text-zinc-300">
                      Deep backlog: {deepStats.unverified.toLocaleString()} unverified of{' '}
                      {deepStats.totalEligible.toLocaleString()} · next run{' '}
                      {deepStats.remainingInPass.toLocaleString()} left in this pass · cursor{' '}
                      {deepCursorPct}%{deepStats.cursorActive ? '' : ' (starts at beginning)'}
                    </div>
                  )}
                </div>
              }
            />
            <MetricCard
              label="Banner as Poster"
              value={stats.bannerAsPoster}
              sub="wide banner or malformed TVDB poster URL"
              hint={STAT_HINTS.bannerAsPoster}
              highlight={stats.bannerAsPoster > 0}
              action={
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    value={bannerCount}
                    onChange={(e) => setBannerCount(e.target.value)}
                    className={`w-20 ${input}`}
                    title="Rows per run"
                  />
                  <button
                    onClick={() =>
                      start(
                        'banner',
                        `/admin/repair-banner-posters/run?count=${Math.max(1, Number(bannerCount) || 500)}`,
                        'Banner-poster repair started. Watch Repair progress above.',
                      )
                    }
                    disabled={busy === 'banner'}
                    className={btn}
                  >
                    Fix banner posters
                  </button>
                </div>
              }
            />
            <MetricCard
              label="Cross-Media Canonicalization"
              value={(canonicalStats.scanRemaining ?? canonicalStats.scanEligible).toLocaleString()}
              sub={
                canonicalStats.scanPassComplete
                  ? `repair pass complete · ${canonicalStats.scanEligible.toLocaleString()} eligible · ${canonicalStats.active.toLocaleString()} active`
                  : `${canonicalStats.scanProcessed.toLocaleString()}/${canonicalStats.scanEligible.toLocaleString()} scanned this pass · ${canonicalStats.active.toLocaleString()} active · ${canonicalStats.copying.toLocaleString()} copying · ${canonicalStats.failed.toLocaleString()} failed`
              }
              hint={STAT_HINTS.mediaCanonicalization}
              highlight={canonicalStats.copying + canonicalStats.failed > 0}
              action={
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    value={canonicalCount}
                    onChange={(e) => setCanonicalCount(e.target.value)}
                    className={`w-20 ${input}`}
                    title="TVDB aggregate titles per run"
                  />
                  <button
                    onClick={() => runMediaCanonicalization('dry-run')}
                    disabled={canonicalBusy}
                    className={btnMuted}
                  >
                    Dry-run
                  </button>
                  <button
                    onClick={() => runMediaCanonicalization('repair')}
                    disabled={canonicalBusy}
                    className={btn}
                  >
                    {canonicalBusy
                      ? 'Running…'
                      : canonicalStats.scanPassComplete
                        ? 'Start new repair pass'
                        : 'Copy, verify & activate'}
                  </button>
                </div>
              }
            />
          </div>

          {/* Per-title tools: inspection and targeted repairs the jobs cannot decide alone. */}
          <div className="space-y-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-700">
            <h2 className="font-medium">Per-title tools</h2>
            <ToolRow label="Structure reconcile">
              <input
                value={reconMediaId}
                onChange={(e) => setReconMediaId(e.target.value)}
                placeholder="mediaId"
                className={`w-72 ${input}`}
              />
              <button
                onClick={() => runStructureReconcile('dry-run')}
                disabled={!!busy?.startsWith('recon') || !reconMediaId.trim()}
                className={btnMuted}
              >
                {busy === 'recon-dry-run' ? 'Checking…' : 'Dry-run'}
              </button>
              <button
                onClick={() => runStructureReconcile('repair')}
                disabled={!!busy?.startsWith('recon') || !reconMediaId.trim()}
                className={btnDanger}
              >
                {busy === 'recon-repair' ? 'Repairing…' : 'Repair this title'}
              </button>
            </ToolRow>
            <ToolRow label="Duplicate cast review">
              <input
                value={dedupInspectId}
                onChange={(e) => setDedupInspectId(e.target.value)}
                placeholder="mediaId"
                className={`w-72 ${input}`}
              />
              <button
                onClick={inspectCastDedup}
                disabled={busy === 'dedup-inspect' || !dedupInspectId.trim()}
                className={btnMuted}
              >
                {busy === 'dedup-inspect' ? 'Inspecting…' : 'Inspect name-only pairs'}
              </button>
            </ToolRow>
            <ToolRow label="Canonicalization">
              <input
                value={canonicalMediaId}
                onChange={(e) => setCanonicalMediaId(e.target.value)}
                placeholder="TVDB aggregate mediaId"
                className={`w-72 ${input}`}
              />
              <button
                onClick={() => runMediaCanonicalization('dry-run', true)}
                disabled={canonicalBusy || !canonicalMediaId.trim()}
                className={btnMuted}
              >
                Dry-run
              </button>
              <button
                onClick={() => runMediaCanonicalization('repair', true)}
                disabled={canonicalBusy || !canonicalMediaId.trim()}
                className={btn}
              >
                Repair this title
              </button>
            </ToolRow>
            {canonicalResult ? <p className="text-xs text-zinc-500">{canonicalResult}</p> : null}
            <ToolRow label="TMDB changes (custom range)">
              <input
                type="date"
                value={syncStart}
                onChange={(e) => setSyncStart(e.target.value)}
                className={input}
              />
              <button
                onClick={() =>
                  start(
                    'tmdb-sync',
                    `/admin/tmdb-changes/run?start=${syncStart}`,
                    `TMDB changes replay from ${syncStart} started. The daily job's cursor is untouched.`,
                  )
                }
                disabled={!syncStart || busy === 'tmdb-sync'}
                className={btnMuted}
              >
                Replay changes since this date
              </button>
            </ToolRow>
            <ToolRow label="Hydrate stubs">
              <input
                type="number"
                value={batchCount}
                onChange={(e) => setBatchCount(e.target.value)}
                className={`w-20 ${input}`}
                title="Titles"
              />
              <button
                onClick={() =>
                  start(
                    'backfill',
                    `/admin/metadata-backfill/run?count=${Math.max(1, Number(batchCount) || 200)}`,
                    'Hydration of never-hydrated rows started in the background.',
                  )
                }
                disabled={busy === 'backfill'}
                className={btnMuted}
              >
                Hydrate a batch
              </button>
            </ToolRow>
          </div>

          {/* Manual cast-merge review (name-only duplicate pairs of one inspected title) */}
          {dedupReview && (dedupReview.review ?? []).length > 0 && (
            <div className="rounded-lg border border-violet-200 p-4 dark:border-violet-800">
              <h2 className="mb-1 font-medium">Cast duplicates — manual review</h2>
              <p className="mb-3 text-xs text-zinc-500">
                Name-only matches are never auto-merged. Pick which row survives; votes on the other
                row are re-pointed before it is deleted.
              </p>
              {dedupReview.review.map((g) => (
                <div
                  key={g.mediaId}
                  className="mb-3 rounded border border-zinc-200 p-3 dark:border-zinc-700"
                >
                  <p className="mb-2 text-sm font-medium">{g.title}</p>
                  <div className="space-y-1">
                    {g.rows.map((r) => (
                      <div key={r.id} className="flex items-center justify-between gap-2 text-sm">
                        <span>
                          {r.member} — {r.character ?? '(no character)'}
                          <span className="ml-2 text-xs text-zinc-400">{r.votes} vote(s)</span>
                        </span>
                        <button
                          onClick={() =>
                            mergeCastPair(
                              g.mediaId,
                              r.id,
                              g.rows.find((o) => o.id !== r.id)?.id ?? r.id,
                            )
                          }
                          disabled={busy === 'dedup-merge' || g.rows.length !== 2}
                          className="shrink-0 rounded border border-violet-600 px-2 py-1 text-xs font-medium text-violet-600 hover:bg-violet-50 disabled:opacity-50 dark:hover:bg-violet-950"
                        >
                          Keep this row
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-700">
            <h2 className="mb-3 font-medium">Content Classification</h2>
            <div className="flex flex-wrap gap-3">
              {Object.entries(stats.byClassification).map(([key, count]) => {
                const meta = CLASSIFICATION_LABELS[key] ?? { label: key, color: 'default' };
                return (
                  <div key={key} className="flex items-center gap-2">
                    <Badge color={meta.color as any}>{meta.label}</Badge>
                    <span className="font-mono text-sm">{count}</span>
                    <span className="text-xs text-zinc-400">({pct(count)}%)</span>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

function ToolRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="w-48 shrink-0 text-xs text-zinc-500">{label}</span>
      {children}
    </div>
  );
}

function MetricCard({
  label,
  value,
  sub,
  hint,
  job,
  highlight,
  action,
}: {
  label: string;
  value: number | string;
  sub?: string;
  hint?: string;
  /** The Scheduled Job that keeps this number converged. */
  job?: string;
  highlight?: boolean;
  action?: React.ReactNode;
}) {
  return (
    <div
      className={`rounded-lg border p-4 ${highlight ? 'border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950' : 'border-zinc-200 dark:border-zinc-700'}`}
    >
      <p className="text-xs uppercase tracking-wide text-zinc-400">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value.toLocaleString()}</p>
      {sub && <p className="mt-0.5 text-xs text-zinc-400">{sub}</p>}
      {job && <p className="mt-1 text-xs text-green-700 dark:text-green-400">Automatic · {job}</p>}
      {hint && (
        <p className="mt-2 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">{hint}</p>
      )}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}
