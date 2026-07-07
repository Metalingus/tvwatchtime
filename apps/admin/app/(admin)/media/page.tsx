'use client';

import { useState, useEffect } from 'react';
import { api } from '@/lib/api';
import { Badge, Table, SearchInput, Pagination } from '@/components/ui';

export default function MediaPage() {
  const [data, setData] = useState<any>(null);
  const [search, setSearch] = useState('');
  const [type, setType] = useState('');
  const [page, setPage] = useState(1);

  useEffect(() => {
    const params: any = { page, pageSize: 50 };
    if (type) params.type = type;
    if (search) params.search = search;
    api.get('/admin/media', { params }).then((r) => setData(r.data));
  }, [page, type, search]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Media</h1>
        <div className="flex gap-3">
          <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1); }} placeholder="Search title..." />
          <select value={type} onChange={(e) => { setType(e.target.value); setPage(1); }} className="px-3 py-2 bg-surface-alt rounded-lg border border-border text-white text-sm">
            <option value="">All</option>
            <option value="SHOW">Shows</option>
            <option value="MOVIE">Movies</option>
          </select>
        </div>
      </div>

      {data ? (
        <>
          <Table headers={['', 'Title', 'Type', 'TMDb', 'Status', 'Tracked', 'Watched', 'Popularity']}>
            {data.items.map((m: any) => (
              <tr key={m.id} className="border-b border-border/50 hover:bg-surface-alt/30 transition cursor-pointer" onClick={() => window.open(`/media/${m.id}`, '_self')}>
                <td className="px-4 py-3">{m.posterUrl ? <img src={m.posterUrl} alt="" className="w-8 h-12 rounded object-cover" /> : <div className="w-8 h-12 rounded bg-surface-alt" />}</td>
                <td className="px-4 py-3 text-sm font-medium">{m.title}</td>
                <td className="px-4 py-3"><Badge color={m.type === 'SHOW' ? 'info' : 'accent'}>{m.type}</Badge></td>
                <td className="px-4 py-3 text-sm text-white/40">{m.externalIds?.find((e: any) => e.provider === 'TMDB')?.value || '—'}</td>
                <td className="px-4 py-3"><Badge color={m.status === 'RETURNING' ? 'success' : m.status === 'ENDED' ? 'default' : 'warning'}>{m.status || '—'}</Badge></td>
                <td className="px-4 py-3 text-sm text-accent font-bold">{m._count?.watchlist || 0}</td>
                <td className="px-4 py-3 text-sm text-white/60">{m._count?.favorites || 0}</td>
                <td className="px-4 py-3 text-sm text-white/40">{Math.round(m.popularity)}</td>
              </tr>
            ))}
          </Table>
          <Pagination page={page} total={data.total} pageSize={50} onPage={setPage} />
        </>
      ) : <div className="text-white/40 text-center py-20">Loading...</div>}
    </div>
  );
}
