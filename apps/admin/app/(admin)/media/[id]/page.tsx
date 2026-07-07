'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { api } from '@/lib/api';
import { Badge } from '@/components/ui';

export default function MediaDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const [media, setMedia] = useState<any>(null);
  const [hydrating, setHydrating] = useState(false);

  useEffect(() => { api.get(`/admin/media/${id}`).then((r) => setMedia(r.data)); }, [id]);

  const rehydrate = async () => {
    const tmdb = media.externalIds?.find((e: any) => e.provider === 'TMDB')?.value;
    if (!tmdb) return;
    setHydrating(true);
    try {
      await api.post('/admin/jobs/hydrate', { type: media.type === 'SHOW' ? 'single_show' : 'single_movie', tmdbId: Number(tmdb) });
      setTimeout(() => api.get(`/admin/media/${id}`).then((r) => setMedia(r.data)), 3000);
    } finally { setHydrating(false); }
  };

  if (!media) return <div className="text-white/40 text-center py-20">Loading...</div>;

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-6">
        {media.backdropUrl ? <img src={media.backdropUrl} alt="" className="w-full h-48 object-cover rounded-xl" /> : null}
      </div>

      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold">{media.title}</h1>
          <div className="flex gap-2 mt-2">
            <Badge color="info">{media.type}</Badge>
            {media.status ? <Badge color={media.status === 'RETURNING' ? 'success' : 'default'}>{media.status}</Badge> : null}
            {media.rating ? <Badge color="warning">★ {media.rating.toFixed(1)}</Badge> : null}
          </div>
        </div>
        <button onClick={rehydrate} disabled={hydrating} className="px-4 py-2 bg-accent text-bg font-bold rounded-lg text-sm disabled:opacity-50">
          {hydrating ? 'Rehydrating...' : '🔄 Rehydrate'}
        </button>
      </div>

      {media.overview ? <p className="text-sm text-white/60">{media.overview}</p> : null}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Details */}
        <div className="bg-surface rounded-xl p-5 border border-border">
          <div className="text-sm font-semibold text-white/70 mb-3">Details</div>
          <dl className="space-y-2 text-sm">
            {media.show ? (<><dt className="text-white/40 inline">Network: </dt><dd>{media.show.network || '—'}</dd></>) : null}
            {media.movie?.releaseYear ? (<><dt className="text-white/40 inline">Year: </dt><dd>{media.movie.releaseYear}</dd></>) : null}
            {media.show?.yearStart ? (<><dt className="text-white/40 inline">Years: </dt><dd>{media.show.yearStart}{media.show.yearEnd ? `–${media.show.yearEnd}` : '–'}</dd></>) : null}
            <dt className="text-white/40 inline">Popularity: </dt><dd>{Math.round(media.popularity)}</dd>
            <dt className="text-white/40 inline">Added by users: </dt><dd className="text-accent font-bold">{media.addedCount}</dd>
            <dt className="text-white/40 inline">Watch events: </dt><dd>{media._count?.watchHistory || 0}</dd>
            <dt className="text-white/40 inline">In watchlists: </dt><dd>{media._count?.watchlist || 0}</dd>
            <dt className="text-white/40 inline">Favorited: </dt><dd>{media._count?.favorites || 0}</dd>
            <dt className="text-white/40 inline">Last hydrated: </dt><dd>{media.metadataRefreshedAt ? new Date(media.metadataRefreshedAt).toLocaleString() : 'Never'}</dd>
          </dl>
        </div>

        {/* External IDs */}
        <div className="bg-surface rounded-xl p-5 border border-border">
          <div className="text-sm font-semibold text-white/70 mb-3">External IDs</div>
          <div className="space-y-2">
            {media.externalIds?.map((e: any) => (
              <div key={e.id} className="flex items-center justify-between text-sm">
                <span className="text-white/40">{e.provider}</span>
                <span className="font-mono text-accent">{e.value}</span>
              </div>
            )) || <div className="text-white/30 text-sm">None</div>}
          </div>
          <div className="text-sm font-semibold text-white/70 mt-4 mb-3">Genres</div>
          <div className="flex flex-wrap gap-2">
            {media.genres?.map((g: any) => <Badge key={g.genre.id}>{g.genre.name}</Badge>) || null}
          </div>
        </div>
      </div>

      {/* Seasons for shows */}
      {media.show?.seasons ? (
        <div className="bg-surface rounded-xl p-5 border border-border">
          <div className="text-sm font-semibold text-white/70 mb-3">Seasons ({media.show.seasons.length})</div>
          <div className="space-y-2">
            {media.show.seasons.map((s: any) => (
              <div key={s.id} className="flex items-center gap-3 py-2 border-b border-border/50 last:border-0">
                {s.posterUrl ? <img src={s.posterUrl} alt="" className="w-10 h-14 rounded object-cover" /> : <div className="w-10 h-14 rounded bg-surface-alt" />}
                <span className="text-sm font-medium flex-1">{s.title}</span>
                <span className="text-xs text-white/40">{s._count?.episodes || 0} episodes</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* Cast */}
      {media.cast?.length ? (
        <div className="bg-surface rounded-xl p-5 border border-border">
          <div className="text-sm font-semibold text-white/70 mb-3">Cast ({media.cast.length})</div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {media.cast.slice(0, 12).map((c: any) => (
              <div key={c.id} className="flex items-center gap-2">
                {c.castMember?.profileUrl ? <img src={c.castMember.profileUrl} alt="" className="w-8 h-8 rounded-full object-cover" /> : <div className="w-8 h-8 rounded-full bg-surface-alt" />}
                <div className="min-w-0">
                  <div className="text-xs truncate">{c.castMember?.name}</div>
                  {c.character ? <div className="text-xs text-white/30 truncate">{c.character}</div> : null}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
