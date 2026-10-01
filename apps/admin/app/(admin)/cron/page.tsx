'use client';

import { useState, useEffect, useCallback } from 'react';
import { api } from '@/lib/api';
import { Badge, Table } from '@/components/ui';
import { useAuth } from '@/lib/auth';
import { SchedulePicker } from '@/components/SchedulePicker';
import { showError } from '@/lib/dialog';

type JobOption =
  | { key: string; label: string; help?: string; type: 'boolean'; default: boolean }
  | {
      key: string;
      label: string;
      help?: string;
      type: 'number';
      default: number;
      min: number;
      max: number;
    }
  | {
      key: string;
      label: string;
      help?: string;
      type: 'select';
      default: string;
      choices: string[];
    };

interface Job {
  name: string;
  label: string;
  description: string;
  schedule: string;
  timezone: string | null;
  enabled: boolean;
  running: boolean;
  runs: number;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  lastDurationMs: number | null;
  options: JobOption[];
  config: Record<string, unknown>;
}

/** Render a timestamp in the job's own timezone (falls back to the viewer's locale). */
function inTz(iso: string, tz?: string | null) {
  return tz
    ? new Date(iso).toLocaleString(undefined, { timeZone: tz })
    : new Date(iso).toLocaleString();
}

/** One-line summary of a run's result payload ({processed: 12, succeeded: 10, ...}). */
function resultSummary(result: any): string {
  if (!result || typeof result !== 'object') return '—';
  const parts = Object.entries(result)
    .filter(([k, v]) => (typeof v === 'number' && v !== 0) || k === 'mode')
    .map(([k, v]) => `${k}: ${v}`);
  return parts.length ? parts.join(' · ') : 'ok';
}

const errorMessage = (e: any) => e?.response?.data?.message ?? e?.message ?? 'Try again.';

