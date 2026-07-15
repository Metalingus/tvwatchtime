'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Badge } from '@/components/ui';

interface MetadataHealth {
  total: number;
  neverHydrated: number;
  showsMissingEpisodes: number;
  moviesMissingOverview: number;
  tvdbOnly: number;
  stale: number;
  byClassification: Record<string, number>;
}

const CLASSIFICATION_LABELS: Record<string, { label: string; color: string }> = {
  GENERAL: { label: 'General', color: 'default' },
  ANIME: { label: 'Anime', color: 'info' },
  MANGA: { label: 'Manga', color: 'warning' },
  UNKNOWN: { label: 'Unclassified', color: 'default' },
};

export default function MetadataHealthPage() {
  const { user } = useAuth();
  const [stats, setStats] = useState<MetadataHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [backfilling, setBackfilling] = useState(false);
  const [backfillResult, setBackfillResult] = useState<string | null>(null);

  const canView = user?.role && ['ADMIN', 'SUPER_ADMIN'].includes(user.role);

  const load = () => {
    setLoading(true);
    api
      .get('/admin/metadata-health')
      .then((r) => setStats(r.data))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (canView) load();
  }, [canView]);

  const runBackfill = () => {
    setBackfilling(true);
    setBackfillResult(null);
    api
      .post('/admin/metadata-backfill/run')
      .then((r) => {
        const d = r.data;
        setBackfillResult(`Processed ${d.processed}: ${d.succeeded} succeeded, ${d.failed} failed.${d.sample?.length ? ' Sample: ' + d.sample.join(', ') : ''}`);
        load(); // refresh stats
      })
      .catch(() => setBackfillResult('Backfill failed.'))
      .finally(() => setBackfilling(false));
  };

  if (!canView) return <p className="p-6 text-sm text-zinc-500">Admins only.</p>;

  const pct = (n: number) => (stats && stats.total > 0 ? Math.round((n / stats.total) * 100) : 0);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Metadata Health</h1>
        <div className="flex gap-3">
          <button onClick={load} className="text-sm text-blue-600 hover:underline">
            Refresh
          </button>
          <button
            onClick={runBackfill}
            disabled={backfilling}
            className="rounded bg-blue-600 px-3 py-1 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {backfilling ? 'Running…' : 'Run Backfill (batch of 20)'}
          </button>
        </div>
      </div>

      {backfillResult && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-200">
          {backfillResult}
        </div>
      )}

      {loading || !stats ? (
        <p className="text-sm text-zinc-500">Loading…</p>
      ) : (
        <>
          {/* Health metrics */}
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
            <MetricCard label="Total Media" value={stats.total} />
            <MetricCard label="Never Hydrated" value={stats.neverHydrated} sub={`${pct(stats.neverHydrated)}% of total`} highlight={stats.neverHydrated > 0} />
            <MetricCard label="Shows Missing Episodes" value={stats.showsMissingEpisodes} sub={`${pct(stats.showsMissingEpisodes)}% of total`} highlight={stats.showsMissingEpisodes > 0} />
            <MetricCard label="Movies Missing Overview" value={stats.moviesMissingOverview} sub={`${pct(stats.moviesMissingOverview)}% of total`} highlight={stats.moviesMissingOverview > 0} />
            <MetricCard label="TVDB-Only (no TMDB)" value={stats.tvdbOnly} sub={`${pct(stats.tvdbOnly)}% of total`} />
            <MetricCard label="Stale (30+ days)" value={stats.stale} sub={`${pct(stats.stale)}% of total`} highlight={stats.stale > 0} />
          </div>

          {/* Classification breakdown */}
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

          <p className="text-xs text-zinc-400">
            Backfill processes 20 items per run (oldest/never-hydrated first). It hydrates from TMDB (or TVDB for
            TVDB-only media), respects global rate limits, and enqueues anime classification (Kitsu &gt; Jikan &gt; TVDB
            &gt; TMDB). Watch history is never affected.
          </p>
        </>
      )}
    </div>
  );
}

function MetricCard({ label, value, sub, highlight }: { label: string; value: number; sub?: string; highlight?: boolean }) {
  return (
    <div className={`rounded-lg border p-4 ${highlight ? 'border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950' : 'border-zinc-200 dark:border-zinc-700'}`}>
      <p className="text-xs uppercase tracking-wide text-zinc-400">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value.toLocaleString()}</p>
      {sub && <p className="mt-0.5 text-xs text-zinc-400">{sub}</p>}
    </div>
  );
}
