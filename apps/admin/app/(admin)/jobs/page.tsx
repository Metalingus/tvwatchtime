'use client';

import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import { Badge, Table, Pagination } from '@/components/ui';
import { useAuth } from '@/lib/auth';

const JOB_TYPES = [
  // Trending
  { type: 'trending_shows', label: 'Trending Shows', icon: '🔥', group: 'Trending' },
  { type: 'trending_movies', label: 'Trending Movies', icon: '🔥', group: 'Trending' },
  // Movies
  { type: 'popular_movies', label: 'Popular Movies', icon: '📈', group: 'Movies' },
  { type: 'top_rated_movies', label: 'Top Rated Movies', icon: '⭐', group: 'Movies' },
  { type: 'now_playing_movies', label: 'Now Playing', icon: '🎬', group: 'Movies' },
  { type: 'upcoming_movies', label: 'Upcoming Movies', icon: '🗓️', group: 'Movies' },
  // Shows
  { type: 'popular_shows', label: 'Popular Shows', icon: '📈', group: 'Shows' },
  { type: 'top_rated_shows', label: 'Top Rated Shows', icon: '⭐', group: 'Shows' },
  { type: 'airing_today', label: 'Airing Today', icon: '📡', group: 'Shows' },
  { type: 'on_the_air', label: 'On The Air', icon: '📺', group: 'Shows' },
  // Single
  { type: 'single_show', label: 'Specific Show (by TMDb ID)', icon: '🎬', group: 'Single' },
  { type: 'single_movie', label: 'Specific Movie (by TMDb ID)', icon: '🎥', group: 'Single' },
];

const STATUS_COLORS: Record<string, string> = {
  running: 'info', completed: 'success', failed: 'danger', queued: 'default', cancelled: 'warning',
};

export default function JobsPage() {
  const { user: me } = useAuth();
  const [data, setData] = useState<any>(null);
  const [page, setPage] = useState(1);
  const [triggering, setTriggering] = useState(false);
  const [tmdbId, setTmdbId] = useState('');
  const [pages, setPages] = useState(1);
  const [lastResult, setLastResult] = useState<any>(null);

  const load = () => api.get('/admin/jobs', { params: { page, pageSize: 20 } }).then((r) => setData(r.data));
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [page]);

  const canTrigger = me?.role && ['CONTENT_MANAGER', 'MODERATOR', 'ADMIN', 'SUPER_ADMIN'].includes(me.role);

  const trigger = async (type: string) => {
    setTriggering(true);
    try {
      const opts: any = { type, pages };
      if (type.startsWith('single_') && tmdbId) opts.tmdbId = Number(tmdbId);
      const res = await api.post('/admin/jobs/hydrate', opts);
      setLastResult(res.data);
      load();
    } catch (e: any) {
      setLastResult({ error: e?.response?.data?.message || 'Failed' });
    } finally {
      setTriggering(false);
    }
  };

  const cancelJob = async (jobId: string) => {
    try { await api.post(`/admin/jobs/${jobId}/cancel`); load(); } catch {}
  };
  const retryJob = async (jobId: string) => {
    try { await api.post(`/admin/jobs/${jobId}/retry`); load(); } catch {}
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Hydration Jobs</h1>

      {/* Trigger buttons */}
      {canTrigger ? (
        <div className="bg-surface rounded-xl p-5 border border-border">
          <div className="text-sm font-semibold text-white/70 mb-4">Trigger TMDB Hydration</div>
          {['Trending', 'Movies', 'Shows', 'Single'].map((group) => (
            <div key={group} className="mb-4">
              <div className="text-xs text-white/30 uppercase tracking-wide mb-2">{group}</div>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                {JOB_TYPES.filter((j) => j.group === group).map((j) => (
                  <button
                    key={j.type}
                    onClick={() => trigger(j.type)}
                    disabled={triggering}
                    className="flex items-center gap-2 px-4 py-3 bg-surface-alt rounded-lg border border-border hover:border-accent transition text-sm disabled:opacity-50"
                  >
                    <span>{j.icon}</span>
                    <span className="text-white/80">{j.label}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
          <div className="mt-3 flex gap-3 items-center">
            <input type="number" value={tmdbId} onChange={(e) => setTmdbId(e.target.value)} placeholder="TMDb ID (for single show/movie)" className="px-3 py-2 bg-surface-alt rounded-lg border border-border text-white text-sm w-64" />
            <div className="flex items-center gap-2">
              <label className="text-xs text-white/40 uppercase">Pages</label>
              <select value={pages} onChange={(e) => setPages(Number(e.target.value))} className="px-3 py-2 bg-surface-alt rounded-lg border border-border text-white text-sm">
                {[1, 2, 3, 5, 10].map((n) => <option key={n} value={n}>{n} ({n * 20} items)</option>)}
              </select>
            </div>
          </div>
          {lastResult ? (
            <div className={`mt-3 text-sm px-4 py-2 rounded-lg ${lastResult.error ? 'bg-danger/10 text-danger border border-danger/20' : 'bg-success/10 text-success border border-success/20'}`}>
              {lastResult.error || `Job started: ${lastResult.totalItems} items, ~${lastResult.estimatedApiCalls} API calls`}
            </div>
          ) : null}
        </div>
      ) : <div className="text-white/40 text-sm">You need Content Manager role or higher to trigger jobs.</div>}

      {/* Job history */}
      {data ? (
        <>
          <Table headers={['Type', 'Status', 'Progress', 'API Calls', 'Failed', 'Triggered', 'Completed', 'Actions']}>
            {data.items.map((j: any) => {
              const pct = j.totalItems > 0 ? Math.round((j.processedItems / j.totalItems) * 100) : 0;
              return (
                <tr key={j.id} className="border-b border-border/50">
                  <td className="px-4 py-3 text-sm font-medium">{j.type.replace(/_/g, ' ')}</td>
                  <td className="px-4 py-3"><Badge color={STATUS_COLORS[j.status] || 'default'}>{j.status}</Badge></td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="w-24 h-1.5 bg-surface-alt rounded-full overflow-hidden">
                        <div className={`h-full ${j.status === 'completed' ? 'bg-success' : j.status === 'failed' ? 'bg-danger' : 'bg-accent'}`} style={{ width: `${pct}%` }} />
                      </div>
                      <span className="text-xs text-white/40">{j.processedItems}/{j.totalItems}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-sm text-white/60">{j.tmdbApiCalls}</td>
                  <td className="px-4 py-3 text-sm">{j.failedItems > 0 ? <span className="text-danger">{j.failedItems}</span> : '—'}</td>
                  <td className="px-4 py-3 text-xs text-white/30">{new Date(j.createdAt).toLocaleString()}</td>
                  <td className="px-4 py-3 text-xs text-white/30">{j.completedAt ? new Date(j.completedAt).toLocaleString() : '—'}</td>
                  <td className="px-4 py-3">
                    {canTrigger ? (
                      <div className="flex gap-2">
                        {j.status === 'running' ? (
                          <button onClick={() => cancelJob(j.id)} className="text-xs text-danger hover:underline">Cancel</button>
                        ) : null}
                        {j.status === 'failed' && j.failedItems > 0 ? (
                          <button onClick={() => retryJob(j.id)} className="text-xs text-accent hover:underline">Retry</button>
                        ) : null}
                      </div>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </Table>
          <Pagination page={page} total={data.total} pageSize={20} onPage={setPage} />
        </>
      ) : <div className="text-white/40 text-center py-20">Loading...</div>}
    </div>
  );
}
