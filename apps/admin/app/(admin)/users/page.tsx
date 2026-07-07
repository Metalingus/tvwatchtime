'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { Badge, Table, SearchInput, Pagination } from '@/components/ui';
import { useAuth } from '@/lib/auth';

const ROLES = ['USER', 'VIEWER', 'SUPPORT', 'CONTENT_MANAGER', 'MODERATOR', 'ADMIN', 'SUPER_ADMIN'];

export default function UsersPage() {
  const router = useRouter();
  const { user: me } = useAuth();
  const [data, setData] = useState<any>(null);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [editUser, setEditUser] = useState<any>(null);

  const load = () => {
    const params: any = { page, pageSize: 50 };
    if (search) params.search = search;
    api.get('/admin/users', { params }).then((r) => setData(r.data));
  };
  useEffect(load, [page, search]);

  const updateRole = async (userId: string, role: string) => {
    await api.patch(`/admin/users/${userId}`, { role });
    setEditUser(null); load();
  };

  const toggleSuspend = async (userId: string, current: boolean) => {
    await api.patch(`/admin/users/${userId}`, { isSuspended: !current });
    load();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Users</h1>
        <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1); }} placeholder="Search username/email..." />
      </div>

      {data ? (
        <>
          <Table headers={['User', 'Email', 'Role', 'Shows', 'Movies', 'Watch Events', 'Comments', 'Status', 'Actions']}>
            {data.items.map((u: any) => (
              <tr key={u.id} className="border-b border-border/50 hover:bg-surface-alt/30 cursor-pointer" onClick={() => router.push(`/users/${u.id}`)}>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-full bg-surface-alt flex items-center justify-center text-xs font-bold text-accent">{u.username[0]?.toUpperCase()}</div>
                    <span className="text-sm font-medium text-accent hover:underline">{u.username}</span>
                  </div>
                </td>
                <td className="px-4 py-3 text-sm text-white/40">{u.email}</td>
                <td className="px-4 py-3"><Badge color={u.role === 'SUPER_ADMIN' ? 'danger' : u.role === 'ADMIN' ? 'accent' : u.role === 'USER' ? 'default' : 'info'}>{u.role}</Badge></td>
                <td className="px-4 py-3 text-sm">{u._count?.showStatuses || 0}</td>
                <td className="px-4 py-3 text-sm">{u._count?.movieStatuses || 0}</td>
                <td className="px-4 py-3 text-sm">{u._count?.watchHistory || 0}</td>
                <td className="px-4 py-3 text-sm">{u._count?.comments || 0}</td>
                <td className="px-4 py-3">{u.isSuspended ? <Badge color="danger">Suspended</Badge> : <Badge color="success">Active</Badge>}</td>
                <td className="px-4 py-3">
                  <div className="flex gap-2">
                    <button onClick={() => setEditUser(u)} className="text-xs text-accent hover:underline">Edit</button>
                    {me?.role === 'ADMIN' || me?.role === 'SUPER_ADMIN' ? (
                      <button onClick={() => toggleSuspend(u.id, u.isSuspended)} className={`text-xs hover:underline ${u.isSuspended ? 'text-success' : 'text-danger'}`}>{u.isSuspended ? 'Unsuspend' : 'Suspend'}</button>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </Table>
          <Pagination page={page} total={data.total} pageSize={50} onPage={setPage} />
        </>
      ) : <div className="text-white/40 text-center py-20">Loading...</div>}

      {/* Edit role modal */}
      {editUser ? (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={() => setEditUser(null)}>
          <div className="bg-surface rounded-xl p-6 border border-border w-80" onClick={(e) => e.stopPropagation()}>
            <div className="text-lg font-bold mb-4">Edit {editUser.username}</div>
            <div className="text-xs text-white/40 mb-2">Role</div>
            <select
              value={editUser.role}
              onChange={(e) => setEditUser({ ...editUser, role: e.target.value })}
              className="w-full px-3 py-2 bg-surface-alt rounded-lg border border-border text-white text-sm mb-4"
            >
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <div className="flex gap-2">
              <button onClick={() => updateRole(editUser.id, editUser.role)} className="flex-1 py-2 bg-accent text-bg font-bold rounded-lg text-sm">Save</button>
              <button onClick={() => setEditUser(null)} className="px-4 py-2 bg-surface-alt text-white/60 rounded-lg text-sm">Cancel</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
