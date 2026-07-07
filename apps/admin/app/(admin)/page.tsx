'use client';

import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import { StatCard, ChartCard } from '@/components/ui';
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';

export default function DashboardPage() {
  const [stats, setStats] = useState<any>(null);
  const [charts, setCharts] = useState<any>(null);

  useEffect(() => {
    api.get('/admin/stats').then((r) => setStats(r.data));
    api.get('/admin/charts').then((r) => setCharts(r.data));
  }, []);

  if (!stats) return <div className="text-white/40 text-center py-20">Loading...</div>;

  const userData = (charts?.usersByDay || []).map((d: any) => ({ date: String(d.date).slice(5), count: Number(d.count) }));
  const watchData = (charts?.watchByDay || []).map((d: any) => ({ date: String(d.date).slice(5), count: Number(d.count) }));
  const mediaData = (charts?.mediaByDay || []).map((d: any) => ({ date: String(d.date).slice(5), count: Number(d.count) }));

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Dashboard</h1>

      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Total Users" value={stats.users} sub={`+${stats.newToday} today`} color="text-accent" />
        <StatCard label="Shows" value={stats.shows} sub={`${stats.episodes} episodes`} color="text-blue-400" />
        <StatCard label="Movies" value={stats.movies} sub="in database" color="text-purple-400" />
        <StatCard label="Watch Events" value={stats.watchHistory} sub={`${stats.activeWeek} active this week`} color="text-success" />
        <StatCard label="Imports" value={stats.imports} color="text-orange-400" />
        <StatCard label="Notifications" value={stats.notifications} color="text-pink-400" />
        <StatCard label="Pending Jobs" value={stats.pendingJobs} sub={stats.failedJobs > 0 ? `${stats.failedJobs} failed` : 'all good'} color={stats.failedJobs > 0 ? 'text-danger' : 'text-white/60'} />
        <StatCard label="Suspended Users" value={stats.suspendedUsers} color="text-danger" />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard title="User Growth (30 days)">
          <ResponsiveContainer width="100%" height={250}>
            <AreaChart data={userData}>
              <defs><linearGradient id="ug" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#FFD60A" stopOpacity={0.3} /><stop offset="95%" stopColor="#FFD60A" stopOpacity={0} /></linearGradient></defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#2A2F3A" />
              <XAxis dataKey="date" stroke="#6B7280" fontSize={11} />
              <YAxis stroke="#6B7280" fontSize={11} />
              <Tooltip contentStyle={{ background: '#171A21', border: '1px solid #2A2F3A', borderRadius: 8 }} />
              <Area type="monotone" dataKey="count" stroke="#FFD60A" fill="url(#ug)" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard title="Watch Activity (30 days)">
          <ResponsiveContainer width="100%" height={250}>
            <AreaChart data={watchData}>
              <defs><linearGradient id="wa" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#22C55E" stopOpacity={0.3} /><stop offset="95%" stopColor="#22C55E" stopOpacity={0} /></linearGradient></defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#2A2F3A" />
              <XAxis dataKey="date" stroke="#6B7280" fontSize={11} />
              <YAxis stroke="#6B7280" fontSize={11} />
              <Tooltip contentStyle={{ background: '#171A21', border: '1px solid #2A2F3A', borderRadius: 8 }} />
              <Area type="monotone" dataKey="count" stroke="#22C55E" fill="url(#wa)" strokeWidth={2} />
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

        <ChartCard title="Most Tracked Shows">
          <div className="space-y-2">
            {(charts?.topShows || []).slice(0, 8).map((s: any, i: number) => (
              <div key={s.id} className="flex items-center gap-3 py-1.5">
                <span className="text-white/30 text-sm w-5">{i + 1}</span>
                {s.posterUrl ? <img src={s.posterUrl} alt="" className="w-8 h-12 rounded object-cover" /> : <div className="w-8 h-12 rounded bg-surface-alt" />}
                <span className="flex-1 text-sm truncate">{s.title}</span>
                <span className="text-accent text-sm font-bold">{s.addedCount}</span>
              </div>
            ))}
          </div>
        </ChartCard>
      </div>
    </div>
  );
}
