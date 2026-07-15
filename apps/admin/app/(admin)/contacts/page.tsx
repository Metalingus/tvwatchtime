'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { Badge } from '@/components/ui';

const REASONS = ['FEEDBACK', 'BUG_REPORT', 'DATA', 'PERSONAL_INFO', 'ACCOUNT', 'OTHER'];

export default function ContactsPage() {
  const router = useRouter();
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');
  const [reason, setReason] = useState('');
  const [unreadOnly, setUnreadOnly] = useState(false);

  const load = () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (reason) params.set('reason', reason);
    if (unreadOnly) params.set('unread', 'true');
    api.get(`/admin/contacts?${params.toString()}`).then((r) => setItems(r.data?.items ?? [])).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, [status, reason, unreadOnly]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Contact</h1>
        <div className="text-sm text-white/40 mt-1">Support threads from users. Reply to notify them in-app.</div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2">
        <select value={status} onChange={(e) => setStatus(e.target.value)} className="px-3 py-2 bg-surface-alt rounded-lg border border-border text-white text-sm">
          <option value="">All status</option>
          <option value="OPEN">Open</option>
          <option value="CLOSED">Closed</option>
        </select>
        <select value={reason} onChange={(e) => setReason(e.target.value)} className="px-3 py-2 bg-surface-alt rounded-lg border border-border text-white text-sm">
          <option value="">All reasons</option>
          {REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <button onClick={() => setUnreadOnly(!unreadOnly)} className={`px-3 py-2 rounded-lg border text-sm ${unreadOnly ? 'bg-accent text-bg border-accent' : 'bg-surface-alt text-white/60 border-border'}`}>
          {unreadOnly ? '✓ Unread only' : 'Unread only'}
        </button>
      </div>

      {loading ? (
        <div className="text-white/40 text-center py-10">Loading...</div>
      ) : items.length === 0 ? (
        <div className="bg-surface rounded-xl p-8 border border-border text-center text-white/40 text-sm">No contact threads.</div>
      ) : (
        <div className="space-y-3">
          {items.map((t) => (
            <button key={t.id} onClick={() => router.push(`/contacts/${t.id}`)} className="w-full text-left bg-surface rounded-xl p-5 border border-border hover:border-accent transition">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-full bg-surface-alt flex items-center justify-center text-sm font-bold text-accent shrink-0">
                  {(t.user?.username?.[0] ?? '?').toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold truncate">{t.subject}</span>
                    {t.unreadForAdmin ? <Badge color="accent">Unread</Badge> : null}
                    {t.status === 'CLOSED' ? <Badge>Closed</Badge> : <Badge color="success">Open</Badge>}
                  </div>
                  <div className="text-xs text-white/40 mt-0.5">
                    {t.user?.username ?? 'unknown'} · {t.reason} · {new Date(t.lastMessageAt).toLocaleString()}
                  </div>
                  {t.lastMessagePreview ? <div className="text-sm text-white/50 mt-1 truncate">{t.lastMessagePreview}</div> : null}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
