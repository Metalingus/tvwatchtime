export function StatCard({ label, value, sub, color = 'text-white' }: { label: string; value: number | string; sub?: string; color?: string }) {
  return (
    <div className="bg-surface rounded-xl p-5 border border-border">
      <div className="text-xs text-white/40 uppercase tracking-wide">{label}</div>
      <div className={`text-3xl font-bold mt-2 ${color}`}>{typeof value === 'number' ? value.toLocaleString() : value}</div>
      {sub ? <div className="text-xs text-white/30 mt-1">{sub}</div> : null}
    </div>
  );
}

export function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-surface rounded-xl p-5 border border-border">
      <div className="text-sm font-semibold text-white/70 mb-4">{title}</div>
      {children}
    </div>
  );
}

export function Badge({ children, color = 'default' }: { children: React.ReactNode; color?: string }) {
  const colors: Record<string, string> = {
    default: 'bg-surface-alt text-white/60',
    success: 'bg-success/15 text-success',
    danger: 'bg-danger/15 text-danger',
    warning: 'bg-warning/15 text-warning',
    accent: 'bg-accent/15 text-accent',
    info: 'bg-blue-500/15 text-blue-400',
  };
  return <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${colors[color] || colors.default}`}>{children}</span>;
}

export function Table({ headers, children }: { headers: string[]; children: React.ReactNode }) {
  return (
    <div className="bg-surface rounded-xl border border-border overflow-hidden">
      <table className="w-full">
        <thead>
          <tr className="border-b border-border">
            {headers.map((h, i) => <th key={i} className="text-left px-4 py-3 text-xs uppercase tracking-wide text-white/40 font-medium">{h}</th>)}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function SearchInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <input
      type="text" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder || 'Search...'}
      className="px-4 py-2 bg-surface-alt rounded-lg border border-border text-white text-sm focus:border-accent focus:outline-none transition w-64"
    />
  );
}

export function Pagination({ page, total, pageSize, onPage }: { page: number; total: number; pageSize: number; onPage: (p: number) => void }) {
  const pages = Math.ceil(total / pageSize);
  if (pages <= 1) return null;
  return (
    <div className="flex items-center gap-2 mt-4">
      <button onClick={() => onPage(page - 1)} disabled={page <= 1} className="px-3 py-1.5 bg-surface-alt rounded text-sm text-white/60 hover:text-white disabled:opacity-30">Prev</button>
      <span className="text-sm text-white/40">{page} / {pages}</span>
      <button onClick={() => onPage(page + 1)} disabled={page >= pages} className="px-3 py-1.5 bg-surface-alt rounded text-sm text-white/60 hover:text-white disabled:opacity-30">Next</button>
    </div>
  );
}
