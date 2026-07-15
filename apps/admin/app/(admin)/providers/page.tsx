'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Badge } from '@/components/ui';

interface ProviderStatus {
  tag: string;
  enabled: boolean;
  baseUrl?: string | null;
  rps: number;
  rpm: number;
  concurrency: number;
  timeoutMs: number;
  maxRetries: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  cacheTtlSec: number;
  negativeCacheTtlSec: number;
  circuitOpen: boolean;
  metrics: Record<string, string>;
}

const LABELS: Record<string, string> = {
  tmdb: 'TMDB',
  tvdb: 'TVDB v4',
  kitsu: 'Kitsu',
  jikan: 'Jikan / MyAnimeList',
};

export default function ProvidersPage() {
  const { user } = useAuth();
  const [rows, setRows] = useState<ProviderStatus[]>([]);
  const [loading, setLoading] = useState(true);

  const canView = user?.role && ['ADMIN', 'SUPER_ADMIN'].includes(user.role);

  const load = () => {
    setLoading(true);
    api
      .get('/admin/providers')
      .then((r) => setRows(r.data))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    if (canView) load();
  }, [canView]);

  if (!canView) return <p className="p-6 text-sm text-zinc-500">Admins only.</p>;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Metadata Providers</h1>
        <button onClick={load} className="text-sm text-blue-600 hover:underline">
          Refresh
        </button>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {loading ? (
          <p className="text-sm text-zinc-500">Loading…</p>
        ) : (
          rows.map((p) => (
            <div key={p.tag} className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-700">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="font-medium">{LABELS[p.tag] ?? p.tag}</h2>
                <div className="flex gap-2">
                  <Badge color={p.enabled ? 'success' : 'default'}>
                    {p.enabled ? 'enabled' : 'disabled'}
                  </Badge>
                  <Badge color={p.circuitOpen ? 'danger' : 'success'}>
                    {p.circuitOpen ? 'circuit open' : 'circuit closed'}
                  </Badge>
                </div>
              </div>

              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-zinc-600 dark:text-zinc-300">
                <dt>Base URL</dt>
                <dd className="truncate">{p.baseUrl ?? '—'}</dd>
                <dt>Limits</dt>
                <dd>
                  {p.rps}/s · {p.rpm}/m · conc {p.concurrency || '∞'}
                </dd>
                <dt>Timeout / retries</dt>
                <dd>
                  {p.timeoutMs}ms · {p.maxRetries}
                </dd>
                <dt>Backoff</dt>
                <dd>
                  {p.backoffBaseMs}–{p.backoffMaxMs}ms
                </dd>
                <dt>Cache TTL</dt>
                <dd>
                  +{p.cacheTtlSec}s / −{p.negativeCacheTtlSec}s
                </dd>
              </dl>

              <div className="mt-3 border-t border-zinc-100 pt-3 dark:border-zinc-800">
                <p className="mb-1 text-[11px] uppercase tracking-wide text-zinc-400">Today&apos;s metrics</p>
                <div className="flex flex-wrap gap-2 text-[11px]">
                  <Metric label="requests" value={p.metrics.requests} />
                  <Metric label="cacheHits" value={p.metrics.cacheHits} />
                  <Metric label="retries" value={p.metrics.retries} />
                  <Metric label="failures" value={p.metrics.failures} />
                  <Metric label="429" value={p.metrics.r429} />
                  <Metric
                    label="avg ms"
                    value={
                      p.metrics.latCount && Number(p.metrics.latCount) > 0
                        ? String(Math.round(Number(p.metrics.latSum) / Number(p.metrics.latCount)))
                        : undefined
                    }
                  />
                </div>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value?: string }) {
  if (value === undefined) return null;
  return (
    <span className="rounded bg-zinc-100 px-1.5 py-0.5 dark:bg-zinc-800">
      <span className="text-zinc-400">{label}</span> <span className="font-mono">{value}</span>
    </span>
  );
}
