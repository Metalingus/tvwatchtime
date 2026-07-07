'use client';

import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import { Badge, Table, Pagination } from '@/components/ui';
import { useAuth } from '@/lib/auth';

const SCHEDULE_PRESETS = [
  { label: 'Every 5 minutes', value: '*/5 * * * *' },
  { label: 'Every 15 minutes', value: '*/15 * * * *' },
  { label: 'Every 30 minutes', value: '*/30 * * * *' },
  { label: 'Every hour', value: '0 * * * *' },
  { label: 'Every 6 hours', value: '0 */6 * * *' },
  { label: 'Every 12 hours', value: '0 */12 * * *' },
  { label: 'Daily at 3 AM', value: '0 3 * * *' },
  { label: 'Daily at 6 AM', value: '0 6 * * *' },
  { label: 'Daily at midnight', value: '0 0 * * *' },
];

export default function CronJobsPage() {
  const { user: me } = useAuth();
  const [jobs, setJobs] = useState<any[]>([]);
  const [history, setHistory] = useState<any>(null);
  const [selectedJob, setSelectedJob] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [customSchedule, setCustomSchedule] = useState('');
  const [triggering, setTriggering] = useState<string | null>(null);

  const load = () => api.get('/admin/cron').then((r) => setJobs(r.data));
  useEffect(() => { load(); }, []);

  useEffect(() => {
    if (selectedJob) {
      api.get(`/admin/cron/${selectedJob}/history`).then((r) => setHistory(r.data));
    }
  }, [selectedJob]);

  const canEdit = me?.role && ['ADMIN', 'SUPER_ADMIN'].includes(me.role);
  const canTrigger = me?.role && ['CONTENT_MANAGER', 'MODERATOR', 'ADMIN', 'SUPER_ADMIN'].includes(me.role);

  const toggleJob = async (name: string, current: boolean) => {
    await api.patch(`/admin/cron/${name}`, { enabled: !current });
    load();
  };

  const updateSchedule = async (name: string, schedule: string) => {
    await api.patch(`/admin/cron/${name}`, { schedule });
    setEditing(null);
    load();
  };

  const triggerJob = async (name: string) => {
    setTriggering(name);
    try { await api.post(`/admin/cron/${name}/trigger`); } finally { setTriggering(null); }
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Scheduled Jobs</h1>

      {/* Job list */}
      <div className="grid gap-3">
        {jobs.map((job) => (
          <div key={job.name} className="bg-surface rounded-xl p-5 border border-border">
            <div className="flex items-center justify-between">
              <div className="flex-1">
                <div className="flex items-center gap-3">
                  <span className="font-semibold">{job.label}</span>
                  {job.enabled ? <Badge color="success">Enabled</Badge> : <Badge color="default">Disabled</Badge>}
                  {job.lastStatus === 'failed' ? <Badge color="danger">Failed</Badge> : null}
                </div>
                <div className="flex gap-4 mt-2 text-xs text-white/40">
                  <span>⏱ <code className="text-accent">{job.schedule}</code></span>
                  <span>Runs: {job.runs}</span>
                  {job.lastRunAt ? <span>Last: {new Date(job.lastRunAt).toLocaleString()}</span> : <span>Never run</span>}
                  {job.lastDurationMs != null ? <span>Duration: {(job.lastDurationMs / 1000).toFixed(1)}s</span> : null}
                </div>
                {job.lastError ? <div className="text-xs text-danger mt-1">⚠ {job.lastError}</div> : null}
              </div>

              <div className="flex items-center gap-2">
                {/* Toggle */}
                {canEdit ? (
                  <button onClick={() => toggleJob(job.name, job.enabled)} disabled={!canEdit}
                    className={`relative w-12 h-6 rounded-full transition ${job.enabled ? 'bg-accent' : 'bg-surface-alt'}`}>
                    <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${job.enabled ? 'left-6' : 'left-0.5'}`} />
                  </button>
                ) : null}

                {/* Trigger now */}
                {canTrigger ? (
                  <button onClick={() => triggerJob(job.name)} disabled={triggering === job.name}
                    className="px-3 py-1.5 bg-surface-alt rounded-lg text-xs text-accent border border-border hover:border-accent disabled:opacity-50">
                    {triggering === job.name ? 'Running...' : 'Run Now'}
                  </button>
                ) : null}

                {/* Edit schedule */}
                {canEdit ? (
                  <button onClick={() => { setEditing(editing === job.name ? null : job.name); setCustomSchedule(job.schedule); }}
                    className="px-3 py-1.5 bg-surface-alt rounded-lg text-xs text-white/60 border border-border hover:text-white">
                    Edit
                  </button>
                ) : null}

                {/* History */}
                <button onClick={() => setSelectedJob(selectedJob === job.name ? null : job.name)}
                  className="px-3 py-1.5 bg-surface-alt rounded-lg text-xs text-white/60 border border-border hover:text-white">
                  History
                </button>
              </div>
            </div>

            {/* Edit schedule panel */}
            {editing === job.name ? (
              <div className="mt-4 pt-4 border-t border-border flex items-center gap-3">
                <label className="text-xs text-white/40 uppercase">Schedule</label>
                <select onChange={(e) => updateSchedule(job.name, e.target.value)} value="" className="px-3 py-2 bg-surface-alt rounded-lg border border-border text-white text-sm">
                  <option value="" disabled>Choose preset...</option>
                  {SCHEDULE_PRESETS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                </select>
                <span className="text-white/30 text-xs">or custom:</span>
                <input type="text" value={customSchedule} onChange={(e) => setCustomSchedule(e.target.value)} placeholder="* * * * *" className="px-3 py-2 bg-surface-alt rounded-lg border border-border text-white text-sm w-32" />
                <button onClick={() => updateSchedule(job.name, customSchedule)} className="px-3 py-2 bg-accent text-bg font-bold rounded-lg text-sm">Save</button>
                <button onClick={() => setEditing(null)} className="px-3 py-2 bg-surface-alt text-white/60 rounded-lg text-sm">Cancel</button>
              </div>
            ) : null}
          </div>
        ))}
      </div>

      {/* History panel */}
      {selectedJob && history ? (
        <div className="bg-surface rounded-xl p-5 border border-border">
          <div className="text-sm font-semibold text-white/70 mb-3">Run History: {jobs.find((j) => j.name === selectedJob)?.label}</div>
          <Table headers={['Status', 'Started', 'Duration', 'Error']}>
            {history.items.map((run: any) => (
              <tr key={run.id} className="border-b border-border/50">
                <td className="px-4 py-3"><Badge color={run.status === 'success' ? 'success' : 'danger'}>{run.status}</Badge></td>
                <td className="px-4 py-3 text-xs text-white/30">{new Date(run.startedAt).toLocaleString()}</td>
                <td className="px-4 py-3 text-sm text-white/40">{(run.durationMs / 1000).toFixed(1)}s</td>
                <td className="px-4 py-3 text-xs text-danger max-w-xs truncate">{run.error || '—'}</td>
              </tr>
            ))}
          </Table>
          {history.items.length === 0 ? <div className="text-white/30 text-sm text-center py-4">No runs yet</div> : null}
        </div>
      ) : null}

      {/* Schedule reference */}
      <div className="bg-surface rounded-xl p-5 border border-border">
        <div className="text-sm font-semibold text-white/70 mb-3">Cron Format Reference</div>
        <div className="grid grid-cols-5 gap-2 text-center text-xs">
          <div><div className="text-accent font-bold">Minute</div><div className="text-white/30 mt-1">0-59</div><div className="text-white/40 mt-1">*/5 = every 5 min</div></div>
          <div><div className="text-accent font-bold">Hour</div><div className="text-white/30 mt-1">0-23</div><div className="text-white/40 mt-1">* = every hour</div></div>
          <div><div className="text-accent font-bold">Day</div><div className="text-white/30 mt-1">1-31</div><div className="text-white/40 mt-1">* = every day</div></div>
          <div><div className="text-accent font-bold">Month</div><div className="text-white/30 mt-1">1-12</div><div className="text-white/40 mt-1">* = every month</div></div>
          <div><div className="text-accent font-bold">Weekday</div><div className="text-white/30 mt-1">0-6</div><div className="text-white/40 mt-1">0 = Sunday</div></div>
        </div>
      </div>
    </div>
  );
}
