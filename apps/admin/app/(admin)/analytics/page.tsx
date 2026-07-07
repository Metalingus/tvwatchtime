'use client';

import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import { ChartCard } from '@/components/ui';
import { AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from 'recharts';

const PIE_COLORS = ['#FFD60A', '#22C55E', '#3B82F6', '#8B5CF6', '#EF4444', '#F59E0B'];

export default function AnalyticsPage() {
  const [charts, setCharts] = useState<any>(null);
  const [stats, setStats] = useState<any>(null);
  const [tab, setTab] = useState<'overview' | 'media' | 'watch' | 'notifications'>('overview');

  useEffect(() => {
    api.get('/admin/charts').then((r) => setCharts(r.data));
    api.get('/admin/stats').then((r) => setStats(r.data));
  }, []);

  if (!charts || !stats) return <div className="text-white/40 text-center py-20">Loading...</div>;

  const userData = (charts.usersByDay || []).map((d: any) => ({ date: String(d.date).slice(5), count: Number(d.count) }));
  const watchData = (charts.watchByDay || []).map((d: any) => ({ date: String(d.date).slice(5), count: Number(d.count) }));
  const mediaData = (charts.mediaByDay || []).map((d: any) => ({ date: String(d.date).slice(5), count: Number(d.count) }));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Analytics</h1>
        <div className="flex gap-2">
          {(['overview', 'media', 'watch', 'notifications'] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={`px-4 py-1.5 rounded-lg text-sm capitalize transition ${tab === t ? 'bg-accent text-bg font-bold' : 'bg-surface-alt text-white/60'}`}>{t}</button>
          ))}
        </div>
      </div>

      {tab === 'overview' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <ChartCard title="New Users (30 days)">
            <ResponsiveContainer width="100%" height={250}>
              <AreaChart data={userData}>
                <defs><linearGradient id="a1" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#FFD60A" stopOpacity={0.3} /><stop offset="95%" stopColor="#FFD60A" stopOpacity={0} /></linearGradient></defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#2A2F3A" />
                <XAxis dataKey="date" stroke="#6B7280" fontSize={11} />
                <YAxis stroke="#6B7280" fontSize={11} />
                <Tooltip contentStyle={{ background: '#171A21', border: '1px solid #2A2F3A', borderRadius: 8 }} />
                <Area type="monotone" dataKey="count" stroke="#FFD60A" fill="url(#a1)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </ChartCard>
          <ChartCard title="Watch Events (30 days)">
            <ResponsiveContainer width="100%" height={250}>
              <AreaChart data={watchData}>
                <defs><linearGradient id="a2" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#22C55E" stopOpacity={0.3} /><stop offset="95%" stopColor="#22C55E" stopOpacity={0} /></linearGradient></defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#2A2F3A" />
                <XAxis dataKey="date" stroke="#6B7280" fontSize={11} />
                <YAxis stroke="#6B7280" fontSize={11} />
                <Tooltip contentStyle={{ background: '#171A21', border: '1px solid #2A2F3A', borderRadius: 8 }} />
                <Area type="monotone" dataKey="count" stroke="#22C55E" fill="url(#a2)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
          </ChartCard>
          <ChartCard title="Media Added (30 days)">
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={mediaData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#2A2F3A" />
                <XAxis dataKey="date" stroke="#6B7280" fontSize={11} />
                <YAxis stroke="#6B7280" fontSize={11} />
                <Tooltip contentStyle={{ background: '#171A21', border: '1px solid #2A2F3A', borderRadius: 8 }} cursor={{ fill: '#ffffff08' }} />
                <Bar dataKey="count" fill="#8B5CF6" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
          <ChartCard title="Platform Summary">
            <div className="grid grid-cols-2 gap-4 mt-4">
              <SummaryItem label="Total Users" value={stats.users} sub={`+${stats.newMonth} this month`} />
              <SummaryItem label="Active (7d)" value={stats.activeWeek} />
              <SummaryItem label="Shows" value={stats.shows} sub={`${stats.episodes} episodes`} />
              <SummaryItem label="Movies" value={stats.movies} />
              <SummaryItem label="Watch Events" value={stats.watchHistory} />
              <SummaryItem label="Notifications Sent" value={stats.notifications} />
            </div>
          </ChartCard>
        </div>
      )}

      {tab === 'media' && (
        <div className="space-y-4">
          <ChartCard title="Most Tracked Shows">
            <div className="space-y-2 mt-2">
              {(charts.topShows || []).map((s: any, i: number) => (
                <div key={s.id} className="flex items-center gap-3 py-2 border-b border-border/50 last:border-0">
                  <span className="text-white/30 text-sm w-5">{i + 1}</span>
                  {s.posterUrl ? <img src={s.posterUrl} alt="" className="w-8 h-12 rounded object-cover" /> : <div className="w-8 h-12 rounded bg-surface-alt" />}
                  <span className="flex-1 text-sm truncate">{s.title}</span>
                  <div className="w-32 h-1.5 bg-surface-alt rounded-full overflow-hidden">
                    <div className="h-full bg-accent" style={{ width: `${Math.min(100, (s.addedCount / (charts.topShows[0]?.addedCount || 1)) * 100)}%` }} />
                  </div>
                  <span className="text-accent text-sm font-bold w-10 text-right">{s.addedCount}</span>
                </div>
              ))}
            </div>
          </ChartCard>
        </div>
      )}

      {tab === 'watch' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <ChartCard title="Daily Watch Events (30 days)">
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={watchData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#2A2F3A" />
                <XAxis dataKey="date" stroke="#6B7280" fontSize={11} />
                <YAxis stroke="#6B7280" fontSize={11} />
                <Tooltip contentStyle={{ background: '#171A21', border: '1px solid #2A2F3A', borderRadius: 8 }} cursor={{ fill: '#ffffff08' }} />
                <Bar dataKey="count" fill="#22C55E" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
          <ChartCard title="Watch Activity Summary">
            <div className="grid grid-cols-2 gap-4 mt-4">
              <SummaryItem label="Total Watch Events" value={stats.watchHistory} />
              <SummaryItem label="Active Users (7d)" value={stats.activeWeek} />
              <SummaryItem label="Avg/Active User" value={stats.activeWeek > 0 ? Math.round(stats.watchHistory / stats.activeWeek) : 0} />
              <SummaryItem label="Notifications" value={stats.notifications} />
            </div>
          </ChartCard>
        </div>
      )}

      {tab === 'notifications' && (
        <ChartCard title="Notification Stats">
          <div className="grid grid-cols-3 gap-4 mt-4">
            <SummaryItem label="Total Sent" value={stats.notifications} />
            <SummaryItem label="Failed Jobs" value={stats.tmdbLogs} />
            <SummaryItem label="Pending Jobs" value={stats.pendingJobs} />
          </div>
        </ChartCard>
      )}
    </div>
  );
}

function SummaryItem({ label, value, sub }: { label: string; value: number; sub?: string }) {
  return (
    <div className="bg-surface-alt rounded-lg p-4">
      <div className="text-xs text-white/40 uppercase">{label}</div>
      <div className="text-2xl font-bold text-accent mt-1">{value.toLocaleString()}</div>
      {sub ? <div className="text-xs text-white/30 mt-0.5">{sub}</div> : null}
    </div>
  );
}
