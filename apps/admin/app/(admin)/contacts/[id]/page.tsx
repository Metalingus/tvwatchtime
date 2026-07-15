'use client';

import { useState, useEffect, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { Badge } from '@/components/ui';

export default function ContactDetailPage() {
  const { id } = useParams();
  const router = useRouter();
  const [thread, setThread] = useState<any>(null);
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const load = () => {
    if (!id) return;
    api.get(`/admin/contacts/${id}`).then((r) => {
      setThread(r.data);
      setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
    });
  };
  useEffect(() => { load(); }, [id]);

  const send = async () => {
    if (!reply.trim()) return;
    setSending(true);
    try {
      await api.post(`/admin/contacts/${id}/messages`, { body: reply.trim() });
      setReply('');
      load();
    } finally {
      setSending(false);
    }
  };

  const close = async () => { setBusy(true); try { await api.post(`/admin/contacts/${id}/close`); load(); } finally { setBusy(false); } };
  const reopen = async () => { setBusy(true); try { await api.post(`/admin/contacts/${id}/reopen`); load(); } finally { setBusy(false); } };

  if (!thread) return <div className="text-white/40 text-center py-20">Loading...</div>;

  return (
    <div className="space-y-6">
      <button onClick={() => router.push('/contacts')} className="text-sm text-white/40 hover:text-white">← Back to Contact</button>

      <div className="bg-surface rounded-xl p-6 border border-border">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <h1 className="text-xl font-bold">{thread.subject}</h1>
            <div className="text-sm text-white/40 mt-1">
              {thread.user?.username ?? 'unknown'} {thread.user?.email ? `· ${thread.user.email}` : ''}
            </div>
            <div className="flex items-center gap-2 mt-2">
              <Badge color="info">{thread.reason}</Badge>
              {thread.status === 'CLOSED' ? <Badge>Closed</Badge> : <Badge color="success">Open</Badge>}
              <span className="text-xs text-white/30">Created {new Date(thread.createdAt).toLocaleString()}</span>
            </div>
          </div>
          {thread.status === 'OPEN' ? (
            <button onClick={close} disabled={busy} className="px-3 py-1.5 bg-surface-alt rounded-lg text-xs text-white/60 border border-border hover:text-white disabled:opacity-50">Close</button>
          ) : (
            <button onClick={reopen} disabled={busy} className="px-3 py-1.5 bg-surface-alt rounded-lg text-xs text-accent border border-border hover:border-accent disabled:opacity-50">Reopen</button>
          )}
        </div>
      </div>

      {/* Messages */}
      <div className="bg-surface rounded-xl p-5 border border-border space-y-3 max-h-[55vh] overflow-auto">
        {thread.messages?.map((m: any) => {
          const admin = m.authorRole === 'ADMIN';
          return (
            <div key={m.id} className={`flex ${admin ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[75%] px-4 py-2 rounded-2xl ${admin ? 'bg-accent text-bg' : 'bg-surface-alt text-white'}`}>
                <div className="text-xs opacity-60 mb-0.5">{admin ? 'Support' : thread.user?.username ?? 'User'} · {new Date(m.createdAt).toLocaleString()}</div>
                <div className="text-sm whitespace-pre-wrap">{m.body}</div>
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {/* Reply */}
      <div className="bg-surface rounded-xl p-4 border border-border">
        <textarea
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          placeholder="Type a reply — the user will be notified…"
          rows={3}
          className="w-full px-3 py-2 bg-surface-alt rounded-lg border border-border text-white text-sm focus:border-accent focus:outline-none resize-none"
        />
        <div className="flex justify-end mt-2">
          <button onClick={send} disabled={sending || !reply.trim()} className="px-4 py-2 bg-accent text-bg font-bold rounded-lg text-sm disabled:opacity-50">
            {sending ? 'Sending...' : 'Reply'}
          </button>
        </div>
      </div>
    </div>
  );
}
