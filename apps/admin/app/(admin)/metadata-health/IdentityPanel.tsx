'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { showConfirm, showError } from '@/lib/dialog';
import { Badge } from '@/components/ui';

/**
 * Data identity: the defects that corrupt user data (duplicates, type contamination, wrong or
 * missing provider ids, unknown episode structure), ranked by user impact. The nightly
 * identity_maintenance job repairs them; per-title Check/Apply runs the same step for one row.
 */

type Snapshot = Record<string, number>;
interface JobState {
  name: string;
  label: string;
  enabled: boolean;
  schedule: string | null;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  lastResult: Record<string, unknown> | null;
}
interface Overview {
  audit: {
    latest: Snapshot | null;
    latestAt: string | null;
    previous: Snapshot | null;
    previousAt: string | null;
  };
  jobs: JobState[];
}
type Tool = 'repair' | 'backlog' | 'structure';
type SampleKind =
  | 'duplicate-pairs'
  | 'multi-alias'
  | 'type-mismatch'
  | 'wrong-kind'
  | 'anime-missing-tvdb'
  | 'no-structure-authority'
  | 'legacy-unmapped';
interface SampleRow {
  mediaId: string;
  title: string;
  type: string;
  users: number;
  detail: string | null;
  otherMediaId?: string | null;
  otherTitle?: string | null;
}
interface BacklogReport {
  mode: 'dry-run' | 'apply';
  processed: number;
  nextCursor: string | null;
  stoppedEarly: boolean;
  counts: Record<string, number>;
  tiers?: Record<string, number>;
  samples: Array<{
    mediaId: string;
    title: string;
    action?: string;
    outcome?: string;
    tier?: string | null;
    reason?: string;
    detail?: string;
    otherMediaId?: string;
  }>;
}
interface WatchForgeBudget {
  enabled?: boolean;
  configured?: boolean;
  limit?: number;
  used?: number;
  byLane?: Record<string, number>;
  providerRemaining?: number | null;
}

/** Scoreboard rows: metric keys come from IdentityHealthAuditService. Lower is better. */
const METRICS: Array<{
  label: string;
  total: (s: Snapshot) => number;
  users?: (s: Snapshot) => number;
  kind?: SampleKind;
  fix: 'backlog' | 'structure' | 'repair' | 'info';
  hint: string;
}> = [
  {
    label: 'Duplicate show pairs',
    total: (s) => (s.dupPairsGeneral ?? 0) + (s.dupPairsAnime ?? 0),
    users: (s) => (s.dupPairsGeneralUsers ?? 0) + (s.dupPairsAnimeUsers ?? 0),
    kind: 'duplicate-pairs',
    fix: 'backlog',
    hint: 'Same title/year: one row TVDB-only, the other TMDB-only. A title match only ranks the work; the backlog merges a pair only with provider id proof.',
  },
  {
    label: 'Movie rows carrying a show graph',
    total: (s) => s.movieRowsWithShowStructure ?? 0,
    kind: 'type-mismatch',
    fix: 'repair',
    hint: 'A movie and a show were merged into one row. Identity maintenance splits it once the providers verify both identities.',
  },
  {
    label: 'Wrong-kind ids',
    total: (s) => s.wrongKindAliasMedia ?? 0,
    kind: 'wrong-kind',
    fix: 'repair',
    hint: 'A movie holds a SERIES id (or the reverse). Identity maintenance quarantines the wrong-kind id after verifying the row identity.',
  },
  {
    label: 'Several ids from one provider',
    total: (s) => s.multiAliasMedia ?? 0,
    users: (s) => s.multiAliasMediaUsers ?? 0,
    kind: 'multi-alias',
    fix: 'repair',
    hint: 'Two TMDB/TVDB/IMDb ids on one row. Identity maintenance keeps verified secondary ids and quarantines proven-wrong ones; new ones can no longer be added silently.',
  },
  {
    label: 'Anime without a TVDB id',
    total: (s) => s.animeMissingTvdb ?? 0,
    users: (s) => s.animeMissingTvdbUsers ?? 0,
    kind: 'anime-missing-tvdb',
    fix: 'backlog',
    hint: 'Anime episode structure comes from TVDB. Resolved from TMDB/TVDB crosswalks or WatchForge, never by title.',
  },
  {
    label: 'Shows without structure authority',
    total: (s) => s.showsWithoutStructureAuthority ?? 0,
    users: (s) => s.showsWithoutStructureAuthorityUsers ?? 0,
    kind: 'no-structure-authority',
    fix: 'structure',
    hint: 'Nobody decided whether TMDB or TVDB owns the episode list, so episode matching is ambiguous.',
  },
  {
    label: 'Legacy unmapped episodes',
    total: (s) => s.legacyUnmappedEpisodes ?? 0,
    users: (s) => s.legacyUnmappedEpisodesUsers ?? 0,
    kind: 'legacy-unmapped',
    fix: 'structure',
    hint: 'Old episode rows outside the active graph that still hold user watches. The structure backfill remaps them.',
  },
  {
    label: 'Shows missing TMDB / TVDB',
    total: (s) => (s.showsMissingTmdb ?? 0) + (s.showsMissingTvdb ?? 0),
    fix: 'backlog',
    hint: 'Many are legitimate (no counterpart). The backlog attaches proven counterparts and reports the rest.',
  },
];

