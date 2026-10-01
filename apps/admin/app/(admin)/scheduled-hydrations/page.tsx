'use client';

import { DEFAULT_UPCOMING_MOVIES_SCHEDULE } from '@tvwatch/shared';

import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import { Badge, Table, Pagination } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { SchedulePicker } from '@/components/SchedulePicker';

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
  { type: 'streaming_top', label: 'Streaming Top Charts', icon: '🏆' },
];

/** Daily official charts (Movie of the Night): options instead of pages. */
const STREAMING_TOP = 'streaming_top';

type StreamingConfig = {
  countries: string[];
  services: string[];
  monthlyBudget: number;
  reserve: number;
  watchforge: boolean;
  retentionDays: number;
};
type StreamingOptions = {
  countries: string[];
  services: { id: string; name: string }[];
  maxCountries: number;
};
type MonthlyQuota = {
  used: number;
  granted: number;
  remaining: number;
  resetAt: string | null;
} | null;

function StreamingChartsOptions({
  item,
  canEdit,
  quota,
  onSaved,
}: {
  item: { id: string; config: StreamingConfig; options: StreamingOptions };
  canEdit: boolean;
  quota: MonthlyQuota | undefined;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<StreamingConfig>(item.config);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setDraft(item.config), [item.config]);

  const projected = draft.services.length * draft.countries.length * 31;
  const usable = draft.monthlyBudget - draft.reserve;
  const dirty = JSON.stringify(draft) !== JSON.stringify(item.config);
  const toggle = (key: 'countries' | 'services', value: string) =>
    setDraft((d) => ({
      ...d,
      [key]: d[key].includes(value) ? d[key].filter((v) => v !== value) : [...d[key], value],
    }));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.patch(`/admin/scheduled-hydrations/${item.id}`, { config: draft });
      onSaved();
    } catch (e: any) {
      setError(e?.response?.data?.message ?? 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const chip = (active: boolean, disabled: boolean) =>
    `px-2 py-1 rounded border text-xs ${active ? 'border-accent text-accent' : 'border-border text-white/50'} ${disabled ? 'opacity-40 cursor-not-allowed' : 'hover:border-accent'}`;

  return (
    <div className="mt-3 pt-3 border-t border-border/50 space-y-3 text-xs">
      <div>
        <div className="text-white/30 mb-1">
          Countries (max {item.options.maxCountries}) — viewers get their app-language country, else
          US
        </div>
        <div className="flex flex-wrap gap-1.5">
          {item.options.countries.map((cc) => {
            const on = draft.countries.includes(cc);
            const disabled =
              !canEdit ||
              (on && draft.countries.length === 1) ||
              (!on && draft.countries.length >= item.options.maxCountries);
            return (
              <button
                key={cc}
                disabled={disabled}
                onClick={() => toggle('countries', cc)}
                className={chip(on, disabled)}
              >
                {cc}
              </button>
            );
          })}
        </div>
      </div>
      <div>
        <div className="text-white/30 mb-1">Services</div>
        <div className="flex flex-wrap gap-1.5">
          {item.options.services.map((svc) => {
            const on = draft.services.includes(svc.id);
            const disabled = !canEdit || (on && draft.services.length === 1);
            return (
              <button
                key={svc.id}
                disabled={disabled}
                onClick={() => toggle('services', svc.id)}
                className={chip(on, disabled)}
              >
                {svc.name}
              </button>
            );
          })}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-4">
        {(
          [
            ['monthlyBudget', 'Monthly budget'],
            ['reserve', 'Reserve'],
            ['retentionDays', 'History (days)'],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="flex items-center gap-2 text-white/40">
            {label}
            <input
              type="number"
              disabled={!canEdit}
              value={draft[key]}
              onChange={(e) => setDraft((d) => ({ ...d, [key]: Number(e.target.value) }))}
              className="w-20 px-2 py-1 bg-surface-alt rounded border border-border text-white"
            />
          </label>
        ))}
        <label className="flex items-center gap-2 text-white/40">
          <input
            type="checkbox"
            disabled={!canEdit}
            checked={draft.watchforge}
            onChange={(e) => setDraft((d) => ({ ...d, watchforge: e.target.checked }))}
          />
          WatchForge for unresolved series
        </label>
      </div>
      <div className={projected > usable ? 'text-danger' : 'text-white/40'}>
        ~{projected} requests/month ({draft.services.length} services × {draft.countries.length}{' '}
        countries × 31 days) of {usable} usable
        {quota
          ? ` · Quota: ${quota.used}/${quota.granted} used, ${quota.remaining} left${quota.resetAt ? `, resets ${new Date(quota.resetAt).toLocaleDateString()}` : ''}`
          : quota === null
            ? ' · Quota: not observed yet'
            : ''}
      </div>
      {error ? <div className="text-danger">{error}</div> : null}
      {canEdit && dirty ? (
        <div className="flex gap-2">
          <button
            onClick={save}
            disabled={saving || projected > usable}
            className="px-3 py-1.5 bg-accent text-bg font-bold rounded-lg disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save options'}
          </button>
          <button
            onClick={() => setDraft(item.config)}
            className="px-3 py-1.5 bg-surface-alt rounded-lg border border-border text-white/60"
          >
            Reset
          </button>
        </div>
      ) : null}
    </div>
  );
}

export default function ScheduledHydrationsPage() {
  const { user } = useAuth();
  const [items, setItems] = useState<any[]>([]);
  const [creating, setCreating] = useState(false);
  const [newType, setNewType] = useState(HYDRATION_TYPES[0].type);
  const [newPages, setNewPages] = useState(1);
  const [editing, setEditing] = useState<string | null>(null);
  const [triggering, setTriggering] = useState<string | null>(null);
  const [quota, setQuota] = useState<MonthlyQuota | undefined>(undefined);
  const [notice, setNotice] = useState<string | null>(null);

  const canEdit = user?.role && ['ADMIN', 'SUPER_ADMIN'].includes(user.role);
  const canTrigger =
    user?.role && ['CONTENT_MANAGER', 'MODERATOR', 'ADMIN', 'SUPER_ADMIN'].includes(user.role);

  const load = () => api.get('/admin/scheduled-hydrations').then((r) => setItems(r.data));
  useEffect(() => {
    load();
    api
      .get('/admin/providers')
      .then((r) => setQuota(r.data.find((p: any) => p.tag === 'motn')?.monthlyQuota ?? null))
      .catch(() => setQuota(undefined));
  }, []);
  const hasStreaming = items.some((i) => i.type === STREAMING_TOP);
  const creatableTypes = HYDRATION_TYPES.filter((t) => t.type !== STREAMING_TOP || !hasStreaming);

  const toggle = async (id: string, enabled: boolean) => {
    await api.patch(`/admin/scheduled-hydrations/${id}`, { enabled: !enabled });
    load();
  };

  const saveSchedule = async (id: string, schedule: string, timezone: string | null) => {
    await api.patch(`/admin/scheduled-hydrations/${id}`, { schedule, timezone });
    setEditing(null);
    load();
  };

  const updatePages = async (id: string, pages: number) => {
    await api.patch(`/admin/scheduled-hydrations/${id}`, { pages });
    load();
  };

  const create = async (schedule: string, timezone: string | null) => {
    const typeDef = HYDRATION_TYPES.find((t) => t.type === newType);
    await api.post('/admin/scheduled-hydrations', {
      type: newType,
      label: typeDef?.label || newType,
      schedule,
      timezone,
      pages: newPages,
      enabled: true,
    });
    setCreating(false);
    load();
  };

  const remove = async (id: string) => {
    await api.delete(`/admin/scheduled-hydrations/${id}`);
    load();
  };

  const trigger = async (id: string) => {
    setTriggering(id);
    setNotice(null);
    try {
      const res = await api.post(`/admin/scheduled-hydrations/${id}/trigger`);
      if (res.data?.status === 'running')
        setNotice('Streaming charts started — each chart appears on the Jobs page when done.');
    } catch (e: any) {
      setNotice(e?.response?.data?.message ?? 'Run failed');
    } finally {
      setTriggering(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Scheduled Hydrations</h1>
          <div className="text-sm text-white/40 mt-1">
            Automatically fill your database from TMDb on a schedule — each row runs on its own
            schedule & timezone. Run history is on the Jobs page.
          </div>
          {notice ? <div className="text-sm text-accent mt-2">{notice}</div> : null}
        </div>
        {canEdit ? (
          <button
            onClick={() => setCreating(!creating)}
            className="px-4 py-2 bg-accent text-bg font-bold rounded-lg text-sm"
          >
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
              <select
                value={newType}
                onChange={(e) => setNewType(e.target.value)}
                className="w-full mt-1 px-3 py-2 bg-surface-alt rounded-lg border border-border text-white text-sm"
              >
                {creatableTypes.map((t) => (
                  <option key={t.type} value={t.type}>
                    {t.icon} {t.label}
                  </option>
                ))}
              </select>
            </div>
            <div className={newType === STREAMING_TOP ? 'hidden' : ''}>
              <label className="text-xs text-white/40 uppercase">Pages (20 items each)</label>
              <select
                value={newPages}
                onChange={(e) => setNewPages(Number(e.target.value))}
                className="w-full mt-1 px-3 py-2 bg-surface-alt rounded-lg border border-border text-white text-sm"
              >
                {[1, 2, 3, 5, 10].map((n) => (
                  <option key={n} value={n}>
                    {n} ({n * 20} items)
                  </option>
                ))}
              </select>
            </div>
          </div>
          <SchedulePicker
            key={newType}
            schedule={
              newType === 'upcoming_movies'
                ? DEFAULT_UPCOMING_MOVIES_SCHEDULE
                : newType === STREAMING_TOP
                  ? '30 6 * * *'
                  : '0 3 * * *'
            }
            timezone={newType === 'upcoming_movies' || newType === STREAMING_TOP ? 'UTC' : ''}
            onSave={create}
          />
        </div>
      ) : null}

      {/* Existing schedules */}
      {items.length === 0 && !creating ? (
        <div className="bg-surface rounded-xl p-8 border border-border text-center">
          <div className="text-white/40 text-sm">
            No scheduled hydrations yet. Click "Add Schedule" to automatically fill your database on
            a recurring basis.
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((item) => (
            <div key={item.id} className="bg-surface rounded-xl p-5 border border-border">
              <div className="flex items-center justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-3">
                    <span className="font-semibold">{item.label}</span>
                    {item.enabled ? (
                      <Badge color="success">Enabled</Badge>
                    ) : (
                      <Badge>Disabled</Badge>
                    )}
                  </div>
                  <div className="flex gap-4 mt-2 text-xs text-white/40">
                    <span>
                      ⏱ <code className="text-accent">{item.schedule}</code>
                      {item.timezone ? ` · ${item.timezone}` : ''}
                    </span>
                    {item.type === STREAMING_TOP ? (
                      <span>
                        {item.config.services.length} services × {item.config.countries.join(', ')}
                      </span>
                    ) : (
                      <span>
                        Pages: {item.pages} ({item.pages * 20} items)
                      </span>
                    )}
                    {item.lastRunAt ? (
                      <span>
                        Last run:{' '}
                        {item.timezone
                          ? new Date(item.lastRunAt).toLocaleString(undefined, {
                              timeZone: item.timezone,
                            })
                          : new Date(item.lastRunAt).toLocaleString()}
                      </span>
                    ) : (
                      <span>Never run</span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {canTrigger ? (
                    <button
                      onClick={() => trigger(item.id)}
                      disabled={triggering === item.id}
                      className="px-3 py-1.5 bg-surface-alt rounded-lg text-xs text-accent border border-border hover:border-accent disabled:opacity-50"
                    >
                      {triggering === item.id ? 'Running...' : 'Run Now'}
                    </button>
                  ) : null}
                  {canEdit ? (
                    <>
                      <button
                        onClick={() => setEditing(editing === item.id ? null : item.id)}
                        className="px-3 py-1.5 bg-surface-alt rounded-lg text-xs text-white/60 border border-border hover:text-white"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => toggle(item.id, item.enabled)}
                        className={`relative w-12 h-6 rounded-full transition ${item.enabled ? 'bg-accent' : 'bg-surface-alt'}`}
                      >
                        <div
                          className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${item.enabled ? 'left-6' : 'left-0.5'}`}
                        />
                      </button>
                      <button
                        onClick={() => remove(item.id)}
                        className="text-danger text-xs hover:underline"
                      >
                        Delete
                      </button>
                    </>
                  ) : null}
                </div>
              </div>

              {canEdit && editing === item.id ? (
                <SchedulePicker
                  schedule={item.schedule}
                  timezone={item.timezone ?? ''}
                  onSave={(schedule, timezone) => saveSchedule(item.id, schedule, timezone)}
                  onCancel={() => setEditing(null)}
                />
              ) : null}

              {item.type === STREAMING_TOP && item.options ? (
                <StreamingChartsOptions
                  item={item}
                  canEdit={!!canEdit}
                  quota={quota}
                  onSaved={load}
                />
              ) : null}

              {/* Pages quick edit */}
              {canEdit && item.type !== STREAMING_TOP ? (
                <div className="flex items-center gap-2 mt-3 pt-3 border-t border-border/50">
                  <span className="text-xs text-white/30">Pages:</span>
                  <select
                    onChange={(e) => updatePages(item.id, Number(e.target.value))}
                    defaultValue=""
                    className="px-2 py-1 bg-surface-alt rounded border border-border text-white text-xs"
                  >
                    <option value="" disabled>
                      Change...
                    </option>
                    {[1, 2, 3, 5, 10].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
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
