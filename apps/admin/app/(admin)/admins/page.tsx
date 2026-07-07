'use client';

import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import { Badge, Table, SearchInput, Pagination } from '@/components/ui';

export default function AdminsPage() {
  const [admins, setAdmins] = useState<any[]>([]);
  const [logs, setLogs] = useState<any>(null);
  const [page, setPage] = useState(1);

  useEffect(() => { api.get('/admin/admins').then((r) => setAdmins(r.data)); }, []);
  useEffect(() => { api.get('/admin/audit-logs', { params: { page, pageSize: 30 } }).then((r) => setLogs(r.data)); }, [page]);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold mb-4">Admin Team</h1>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {admins.map((a: any) => (
            <div key={a.id} className="bg-surface rounded-xl p-5 border border-border flex items-center gap-4">
              <div className="w-12 h-12 rounded-full bg-surface-alt flex items-center justify-center text-lg font-bold text-accent">
                {a.username[0]?.toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{a.username}</div>
                <div className="text-xs text-white/40 truncate">{a.email}</div>
                <Badge color={a.role === 'SUPER_ADMIN' ? 'danger' : a.role === 'ADMIN' ? 'accent' : 'info'}>{a.role}</Badge>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <h2 className="text-lg font-bold mb-4">Audit Trail</h2>
        {logs ? (
          <>
            <Table headers={['Admin', 'Action', 'Target', 'Time']}>
              {logs.items.map((l: any) => (
                <tr key={l.id} className="border-b border-border/50">
                  <td className="px-4 py-3 text-sm">{l.adminId.slice(-8)}</td>
                  <td className="px-4 py-3 text-sm font-mono">{l.action}</td>
                  <td className="px-4 py-3 text-sm text-white/40">{l.targetType ? `${l.targetType}:${l.targetId?.slice(-8)}` : '—'}</td>
                  <td className="px-4 py-3 text-xs text-white/30">{new Date(l.createdAt).toLocaleString()}</td>
                </tr>
              ))}
            </Table>
            <Pagination page={page} total={logs.total} pageSize={30} onPage={setPage} />
          </>
        ) : <div className="text-white/40 text-center py-10">Loading...</div>}
      </div>
    </div>
  );
}
