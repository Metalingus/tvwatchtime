'use client';

import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import { Badge, Table, Pagination } from '@/components/ui';
import { useAuth } from '@/lib/auth';

const HYDRATION_TYPES = [
  { type: 'trending_shows', label: 'Trending Shows', icon: '🔥' },
  { type: 'trending_movies', label: 'Trending Movies', icon: '🔥' },
  { type: 'popular_shows', label: 'Popular Shows', icon: '📈' },
  { type: 'popular_movies', label: 'Popular Movies', icon: '📈' },
  { type: 'top_rated_shows', label: 'Top Rated Shows', icon: '⭐' },
  { type: 'top_rated_movies', label: 'Top Rated Movies', icon: '⭐' },
  { type: 'upcoming_movies', label: 'Upcoming Movies', icon: '🗓️' },
  { type: 'now_playing_movies', label: 'Now Playing', icon: '🎬' },
  { type: 'airing_today', label: 'Airing Today', icon: '📡' },
  { type: 'on_the_air', label: 'On The Air', icon: '📺' },
];

const SCHEDULE_PRESETS = [
  { label: 'Every 6 hours', value: '0 */6 * * *' },
  { label: 'Every 12 hours', value: '0 */12 * * *' },
  { label: 'Daily at 3 AM', value: '0 3 * * *' },
  { label: 'Daily at 6 AM', value: '0 6 * * *' },
  { label: 'Every Monday 3 AM', value: '0 3 * * 1' },
  { label: 'Every Monday + Thursday 3 AM', value: '0 3 * * 1,4' },
];