export default function CronJobsPage() {
  const { user: me } = useAuth();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [history, setHistory] = useState<any>(null);
  const [selectedJob, setSelectedJob] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [configuring, setConfiguring] = useState<string | null>(null);

  const load = useCallback(() => api.get('/admin/cron').then((r) => setJobs(r.data)), []);
  useEffect(() => {
    load();
  }, [load]);

  // While a job runs, refresh the list so its status and report appear when it finishes.
  const anyRunning = jobs.some((j) => j.running);
  useEffect(() => {
    if (!anyRunning) return;
    const timer = setInterval(() => {
      load();
      if (selectedJob)
        api.get(`/admin/cron/${selectedJob}/history`).then((r) => setHistory(r.data));
    }, 5000);
    return () => clearInterval(timer);
  }, [anyRunning, load, selectedJob]);

  useEffect(() => {
    if (selectedJob) {
      api.get(`/admin/cron/${selectedJob}/history`).then((r) => setHistory(r.data));
    }
  }, [selectedJob]);

  const canEdit = me?.role && ['ADMIN', 'SUPER_ADMIN'].includes(me.role);
  const canTrigger =
    me?.role && ['CONTENT_MANAGER', 'MODERATOR', 'ADMIN', 'SUPER_ADMIN'].includes(me.role);

  const patch = async (name: string, body: Record<string, unknown>) => {
    try {
      await api.patch(`/admin/cron/${name}`, body);
      await load();
      return true;
    } catch (e: any) {
      showError({ title: 'Could not save the job', description: errorMessage(e) });
      return false;
    }
  };

  const saveSchedule = async (name: string, schedule: string, timezone: string | null) => {
    if (await patch(name, { schedule, timezone })) setEditing(null);
  };

  const triggerJob = async (name: string) => {
    try {
      await api.post(`/admin/cron/${name}/trigger`);
      await load();
    } catch (e: any) {
      showError({ title: 'Could not start the job', description: errorMessage(e) });
    }
  };

  const selected = jobs.find((j) => j.name === selectedJob);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Scheduled Jobs</h1>

      <div className="grid gap-3">
        {jobs.map((job) => (
          <div key={job.name} className="bg-surface rounded-xl p-5 border border-border">
            <div className="flex items-center justify-between gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="font-semibold">{job.label}</span>
                  {job.enabled ? (
                    <Badge color="success">Enabled</Badge>
                  ) : (
                    <Badge color="default">Disabled</Badge>
                  )}
                  {job.running ? <Badge color="info">Running</Badge> : null}
                  {job.lastStatus === 'failed' ? <Badge color="danger">Failed</Badge> : null}
                </div>
                {job.description ? (
                  <div className="text-xs text-white/50 mt-1">{job.description}</div>
                ) : null}
                <div className="flex gap-4 mt-2 text-xs text-white/40 flex-wrap">
                  <span>
                    ⏱ <code className="text-accent">{job.schedule}</code>
                    {job.timezone ? ` · ${job.timezone}` : ''}
                  </span>
                  <span>Runs: {job.runs}</span>
                  {job.lastRunAt ? (
                    <span>Last: {inTz(job.lastRunAt, job.timezone)}</span>
                  ) : (
                    <span>Never run</span>
                  )}
                  {job.lastDurationMs != null ? (
                    <span>Duration: {(job.lastDurationMs / 1000).toFixed(1)}s</span>
                  ) : null}
                </div>
                {job.lastError ? (
                  <div className="text-xs text-danger mt-1">⚠ {job.lastError}</div>
                ) : null}
              </div>

              <div className="flex items-center gap-2 shrink-0">
                {canEdit ? (
                  <button
                    onClick={() => patch(job.name, { enabled: !job.enabled })}
                    aria-label={job.enabled ? 'Disable job' : 'Enable job'}
                    className={`relative w-12 h-6 rounded-full transition ${job.enabled ? 'bg-accent' : 'bg-surface-alt'}`}
                  >
                    <div
                      className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${job.enabled ? 'left-6' : 'left-0.5'}`}
                    />
                  </button>
                ) : null}

                {canTrigger ? (
                  <button
                    onClick={() => triggerJob(job.name)}
                    disabled={job.running}
                    className="px-3 py-1.5 bg-surface-alt rounded-lg text-xs text-accent border border-border hover:border-accent disabled:opacity-50"
                  >
                    {job.running ? 'Running…' : 'Run Now'}
                  </button>
                ) : null}

                {canEdit && job.options.length ? (
                  <button
                    onClick={() => setConfiguring(configuring === job.name ? null : job.name)}
                    className="px-3 py-1.5 bg-surface-alt rounded-lg text-xs text-white/60 border border-border hover:text-white"
                  >
                    Options
                  </button>
                ) : null}

                {canEdit ? (
                  <button
                    onClick={() => setEditing(editing === job.name ? null : job.name)}
                    className="px-3 py-1.5 bg-surface-alt rounded-lg text-xs text-white/60 border border-border hover:text-white"
                  >
                    Edit
                  </button>
                ) : null}

                <button
                  onClick={() => setSelectedJob(selectedJob === job.name ? null : job.name)}
                  className="px-3 py-1.5 bg-surface-alt rounded-lg text-xs text-white/60 border border-border hover:text-white"
                >
                  History
                </button>
              </div>
            </div>

            {editing === job.name ? (
              <SchedulePicker
                schedule={job.schedule}
                timezone={job.timezone ?? ''}
                onSave={(schedule, timezone) => saveSchedule(job.name, schedule, timezone)}
                onCancel={() => setEditing(null)}
              />
            ) : null}

            {configuring === job.name ? (
              <JobOptionsForm
                job={job}
                onSave={async (config) => {
                  if (await patch(job.name, { config })) setConfiguring(null);
                }}
                onReset={async () => {
                  if (await patch(job.name, { config: null })) setConfiguring(null);
                }}
                onCancel={() => setConfiguring(null)}
              />
            ) : null}
          </div>
        ))}
      </div>

      {selectedJob && history ? (
        <div className="bg-surface rounded-xl p-5 border border-border">
          <div className="text-sm font-semibold text-white/70 mb-3">
            Run History: {selected?.label}
            {selected?.timezone ? (
              <span className="text-white/30 font-normal"> · times in {selected.timezone}</span>
            ) : null}
          </div>
          <Table headers={['Status', 'Started', 'Duration', 'Report', 'Error']}>
            {history.items.map((run: any) => (
              <tr key={run.id} className="border-b border-border/50">
                <td className="px-4 py-3">
                  <Badge color={run.status === 'success' ? 'success' : 'danger'}>
                    {run.status}
                  </Badge>
                </td>
                <td className="px-4 py-3 text-xs text-white/30">
                  {inTz(run.startedAt, selected?.timezone)}
                </td>
                <td className="px-4 py-3 text-sm text-white/40">
                  {(run.durationMs / 1000).toFixed(1)}s
                </td>
                <td className="px-4 py-3 text-xs text-white/50 max-w-md">
                  {resultSummary(run.result)}
                </td>
                <td
                  className="px-4 py-3 text-xs text-danger max-w-xs truncate"
                  title={run.error ?? ''}
                >
                  {run.error || '—'}
                </td>
              </tr>
            ))}
          </Table>
          {history.items.length === 0 ? (
            <div className="text-white/30 text-sm text-center py-4">No runs yet</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function JobOptionsForm({
  job,
  onSave,
  onReset,
  onCancel,
}: {
  job: Job;
  onSave: (config: Record<string, unknown>) => void;
  onReset: () => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<Record<string, unknown>>(job.config);
  const set = (key: string, value: unknown) => setValues((v) => ({ ...v, [key]: value }));

  return (
    <div className="mt-4 border-t border-border pt-4 space-y-3">
      {job.options.map((option) => (
        <label key={option.key} className="flex items-start gap-3 text-sm">
          <div className="w-64 shrink-0">
            <div className="text-white/80">{option.label}</div>
            {option.help ? <div className="text-xs text-white/40">{option.help}</div> : null}
          </div>
          {option.type === 'boolean' ? (
            <input
              type="checkbox"
              checked={Boolean(values[option.key])}
              onChange={(e) => set(option.key, e.target.checked)}
              className="mt-1"
            />
          ) : option.type === 'number' ? (
            <input
              type="number"
              min={option.min}
              max={option.max}
              value={Number(values[option.key] ?? option.default)}
              onChange={(e) => set(option.key, Number(e.target.value))}
              className="w-28 bg-surface-alt border border-border rounded-lg px-2 py-1 text-sm"
            />
          ) : (
            <select
              value={String(values[option.key] ?? option.default)}
              onChange={(e) => set(option.key, e.target.value)}
              className="bg-surface-alt border border-border rounded-lg px-2 py-1 text-sm"
            >
              {option.choices.map((choice) => (
                <option key={choice} value={choice}>
                  {choice}
                </option>
              ))}
            </select>
          )}
        </label>
      ))}
      <div className="flex gap-2 pt-1">
        <button
          onClick={() => onSave(values)}
          className="px-3 py-1.5 bg-accent rounded-lg text-xs text-white"
        >
          Save options
        </button>
        <button
          onClick={onReset}
          className="px-3 py-1.5 bg-surface-alt rounded-lg text-xs text-white/60 border border-border hover:text-white"
        >
          Reset to defaults
        </button>
        <button
          onClick={onCancel}
          className="px-3 py-1.5 bg-surface-alt rounded-lg text-xs text-white/60 border border-border hover:text-white"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
