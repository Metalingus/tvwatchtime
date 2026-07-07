'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { Badge } from '@/components/ui';
import { useAuth } from '@/lib/auth';

export default function UserDetailPage() {
  const { id } = useParams();
  const router = useRouter();
  const { user: me } = useAuth();
  const [user, setUser] = useState<any>(null);
  const [editRole, setEditRole] = useState(false);
  const [selectedRole, setSelectedRole] = useState('');
  const [sendingPush, setSendingPush] = useState(false);
  const [pushResult, setPushResult] = useState<string | null>(null);

  useEffect(() => { if (id) api.get(`/admin/users/${id}`).then((r) => { setUser(r.data); setSelectedRole(r.data.role); }); }, [id]);

  const saveRole = async () => {
    await api.patch(`/admin/users/${id}`, { role: selectedRole });
    setUser({ ...user, role: selectedRole });
    setEditRole(false);
  };

  const toggleSuspend = async () => {
    await api.patch(`/admin/users/${id}`, { isSuspended: !user.isSuspended });
    setUser({ ...user, isSuspended: !user.isSuspended });
  };

  const sendTestPush = async () => {
    setSendingPush(true);
    setPushResult(null);
    try {
      const res = await api.post(`/admin/users/${id}/test-push`);
      setPushResult(res.data?.sent ? `Push sent to ${res.data.devices} device(s)` : 'No registered devices');
    } catch (e: any) {
      setPushResult(e?.response?.data?.message || 'Push failed');
    } finally {
      setSendingPush(false);
    }
  };

  if (!user) return <div className="text-white/40 text-center py-20">Loading...</div>;

  return (
    <div className="space-y-6">
      <button onClick={() => router.push('/users')} className="text-sm text-white/40 hover:text-white">← Back to Users</button>

      {/* Profile header */}
      <div className="bg-surface rounded-xl p-6 border border-border flex items-start gap-5">
        <div className="w-16 h-16 rounded-full bg-surface-alt flex items-center justify-center text-2xl font-bold text-accent">
          {user.username[0]?.toUpperCase()}
        </div>
        <div className="flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold">{user.username}</h1>
            <Badge color={user.role === 'SUPER_ADMIN' ? 'danger' : user.role === 'ADMIN' ? 'accent' : user.role === 'USER' ? 'default' : 'info'}>{user.role}</Badge>
            {user.isSuspended ? <Badge color="danger">Suspended</Badge> : <Badge color="success">Active</Badge>}
          </div>
          <div className="text-sm text-white/40 mt-1">{user.email}</div>
          <div className="text-xs text-white/30 mt-1">Joined {new Date(user.createdAt).toLocaleDateString()} · Email verified: {user.emailVerified ? '✓' : '✗'}</div>
        </div>
        {me?.role === 'ADMIN' || me?.role === 'SUPER_ADMIN' ? (
          <div className="flex gap-2">
            <button onClick={() => setEditRole(!editRole)} className="px-3 py-1.5 bg-surface-alt rounded-lg text-sm text-accent border border-border hover:border-accent">Edit Role</button>
            <button onClick={toggleSuspend} className={`px-3 py-1.5 rounded-lg text-sm border ${user.isSuspended ? 'text-success border-success/30 bg-success/10' : 'text-danger border-danger/30 bg-danger/10'}`}>
              {user.isSuspended ? 'Unsuspend' : 'Suspend'}
            </button>
          </div>
        ) : null}
      </div>

      {/* Role editor */}
      {editRole ? (
        <div className="bg-surface rounded-xl p-5 border border-border flex items-center gap-3">
          <select value={selectedRole} onChange={(e) => setSelectedRole(e.target.value)} className="px-3 py-2 bg-surface-alt rounded-lg border border-border text-white text-sm">
            {['USER','VIEWER','SUPPORT','CONTENT_MANAGER','MODERATOR','ADMIN','SUPER_ADMIN'].map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <button onClick={saveRole} className="px-4 py-2 bg-accent text-bg font-bold rounded-lg text-sm">Save</button>
          <button onClick={() => setEditRole(false)} className="px-4 py-2 bg-surface-alt text-white/60 rounded-lg text-sm">Cancel</button>
        </div>
      ) : null}

      {/* Stats grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
        <StatBox label="Shows" value={user._count?.showStatuses || 0} />
        <StatBox label="Movies" value={user._count?.movieStatuses || 0} />
        <StatBox label="Watch Events" value={user._count?.watchHistory || 0} />
        <StatBox label="Comments" value={user._count?.comments || 0} />
        <StatBox label="Likes Given" value={user._count?.commentLikes || 0} />
        <StatBox label="Favorites" value={user._count?.favorites || 0} />
        <StatBox label="Watchlist" value={user._count?.watchlist || 0} />
        <StatBox label="Custom Lists" value={user._count?.lists || 0} />
        <StatBox label="Notifications" value={user._count?.notifications || 0} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Auth providers */}
        <div className="bg-surface rounded-xl p-5 border border-border">
          <div className="text-sm font-semibold text-white/70 mb-3">Auth Providers</div>
          <div className="space-y-2">
            {user.authProviders?.map((p: any) => (
              <div key={p.id} className="flex items-center justify-between text-sm">
                <Badge color="info">{p.provider}</Badge>
                <span className="text-white/30 text-xs font-mono">{p.providerUid.slice(0, 16)}…</span>
              </div>
            )) || <span className="text-white/30 text-sm">None</span>}
          </div>
          <div className="text-sm font-semibold text-white/70 mt-4 mb-2">Devices</div>
          <div className="text-sm text-white/40 mb-3">{user.devices?.length || 0} device(s) registered</div>
          {/* Test push */}
          {me?.role === 'ADMIN' || me?.role === 'SUPER_ADMIN' ? (
            <div className="border-t border-border pt-3 mt-3">
              <button
                onClick={sendTestPush}
                disabled={sendingPush}
                className="px-3 py-1.5 bg-surface-alt rounded-lg text-sm text-accent border border-border hover:border-accent disabled:opacity-50"
              >
                {sendingPush ? 'Sending...' : '🔔 Send Test Push'}
              </button>
              {pushResult ? (
                <div className={`text-xs mt-2 px-3 py-1.5 rounded-lg ${pushResult.includes('failed') || pushResult.includes('No') ? 'bg-danger/10 text-danger' : 'bg-success/10 text-success'}`}>
                  {pushResult}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* Recent activity */}
        <div className="bg-surface rounded-xl p-5 border border-border">
          <div className="text-sm font-semibold text-white/70 mb-3">Recent Activity</div>
          <div className="space-y-2">
            {user.recentActivity?.map((a: any) => (
              <div key={a.id} className="flex items-center gap-3 py-1.5 border-b border-border/50 last:border-0">
                {a.media?.posterUrl ? <img src={a.media.posterUrl} alt="" className="w-6 h-9 rounded object-cover" /> : <div className="w-6 h-9 rounded bg-surface-alt" />}
                <div className="flex-1 min-w-0">
                  <div className="text-sm truncate">{a.media?.title || 'Unknown'}</div>
                  <div className="text-xs text-white/30">{a.mediaType} {a.seasonNumber ? `S${a.seasonNumber}E${a.episodeNumber}` : ''}</div>
                </div>
                <div className="text-xs text-white/30 whitespace-nowrap">{new Date(a.watchedAt).toLocaleDateString()}</div>
              </div>
            )) || <span className="text-white/30 text-sm">No recent activity</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

function StatBox({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-surface rounded-xl p-4 border border-border">
      <div className="text-xs text-white/40 uppercase">{label}</div>
      <div className="text-xl font-bold text-accent mt-1">{value.toLocaleString()}</div>
    </div>
  );
}