export default function ScheduledHydrationsPage() {
  const { user } = useAuth();
  const [items, setItems] = useState<any[]>([]);
  const [creating, setCreating] = useState(false);
  const [newType, setNewType] = useState(HYDRATION_TYPES[0].type);
  const [newSchedule, setNewSchedule] = useState('0 3 * * *');
  const [newPages, setNewPages] = useState(1);
  const [triggering, setTriggering] = useState<string | null>(null);

  const canEdit = user?.role && ['ADMIN', 'SUPER_ADMIN'].includes(user.role);
  const canTrigger = user?.role && ['CONTENT_MANAGER', 'MODERATOR', 'ADMIN', 'SUPER_ADMIN'].includes(user.role);

  const load = () => api.get('/admin/scheduled-hydrations').then((r) => setItems(r.data));
  useEffect(() => { load(); }, []);

  const toggle = async (id: string, enabled: boolean) => {
    await api.patch(`/admin/scheduled-hydrations/${id}`, { enabled: !enabled });
    load();
  };

  const updateSchedule = async (id: string, schedule: string) => {
    await api.patch(`/admin/scheduled-hydrations/${id}`, { schedule });
    load();
  };

  const updatePages = async (id: string, pages: number) => {
    await api.patch(`/admin/scheduled-hydrations/${id}`, { pages });
    load();
  };

  const create = async () => {
    const typeDef = HYDRATION_TYPES.find((t) => t.type === newType);
    await api.post('/admin/scheduled-hydrations', { type: newType, label: typeDef?.label || newType, schedule: newSchedule, pages: newPages, enabled: true });
    setCreating(false);
    load();
  };

  const remove = async (id: string) => {
    await api.delete(`/admin/scheduled-hydrations/${id}`);
    load();
  };

  const trigger = async (id: string) => {
    setTriggering(id);
    try { await api.post(`/admin/scheduled-hydrations/${id}/trigger`); } finally { setTriggering(null); }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Scheduled Hydrations</h1>
          <div className="text-sm text-white/40 mt-1">Automatically fill your database from TMDb on a schedule</div>
        </div>
        {canEdit ? (
          <button onClick={() => setCreating(!creating)} className="px-4 py-2 bg-accent text-bg font-bold rounded-lg text-sm">
            {creating ? 'Cancel' : '+ Add Schedule'}
          </button>
        ) : null}
      </div>

      {/* Create form */}
      {creating ? (
        <div className="bg-surface rounded-xl p-5 border border-border space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-white/40 uppercase">Hydration Type</label>
              <select value={newType} onChange={(e) => setNewType(e.target.value)} className="w-full mt-1 px-3 py-2 bg-surface-alt rounded-lg border border-border text-white text-sm">
                {HYDRATION_TYPES.map((t) => <option key={t.type} value={t.type}>{t.icon} {t.label}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-white/40 uppercase">Pages (20 items each)</label>
              <select value={newPages} onChange={(e) => setNewPages(Number(e.target.value))} className="w-full mt-1 px-3 py-2 bg-surface-alt rounded-lg border border-border text-white text-sm">
                {[1, 2, 3, 5, 10].map((n) => <option key={n} value={n}>{n} ({n * 20} items)</option>)}
              </select>
            </div>
            <div className="col-span-2">
              <label className="text-xs text-white/40 uppercase">Schedule</label>
              <div className="flex gap-2 mt-1">
                <select onChange={(e) => setNewSchedule(e.target.value)} value="" className="px-3 py-2 bg-surface-alt rounded-lg border border-border text-white text-sm">
                  <option value="" disabled>Presets...</option>
                  {SCHEDULE_PRESETS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                </select>
                <input type="text" value={newSchedule} onChange={(e) => setNewSchedule(e.target.value)} className="flex-1 px-3 py-2 bg-surface-alt rounded-lg border border-border text-white text-sm font-mono" />
              </div>
            </div>
          </div>
          <button onClick={create} className="px-4 py-2 bg-success text-white font-bold rounded-lg text-sm">Create & Enable</button>
        </div>
      ) : null}

      {/* Existing schedules */}
      {items.length === 0 && !creating ? (
        <div className="bg-surface rounded-xl p-8 border border-border text-center">
          <div className="text-white/40 text-sm">No scheduled hydrations yet. Click "Add Schedule" to automatically fill your database on a recurring basis.</div>
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((item) => (
            <div key={item.id} className="bg-surface rounded-xl p-5 border border-border">
              <div className="flex items-center justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-3">
                    <span className="font-semibold">{item.label}</span>
                    {item.enabled ? <Badge color="success">Enabled</Badge> : <Badge>Disabled</Badge>}
                  </div>
                  <div className="flex gap-4 mt-2 text-xs text-white/40">
                    <span>⏱ <code className="text-accent">{item.schedule}</code></span>
                    <span>Pages: {item.pages} ({item.pages * 20} items)</span>
                    {item.lastRunAt ? <span>Last run: {new Date(item.lastRunAt).toLocaleString()}</span> : <span>Never run</span>}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {canTrigger ? (
                    <button onClick={() => trigger(item.id)} disabled={triggering === item.id} className="px-3 py-1.5 bg-surface-alt rounded-lg text-xs text-accent border border-border hover:border-accent disabled:opacity-50">
                      {triggering === item.id ? 'Running...' : 'Run Now'}
                    </button>
                  ) : null}
                  {canEdit ? (
                    <>
                      <button onClick={() => toggle(item.id, item.enabled)} className={`relative w-12 h-6 rounded-full transition ${item.enabled ? 'bg-accent' : 'bg-surface-alt'}`}>
                        <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${item.enabled ? 'left-6' : 'left-0.5'}`} />
                      </button>
                      <button onClick={() => remove(item.id)} className="text-danger text-xs hover:underline">Delete</button>
                    </>
                  ) : null}
                </div>
              </div>

              {/* Quick schedule edit */}
              {canEdit ? (
                <div className="flex items-center gap-2 mt-3 pt-3 border-t border-border/50">
                  <span className="text-xs text-white/30">Schedule:</span>
                  <select onChange={(e) => updateSchedule(item.id, e.target.value)} defaultValue="" className="px-2 py-1 bg-surface-alt rounded border border-border text-white text-xs">
                    <option value="" disabled>Change...</option>
                    {SCHEDULE_PRESETS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                  </select>
                  <span className="text-xs text-white/30">Pages:</span>
                  <select onChange={(e) => updatePages(item.id, Number(e.target.value))} defaultValue="" className="px-2 py-1 bg-surface-alt rounded border border-border text-white text-xs">
                    <option value="" disabled>Change...</option>
                    {[1, 2, 3, 5, 10].map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
