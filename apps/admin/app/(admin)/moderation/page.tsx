'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import Link from 'next/link';
import { showConfirm, showError } from '@/lib/dialog';

type Tab = 'comments' | 'images' | 'users';

export default function ModerationPage() {
  const [tab, setTab] = useState<Tab>('comments');
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = async (t: Tab) => {
    setTab(t);
    setLoading(true);
    setError('');
    try {
      const res = await api.get(`/admin/moderation/reported-${t}`);
      setData(res.data);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  useState(() => { load('comments'); });

  const deleteComment = (id: string) => {
    showConfirm({
      title: 'Delete comment?',
      description: 'This hides it from all users.',
      confirmLabel: 'Delete',
      destructive: true,
      onConfirm: async () => {
        try {
          await api.delete(`/admin/moderation/comments/${id}`);
          load(tab);
        } catch {
          showError({ description: 'Failed to delete' });
        }
      },
    });
  };

  const dismiss = async (targetType: string, targetId: string) => {
    try {
      await api.post(`/admin/moderation/dismiss`, { targetType, targetId });
      load(tab);
    } catch {
      showError({ description: 'Failed to dismiss' });
    }
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-white">Moderation</h1>

      {/* Tabs */}
      <div className="flex gap-2">
        {(['comments', 'images', 'users'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => load(t)}
            className={`px-4 py-2 rounded-lg font-medium capitalize transition ${tab === t ? 'bg-accent text-bg' : 'bg-surface text-white/60 hover:text-white'}`}
          >
            Reported {t}
          </button>
        ))}
      </div>

      {loading && <div className="text-white/50">Loading…</div>}
      {error && <div className="text-danger">{error}</div>}

      {data?.items?.length === 0 && !loading && (
        <div className="text-white/40 text-center py-8">No reported {tab}.</div>
      )}

      {/* Reported Comments */}
      {tab === 'comments' && data?.items?.map((item: any) => (
        <div key={item.comment.id} className="bg-surface rounded-xl p-4 border border-border space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-danger font-bold">🚨 {item.reportCount} reports</span>
              <span className="text-white/40 text-sm">· {item.reasons.join(', ')}</span>
            </div>
            <span className="text-white/30 text-xs">{new Date(item.comment.createdAt).toLocaleDateString()}</span>
          </div>
          <div className="flex items-start gap-3">
            <div className="flex-1">
              <div className="text-sm text-white/50">
                By <Link href={`/users/${item.comment.userId}`} className="text-accent hover:underline">@{item.comment.user?.username}</Link>
              </div>
              <p className="text-white mt-1">{item.comment.body}</p>
              {item.comment.imageUrl && (
                <div className="mt-2 text-white/40 text-xs">📎 Has image attachment</div>
              )}
            </div>
          </div>
          <div className="flex gap-2 pt-2">
            <button onClick={() => deleteComment(item.comment.id)} className="px-3 py-1.5 bg-danger/20 text-danger rounded-lg text-sm font-medium hover:bg-danger/30">
              Delete Comment
            </button>
            <button onClick={() => dismiss('COMMENT', item.comment.id)} className="px-3 py-1.5 bg-surface-alt text-white/60 rounded-lg text-sm hover:text-white">
              Dismiss Reports
            </button>
          </div>
        </div>
      ))}

      {/* Reported Images */}
      {tab === 'images' && data?.items?.map((item: any) => (
        <div key={item.image.id} className="bg-surface rounded-xl p-4 border border-border space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-danger font-bold">🚨 {item.reportCount} reports</span>
              <span className="text-white/40 text-sm">· {item.reasons.join(', ')}</span>
            </div>
            <span className="text-white/30 text-xs">{new Date(item.image.createdAt).toLocaleDateString()}</span>
          </div>
          <div className="text-sm text-white/50">
            On comment by{' '}
            <Link href={`/users/${item.image.comment?.userId}`} className="text-accent hover:underline">
              @{item.image.comment?.user?.username}
            </Link>
          </div>
          <div className="text-white/40 text-xs">
            Image ID: {item.image.id} · Status: {item.image.status} · Decision: {item.image.moderationDecision ?? 'N/A'}
          </div>
          <div className="flex gap-2 pt-2">
            <button onClick={() => dismiss('IMAGE', item.image.id)} className="px-3 py-1.5 bg-surface-alt text-white/60 rounded-lg text-sm hover:text-white">
              Dismiss Reports
            </button>
          </div>
        </div>
      ))}

      {/* Reported Users */}
      {tab === 'users' && data?.items?.map((item: any) => (
        <div key={item.id} className="bg-surface rounded-xl p-4 border border-border space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-danger font-bold">🚨 {item.reportCount} reports</span>
              {item.deletedCommentCount > 0 && (
                <span className="text-orange-400 text-sm">· {item.deletedCommentCount} deleted comments</span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex-1">
              <Link href={`/users/${item.id}`} className="text-accent hover:underline font-medium">@{item.username}</Link>
              {item.displayName && <span className="text-white/40 text-sm ml-2">{item.displayName}</span>}
            </div>
          </div>
          <div className="flex gap-2 pt-2">
            <Link href={`/users/${item.id}`} className="px-3 py-1.5 bg-surface-alt text-white/60 rounded-lg text-sm hover:text-white">
              View Profile
            </Link>
            <button onClick={() => dismiss('USER', item.id)} className="px-3 py-1.5 bg-surface-alt text-white/60 rounded-lg text-sm hover:text-white">
              Dismiss Reports
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
