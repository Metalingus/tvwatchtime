'use client';

import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import { Table, Pagination } from '@/components/ui';

export default function LogsPage() {
  const [data, setData] = useState<any>(null);
  const [page, setPage] = useState(1);

  useEffect(() => {
    api.get('/admin/audit-logs', { params: { page, pageSize: 50 } }).then((r) => setData(r.data));
  }, [page]);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Audit Logs</h1>
      {data ? (
        <>
          <Table headers={['Time', 'Admin', 'Action', 'Target Type', 'Target ID', 'Metadata']}>
            {data.items.map((l: any) => (
              <tr key={l.id} className="border-b border-border/50 hover:bg-surface-alt/30">
                <td className="px-4 py-3 text-xs text-white/30 whitespace-nowrap">{new Date(l.createdAt).toLocaleString()}</td>
                <td className="px-4 py-3 text-sm font-mono text-white/40">{l.adminId?.slice(-8)}</td>
                <td className="px-4 py-3 text-sm font-medium text-accent">{l.action}</td>
                <td className="px-4 py-3 text-sm text-white/40">{l.targetType || '—'}</td>
                <td className="px-4 py-3 text-sm font-mono text-white/40">{l.targetId?.slice(-8) || '—'}</td>
                <td className="px-4 py-3 text-xs text-white/30 font-mono max-w-xs truncate">{l.metadata ? JSON.stringify(l.metadata) : '—'}</td>
              </tr>
            ))}
          </Table>
          <Pagination page={page} total={data.total} pageSize={50} onPage={setPage} />
        </>
      ) : <div className="text-white/40 text-center py-20">Loading...</div>}
    </div>
  );
}