const btn =
  'rounded border px-2 py-1 text-xs font-medium disabled:opacity-50 border-blue-600 text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950';
const btnDanger =
  'rounded border px-2 py-1 text-xs font-medium disabled:opacity-50 border-amber-600 text-amber-700 hover:bg-amber-50 dark:text-amber-400 dark:hover:bg-amber-950';

function delta(now: number, before: number | undefined) {
  if (before === undefined) return null;
  const d = now - before;
  if (d === 0) return <span className="text-zinc-400">±0</span>;
  return (
    <span
      className={d < 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}
    >
      {d > 0 ? '+' : ''}
      {d.toLocaleString()}
    </span>
  );
}

function when(value: string | null) {
  return value ? new Date(value).toLocaleString() : 'never';
}

export default function IdentityPanel() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [auditing, setAuditing] = useState(false);
  const [kind, setKind] = useState<SampleKind | null>(null);
  const [samples, setSamples] = useState<SampleRow[] | null>(null);
  const [samplesLoading, setSamplesLoading] = useState(false);
  const [checks, setChecks] = useState<Record<string, BacklogReport | 'running'>>({});
  const [budget, setBudget] = useState<WatchForgeBudget | null>(null);

  const loadOverview = useCallback(() => {
    api
      .get('/admin/identity/overview')
      .then((r) => setOverview(r.data))
      .catch(() => undefined);
    api
      .get('/admin/providers')
      .then((r) =>
        setBudget(
          (r.data as Array<{ tag: string; dailyBudget?: WatchForgeBudget }>).find(
            (p) => p.tag === 'watchforge',
          )?.dailyBudget ?? null,
        ),
      )
      .catch(() => undefined);
  }, []);
  useEffect(() => loadOverview(), [loadOverview]);

  const runAudit = () => {
    setAuditing(true);
    api
      .post('/admin/identity/audit/run')
      .then((r) => setOverview(r.data))
      .catch((e) =>
        showError({
          title: 'Audit failed',
          description: e?.response?.data?.message ?? 'Try again.',
        }),
      )
      .finally(() => setAuditing(false));
  };

  const loadSamples = (next: SampleKind) => {
    setKind(next);
    setSamples(null);
    setSamplesLoading(true);
    api
      .get(`/admin/identity/samples?kind=${next}&limit=50`)
      .then((r) => setSamples(r.data))
      .catch(() => setSamples([]))
      .finally(() => setSamplesLoading(false));
  };

  /** Per-title check/apply through the same step the nightly maintenance job runs. */
  const runForTitle = async (tool: Tool, mediaId: string, mode: 'dry-run' | 'apply') => {
    const key = `${tool}:${mediaId}`;
    setChecks((c) => ({ ...c, [key]: 'running' }));
    try {
      // One title answers synchronously but can take a while (full provider snapshots).
      const qs = new URLSearchParams({ tool, mode, mediaId });
      const r = await api.post(`/admin/identity/title-run?${qs}`, null, { timeout: 120_000 });
      setChecks((c) => ({ ...c, [key]: r.data }));
      if (mode === 'apply') loadOverview();
    } catch (e: any) {
      setChecks((c) => {
        const next = { ...c };
        delete next[key];
        return next;
      });
      showError({
        title: 'Request failed',
        description: e?.response?.data?.message ?? 'Try again.',
      });
    }
  };

  const confirmApply = (tool: Tool, row: SampleRow) =>
    showConfirm({
      title:
        tool === 'structure'
          ? `Apply structure decision for "${row.title}"?`
          : `Apply identity fix for "${row.title}"?`,
      description:
        tool === 'backlog'
          ? 'Attaches proven ids or merges the proven duplicate copy-only (sources stay recoverable through the canonical ledger). Only provider-proven evidence is used.'
          : tool === 'repair'
            ? 'Applies the verified identity plan (split, alias quarantine, attach or copy-only merge). User data stays on the verified identity.'
            : 'Persists the structure authority and runs the protected episode remap; user watches move with their episodes.',
      confirmLabel: 'Apply',
      onConfirm: () => runForTitle(tool, row.mediaId, 'apply'),
    });

  const latest = overview?.audit.latest;
  const previous = overview?.audit.previous ?? undefined;
  const auditJob = overview?.jobs.find((j) => j.name === 'identity_audit');

  return (
    <div className="space-y-4 rounded-lg border border-blue-200 p-4 dark:border-blue-900">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-medium">Data identity</h2>
          <p className="text-xs text-zinc-500">
            Defects that corrupt users’ libraries, ranked by user impact. Snapshot:{' '}
            {when(overview?.audit.latestAt ?? null)}
            {overview?.audit.previousAt && <> · compared with {when(overview.audit.previousAt)}</>}
            {auditJob && !auditJob.enabled && ' · daily audit job disabled (Scheduled Jobs)'}
          </p>
        </div>
        <button onClick={runAudit} disabled={auditing} className={btn}>
          {auditing ? 'Auditing…' : 'Run audit now'}
        </button>
      </div>

      {!latest ? (
        <p className="text-sm text-zinc-500">
          No snapshot yet — run the audit (read-only, a few seconds).
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-zinc-400">
              <tr>
                <th className="py-1 pr-3">Defect</th>
                <th className="py-1 pr-3 text-right">Total</th>
                <th className="py-1 pr-3 text-right">With users</th>
                <th className="py-1 pr-3 text-right">Change</th>
                <th className="py-1" />
              </tr>
            </thead>
            <tbody>
              {METRICS.map((m) => {
                const total = m.total(latest);
                const users = m.users?.(latest);
                return (
                  <tr
                    key={m.label}
                    className="border-t border-zinc-100 align-top dark:border-zinc-800"
                  >
                    <td className="py-2 pr-3">
                      <span className="font-medium">{m.label}</span>
                      <p className="max-w-xl text-xs text-zinc-500">{m.hint}</p>
                    </td>
                    <td className="py-2 pr-3 text-right font-mono">{total.toLocaleString()}</td>
                    <td className="py-2 pr-3 text-right font-mono">
                      {users === undefined ? (
                        '—'
                      ) : (
                        <span className={users > 0 ? 'text-amber-600 dark:text-amber-400' : ''}>
                          {users.toLocaleString()}
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-right font-mono text-xs">
                      {previous ? delta(total, m.total(previous)) : '—'}
                    </td>
                    <td className="py-2 text-right">
                      {m.kind && (
                        <button onClick={() => loadSamples(m.kind!)} className={btn}>
                          Show titles
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              <tr className="border-t border-zinc-100 dark:border-zinc-800">
                <td className="py-2 pr-3 font-medium">
                  Merged duplicates (active canonical links)
                </td>
                <td className="py-2 pr-3 text-right font-mono">
                  {(latest.canonicalLinksActive ?? 0).toLocaleString()}
                </td>
                <td />
                <td className="py-2 pr-3 text-right font-mono text-xs">
                  {previous ? (
                    <span className="text-green-600 dark:text-green-400">
                      {(latest.canonicalLinksActive ?? 0) - (previous.canonicalLinksActive ?? 0) >=
                      0
                        ? '+'
                        : ''}
                      {(latest.canonicalLinksActive ?? 0) - (previous.canonicalLinksActive ?? 0)}
                    </span>
                  ) : (
                    '—'
                  )}
                </td>
                <td />
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {kind && (
        <div className="rounded border border-zinc-200 p-3 dark:border-zinc-700">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-medium">
              {METRICS.find((m) => m.kind === kind)?.label} — top titles (users first)
            </h3>
            <button onClick={() => setKind(null)} className="text-xs text-zinc-500 hover:underline">
              Close
            </button>
          </div>
          {samplesLoading || !samples ? (
            <p className="text-xs text-zinc-500">Loading…</p>
          ) : samples.length === 0 ? (
            <p className="text-xs text-zinc-500">Nothing left here.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-left uppercase tracking-wide text-zinc-400">
                  <tr>
                    <th className="py-1 pr-2">Title</th>
                    <th className="py-1 pr-2 text-right">Users</th>
                    <th className="py-1 pr-2">Detail</th>
                    <th className="py-1" />
                  </tr>
                </thead>
                <tbody>
                  {samples.map((row) => {
                    const tool: Tool | null =
                      kind === 'duplicate-pairs' || kind === 'anime-missing-tvdb'
                        ? 'backlog'
                        : kind === 'no-structure-authority' || kind === 'legacy-unmapped'
                          ? 'structure'
                          : kind === 'type-mismatch' ||
                              kind === 'wrong-kind' ||
                              kind === 'multi-alias'
                            ? 'repair'
                            : null;
                    const check = tool ? checks[`${tool}:${row.mediaId}`] : undefined;
                    const result = check && check !== 'running' ? check : null;
                    const outcome = result?.samples[0] ?? null;
                    const actionable =
                      !!outcome &&
                      result?.mode === 'dry-run' &&
                      [
                        'attach',
                        'consolidate',
                        'repaired',
                        'decided',
                        'migrated',
                        'tvdb-only-refresh',
                      ].includes((outcome.action ?? outcome.outcome) as string);
                    return (
                      <tr
                        key={row.mediaId + (row.otherMediaId ?? '')}
                        className="border-t border-zinc-100 align-top dark:border-zinc-800"
                      >
                        <td className="py-1.5 pr-2">
                          <span className="font-medium">{row.title}</span>
                          {row.otherTitle && (
                            <span className="text-zinc-500"> ↔ {row.otherTitle}</span>
                          )}
                          <p className="font-mono text-[10px] text-zinc-400">
                            {row.mediaId}
                            {row.otherMediaId && ` ↔ ${row.otherMediaId}`}
                          </p>
                        </td>
                        <td className="py-1.5 pr-2 text-right font-mono">{row.users}</td>
                        <td className="max-w-md py-1.5 pr-2 text-zinc-500">
                          {row.detail}
                          {result && (
                            <p className="mt-1 text-zinc-700 dark:text-zinc-300">
                              {result.mode === 'apply' ? 'Applied: ' : 'Dry-run: '}
                              {outcome
                                ? `${outcome.action ?? outcome.outcome}${outcome.tier ? ` (tier ${outcome.tier})` : ''} — ${outcome.reason ?? outcome.detail ?? ''}`
                                : Object.entries(result.counts)
                                    .filter(([, n]) => n > 0)
                                    .map(([k, n]) => `${k} ${n}`)
                                    .join(', ') || 'nothing to do'}
                            </p>
                          )}
                        </td>
                        <td className="whitespace-nowrap py-1.5 text-right">
                          {tool && (
                            <div className="flex justify-end gap-1">
                              <button
                                onClick={() => runForTitle(tool, row.mediaId, 'dry-run')}
                                disabled={check === 'running'}
                                className={btn}
                              >
                                {check === 'running' ? '…' : 'Check'}
                              </button>
                              {actionable && (
                                <button
                                  onClick={() => confirmApply(tool, row)}
                                  className={btnDanger}
                                >
                                  Apply
                                </button>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <MaintenanceStatus
        job={overview?.jobs.find((j) => j.name === 'identity_maintenance')}
        onStarted={loadOverview}
      />

      {budget?.configured && budget.limit !== undefined && (
        <p className="text-xs text-zinc-500">
          WatchForge today:{' '}
          <span className="font-mono">
            {budget.used ?? 0} / {budget.limit}
          </span>
          {budget.byLane &&
            ` · ${Object.entries(budget.byLane)
              .map(([lane, n]) => `${lane} ${n}`)
              .join(' · ')}`}
          {budget.providerRemaining != null &&
            ` · provider reports ${budget.providerRemaining} left`}
          {!budget.enabled && ' · disabled'} — details on Metadata Providers.
        </p>
      )}
    </div>
  );
}

/** The nightly identity_maintenance job: state, last report, and a manual trigger. */
function MaintenanceStatus({ job, onStarted }: { job?: JobState; onStarted: () => void }) {
  const [starting, setStarting] = useState(false);
  const last = job?.lastResult ?? null;
  const summary = last
    ? Object.entries(last)
        .filter(([, v]) => typeof v === 'number' && v > 0)
        .map(([k, v]) => `${k} ${v}`)
        .join(' · ') || 'nothing to do'
    : null;

  const runNow = async () => {
    setStarting(true);
    try {
      await api.post('/admin/cron/identity_maintenance/trigger');
      onStarted();
    } catch (e: any) {
      showError({
        title: 'Could not start identity maintenance',
        description: e?.response?.data?.message ?? 'Try again.',
      });
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="rounded border border-zinc-200 p-3 dark:border-zinc-700">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Identity maintenance (automatic)</h3>
        <div className="flex items-center gap-2">
          {job && (
            <Badge color={job.enabled ? 'success' : 'warning'}>
              {job.enabled ? `on · ${job.schedule}` : 'off — enable it in Scheduled Jobs'}
            </Badge>
          )}
          <button onClick={runNow} disabled={starting || !job} className={btn}>
            {starting ? 'Starting…' : 'Run now'}
          </button>
        </div>
      </div>
      <p className="mb-2 text-xs text-zinc-500">
        Each run repairs rows with inconsistent ids (verified plans only), attaches provider-proven
        ids and merges proven duplicates copy-only, then decides each show’s episode-list source.
        Users first; every run stops at its time budget and resumes where it left off. Mode, steps
        and time budget are under Options in Scheduled Jobs.
      </p>
      {job && (
        <p className="text-xs text-zinc-400">
          Last run: {when(job.lastRunAt)}
          {last?.mode ? ` · ${String(last.mode)}` : ''}
          {summary ? ` · ${summary}` : ''}
          {job.lastError && ` · error: ${job.lastError}`}
        </p>
      )}
    </div>
  );
}
