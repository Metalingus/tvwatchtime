'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { Badge, Pagination, SearchInput, Table } from '@/components/ui';

const STATUSES = [
  '',
  'READY_FOR_REVIEW',
  'UPLOADED',
  'QUEUED',
  'EXTRACTING',
  'PARSING',
  'NORMALIZING',
  'MATCHING',
  'IMPORTING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'ROLLED_BACK',
];

const badgeColor = (status: string) => {
  if (status === 'COMPLETED') return 'success';
  if (status === 'FAILED' || status === 'CANCELLED') return 'danger';
  if (status === 'READY_FOR_REVIEW') return 'warning';
  if (status === 'IMPORTING' || status === 'MATCHING') return 'accent';
  return 'default';
};

const label = (value: string) => value.replace(/_/g, ' ').toLowerCase();

export default function ImportsPage() {
  const router = useRouter();
  const [data, setData] = useState<any>(null);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');

  const load = () => {
    setError('');
    const params: Record<string, string | number> = { page, pageSize: 50 };
    if (search) params.search = search;
    if (status) params.status = status;
    api
      .get('/admin/imports', { params })
      .then((response) => setData(response.data))
      .catch((requestError) => {
        setError(requestError.response?.data?.message ?? 'Could not load user imports.');
      });
  };

  useEffect(load, [page, search, status]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">User Imports</h1>
          <p className="mt-1 text-sm text-white/40">
            Review imports exactly as the user sees them, resolve matches, and apply on their
            behalf.
          </p>
        </div>
        <div className="flex gap-2">
          <SearchInput
            value={search}
            onChange={(value) => {
              setSearch(value);
              setPage(1);
            }}
            placeholder="Search user or filename..."
          />
          <select
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setPage(1);
            }}
            className="rounded-lg border border-border bg-surface-alt px-3 py-2 text-sm text-white focus:border-accent focus:outline-none"
          >
            {STATUSES.map((value) => (
              <option key={value || 'all'} value={value}>
                {value ? label(value) : 'all statuses'}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error ? (
        <div className="rounded-xl border border-danger/30 bg-danger/10 p-4 text-sm text-danger">
          {error}
        </div>
      ) : null}

      {data ? (
        <>
          <Table
            headers={[
              'User',
              'Source',
              'Status',
              'Progress',
              'Matched',
              'Needs review',
              'Unmatched',
              'Created',
            ]}
          >
            {data.items.map((item: any) => (
              <tr
                key={item.id}
                onClick={() => router.push(`/imports/${item.id}`)}
                className="cursor-pointer border-b border-border/50 hover:bg-surface-alt/30"
              >
                <td className="px-4 py-3">
                  <div className="text-sm font-medium text-accent">{item.user.username}</div>
                  <div className="text-xs text-white/30">{item.user.email}</div>
                </td>
                <td className="max-w-64 px-4 py-3">
                  <div className="truncate text-sm">{item.originalFilename || 'Unknown file'}</div>
                  <div className="text-xs uppercase text-white/30">{item.format}</div>
                </td>
                <td className="px-4 py-3">
                  <Badge color={badgeColor(item.status)}>{label(item.status)}</Badge>
                </td>
                <td className="px-4 py-3 text-sm">{item.progress}%</td>
                <td className="px-4 py-3 text-sm text-success">{item.matchedCount}</td>
                <td className="px-4 py-3 text-sm text-warning">{item.needsReviewCount}</td>
                <td className="px-4 py-3 text-sm text-white/50">{item.unmatchedCount}</td>
                <td className="px-4 py-3 text-xs text-white/40">
                  {new Date(item.createdAt).toLocaleString()}
                </td>
              </tr>
            ))}
          </Table>
          {data.items.length === 0 ? (
            <div className="py-16 text-center text-sm text-white/40">No imports found.</div>
          ) : null}
          <Pagination page={page} total={data.total} pageSize={50} onPage={setPage} />
        </>
      ) : (
        <div className="py-20 text-center text-white/40">Loading imports...</div>
      )}
    </div>
  );
}
