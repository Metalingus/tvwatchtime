'use client';

import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { Badge } from '@/components/ui';
import { LocaleFields, ActionConfig, type LocaleMap, type ActionState } from '@/components/announcement-fields';

interface BroadcastRow {
  id: string;
  title: LocaleMap;
  body: LocaleMap | null;
  category: string;
  actionTarget: string | null;
  inApp: boolean;
  totalRecipients: number;
  sentCount: number;
  failedCount: number;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  createdAt: string;
}

const emptyForm = () => ({
  title: { en: '' } as LocaleMap,
  body: { en: '' } as LocaleMap,
  action: { target: 'none', params: {} } as ActionState,
  inApp: false,
});

export default function BroadcastPage() {
  const { user } = useAuth();
  const canEdit = user?.role && ['ADMIN', 'SUPER_ADMIN'].includes(user.role);
  const [items, setItems] = useState<BroadcastRow[]>([]);
  const [form, setForm] = useState<ReturnType<typeof emptyForm>>(emptyForm());
  const [sending, setSending] = useState(false);
  const [polling, setPolling] = useState<string | null>(null);

  const load = () => api.get('/admin/broadcasts').then((r) => setItems(r.data));
  useEffect(() => {
    load();
    if (polling) {
      const t = setInterval(() => load(), 3000);
      return () => clearInterval(t);
    }
  }, [polling]);

  const send = async () => {
    if (!form.title.en?.trim()) { alert('English title is required.'); return; }
    if (!confirm('Send this broadcast push to ALL users now? This cannot be undone.')) return;
    setSending(true);
    try {
      const res = await api.post('/admin/broadcasts', {
        title: form.title,
        body: form.body,
        actionTarget: form.action.target,
        actionParams: form.action.params,
        inApp: form.inApp,
        category: 'ANNOUNCEMENT',
      });
      setPolling(res.data.broadcastId);
      setForm(emptyForm());
      load();
    } finally {
      setSending(false);
    }
  };

  const stopPoll = () => setPolling(null);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Broadcast</h1>
        <div className="text-sm text-white/40 mt-1">Send a push notification to all users at once. Push is primary; in-app notifications are optional.</div>
      </div>

      {canEdit ? (
        <div className="bg-surface rounded-xl p-5 border border-border space-y-4">
          <div className="text-sm font-semibold text-white/70">New broadcast</div>
          <LocaleFields label="Title" value={form.title} onChange={(v) => setForm({ ...form, title: v })} />
          <LocaleFields label="Body" value={form.body} onChange={(v) => setForm({ ...form, body: v })} optional multiline />
          <ActionConfig value={form.action} onChange={(v) => setForm({ ...form, action: v })} />
          <label className="flex items-center gap-2 text-sm text-white/60">
            <input type="checkbox" checked={form.inApp} onChange={(e) => setForm({ ...form, inApp: e.target.checked })} />
            Also create in-app notifications (visible in the Notifications screen)
          </label>
          <div className="text-xs text-white/30 bg-surface-alt/50 rounded-lg px-4 py-2">
            Bypasses the per-user daily push limit. Honors a user's ANNOUNCEMENT-category opt-out.
          </div>
          <button onClick={send} disabled={sending} className="px-4 py-2 bg-danger text-white font-bold rounded-lg text-sm disabled:opacity-50">
            {sending ? 'Sending...' : '📡 Send to all users'}
          </button>
        </div>
      ) : null}

      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-white/70">History</div>
        {polling ? (
          <button onClick={stopPoll} className="text-xs text-white/40 hover:text-white">Stop auto-refresh</button>
        ) : null}
      </div>

      {items.length === 0 ? (
        <div className="bg-surface rounded-xl p-8 border border-border text-center text-white/40 text-sm">No broadcasts yet.</div>
      ) : (
        <div className="space-y-3">
          {items.map((b) => (
            <div key={b.id} className="bg-surface rounded-xl p-5 border border-border">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold truncate">{b.title?.en ?? '(no title)'}</span>
                    <StatusBadge status={b.status} />
                    {b.inApp ? <Badge color="info">In-app</Badge> : null}
                  </div>
                  {b.body?.en ? <div className="text-sm text-white/50 mt-1 line-clamp-2">{b.body.en}</div> : null}
                  <div className="flex flex-wrap gap-3 mt-2 text-xs text-white/30">
                    <span>Sent: {b.sentCount}</span>
                    <span>Failed: {b.failedCount}</span>
                    <span>Recipients: {b.totalRecipients}</span>
                    <span>Target: {b.actionTarget ?? 'none'}</span>
                    <span>Created: {new Date(b.createdAt).toLocaleString()}</span>
                  </div>
                  {b.error ? <div className="text-xs text-danger mt-2">Error: {b.error}</div> : null}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const color = status === 'completed' ? 'success' : status === 'failed' ? 'danger' : status === 'running' ? 'accent' : 'default';
  return <Badge color={color}>{status}</Badge>;
}
