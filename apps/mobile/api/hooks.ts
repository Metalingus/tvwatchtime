import Constants from 'expo-constants';
import { useEffect } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import type {
  CurrentUserDto,
  DiscoverSectionsDto,
  EpisodeDetailDto,
  EpisodeInteractionsDto,
  FeedCardDto,
  HistoryItemDto,
  ImportExtraSummaryDto,
  LeaderboardPageDto,
  LeaderboardType,
  MovieDetailDto,
  MovieStatsDto,
  NotificationItemDto,
  NotificationPreferencesDto,
  Paginated,
  ShowDetailDto,
  ShowStatsDto,
  StatsSummaryDto,
  UserBadgeDto,
  VoteSectionDto,
  ReactionVoteSectionDto,
  CharacterVoteSectionDto,
  WatchNextItemDto,
} from '@tvwatch/shared';
import { applyVoteChange, MediaType } from '@tvwatch/shared';
import { api } from './client';

const qk = {
  me: ['me'] as const,
  watchNext: ['watchNext'] as const,
  upcoming: ['upcoming'] as const,
  history: (p: any) => ['history', p] as const,
  show: (id: string) => ['show', id] as const,
  showEpisodes: (id: string) => ['showEpisodes', id] as const,
  episode: (id: string) => ['episode', id] as const,
  movie: (id: string) => ['movie', id] as const,
  search: (q: string, type?: string) => ['search', q, type ?? 'all'] as const,
  discover: () => ['discoverSections'] as const,
  discoverShows: (p: any) => ['discoverShows', p] as const,
  discoverMovies: (p: any) => ['discoverMovies', p] as const,
  trendingShows: ['trendingShows'] as const,
  trendingMovies: ['trendingMovies'] as const,
  watchlist: (type?: MediaType) => ['watchlist', type ?? 'all'] as const,
  favorites: (type: MediaType) => ['favorites', type] as const,
  statsSummary: ['statsSummary'] as const,
  statsShows: ['statsShows'] as const,
  statsMovies: ['statsMovies'] as const,
  badges: ['badges'] as const,
  notifications: (p: any) => ['notifications', p] as const,
  notifPrefs: ['notifPrefs'] as const,
  comments: (p: any) => ['comments', p] as const,
  lists: ['lists'] as const,
  list: (id: string) => ['list', id] as const,
};

export const useMe = () => useQuery({ queryKey: qk.me, queryFn: () => api.get<CurrentUserDto>('/me') });
export const useWatchNext = () => useQuery({ queryKey: qk.watchNext, queryFn: () => api.get<{ items: WatchNextItemDto[] }>('/me/watch-next') });
export const useUpcoming = () => useQuery({ queryKey: qk.upcoming, queryFn: () => api.get<{ groups: any[] }>('/me/upcoming') });
export const useHistory = (p: { mediaType?: MediaType; page?: number }) =>
  useQuery({ queryKey: qk.history(p), queryFn: () => api.get<Paginated<HistoryItemDto>>('/me/history', p as any) });
export const useShow = (id: string) => useQuery({ queryKey: qk.show(id), queryFn: () => api.get<ShowDetailDto>(`/shows/${id}`), enabled: !!id });
export const useShowEpisodes = (id: string) => useQuery({ queryKey: qk.showEpisodes(id), queryFn: () => api.get<any[]>(`/shows/${id}/episodes`), enabled: !!id });
export const useEpisode = (id: string) => useQuery({ queryKey: qk.episode(id), queryFn: () => api.get<EpisodeDetailDto>(`/episodes/${id}`), enabled: !!id });
export const useMovie = (id: string) => useQuery({ queryKey: qk.movie(id), queryFn: () => api.get<MovieDetailDto>(`/movies/${id}`), enabled: !!id });
export const useSearch = (q: string, type?: MediaType) =>
  useQuery({ queryKey: qk.search(q, type), queryFn: () => api.get<Paginated<FeedCardDto>>('/search', { q, type, pageSize: 30 }), enabled: q.length > 1 });
export const useDiscoverSections = () => useQuery({ queryKey: qk.discover(), queryFn: () => api.get<DiscoverSectionsDto>('/discover/sections') });
export const useDiscoverShows = (p: any) => useQuery({ queryKey: qk.discoverShows(p), queryFn: () => api.get<Paginated<FeedCardDto>>('/discover/shows', p) });
export const useDiscoverMovies = (p: any) => useQuery({ queryKey: qk.discoverMovies(p), queryFn: () => api.get<Paginated<FeedCardDto>>('/discover/movies', p) });
export const useTrendingShows = () => useQuery({ queryKey: qk.trendingShows, queryFn: () => api.get<any>('/trending/shows').then(r => r.items ?? r) });
export const useTrendingMovies = () => useQuery({ queryKey: qk.trendingMovies, queryFn: () => api.get<any>('/trending/movies').then(r => r.items ?? r) });
export const useTrendingShowsPaginated = (page: number) =>
  useQuery({ queryKey: ['trendingShowsPage', page], queryFn: () => api.get<{ items: any[]; hasMore: boolean }>(`/trending/shows?page=${page}`), enabled: page > 0 });
export const useTrendingMoviesPaginated = (page: number) =>
  useQuery({ queryKey: ['trendingMoviesPage', page], queryFn: () => api.get<{ items: any[]; hasMore: boolean }>(`/trending/movies?page=${page}`), enabled: page > 0 });
export const useWatchlist = (type?: MediaType) => useQuery({ queryKey: qk.watchlist(type), queryFn: () => api.get<Paginated<FeedCardDto>>('/me/watchlist', { type, pageSize: 50 }) });
export const useFavorites = (type: MediaType) => useQuery({ queryKey: qk.favorites(type), queryFn: () => api.get<Paginated<FeedCardDto>>(type === MediaType.SHOW ? '/me/favorites/shows' : '/me/favorites/movies', { pageSize: 50 }) });
export const useStatsSummary = () => useQuery({ queryKey: qk.statsSummary, queryFn: () => api.get<StatsSummaryDto>('/me/stats/summary') });
export const useStatsShows = () => useQuery({ queryKey: qk.statsShows, queryFn: () => api.get<ShowStatsDto>('/me/stats/shows') });
export const useStatsMovies = () => useQuery({ queryKey: qk.statsMovies, queryFn: () => api.get<MovieStatsDto>('/me/stats/movies') });
export const useBadges = () => useQuery({ queryKey: qk.badges, queryFn: () => api.get<{ badges: UserBadgeDto[]; totalUnlocked: number; totalBadges: number }>('/me/badges') });
export const useNotifications = (p: { unreadOnly?: boolean; page?: number }) =>
  useQuery({ queryKey: qk.notifications(p), queryFn: () => api.get<Paginated<NotificationItemDto>>('/me/notifications', p as any) });
export const useNotifPrefs = () => useQuery({ queryKey: qk.notifPrefs, queryFn: () => api.get<NotificationPreferencesDto>('/me/notification-preferences') });
export const useComments = (p: { threadType: string; threadId: string; sort?: string; pageSize?: number; polling?: boolean }) => {
  const { polling, ...apiParams } = p;
  return useQuery({
    queryKey: qk.comments(p),
    queryFn: () => api.get<Paginated<any>>('/comments', apiParams as any),
    enabled: !!p.threadId,
    refetchInterval: polling ? (Number(Constants?.expoConfig?.extra as any)?.commentPollInterval) || 15000 : false,
  });
};
export const useLists = () => useQuery({ queryKey: qk.lists, queryFn: () => api.get<any[]>('/me/lists') });
export const useList = (id: string) => useQuery({ queryKey: qk.list(id), queryFn: () => api.get<any>(`/lists/${id}`), enabled: !!id });

// ---------------- Mutations ----------------
export function useInvalidate(keys: readonly unknown[][]) {
  const qc = useQueryClient();
  return () => keys.forEach((k) => qc.invalidateQueries({ queryKey: k }));
}

export const useMarkEpisodeWatched = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, on }: { id: string; on: boolean }) =>
      on ? api.post(`/episodes/${id}/watched`, {}) : api.del(`/episodes/${id}/watched`),
    // Optimistically flip the watched state across all caches so the UI reacts instantly.
    onMutate: async ({ id, on }) => {
      await qc.cancelQueries({ queryKey: ['watchNext'] });
      const prevWatchNext = qc.getQueryData(qk.watchNext);
      qc.setQueryData(qk.watchNext, (old: any) =>
        old
          ? {
              ...old,
              items: old.items.map((it: any) =>
                it.episode?.id === id ? { ...it, episode: { ...it.episode, watched: on } } : it,
              ),
            }
          : old,
      );

      const prevShowEpisodes = qc.getQueriesData({ queryKey: ['showEpisodes'] });
      prevShowEpisodes.forEach(([key, data]: [any, any]) => {
        if (!Array.isArray(data)) return;
        qc.setQueryData(key, data.map((s: any) => ({
          ...s,
          episodes: s.episodes?.map((e: any) => (e.id === id ? { ...e, watched: on } : e)),
        })));
      });

      const prevEpisode = qc.getQueryData(qk.episode(id));
      qc.setQueryData(qk.episode(id), (old: any) => (old ? { ...old, watched: on } : old));

      return { prevWatchNext, prevShowEpisodes, prevEpisode };
    },
    onError: (_e, vars, ctx) => {
      if (ctx?.prevWatchNext) qc.setQueryData(qk.watchNext, ctx.prevWatchNext);
      ctx?.prevShowEpisodes?.forEach(([key, data]: [any, any]) => qc.setQueryData(key, data));
      if (ctx?.prevEpisode) qc.setQueryData(qk.episode(vars.id), ctx.prevEpisode);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['watchNext'] });
      qc.invalidateQueries({ queryKey: ['statsSummary'] });
      qc.invalidateQueries({ queryKey: ['episode'] });
      qc.invalidateQueries({ queryKey: ['showEpisodes'] });
    },
  });
};

export const useMarkSeasonWatched = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, on }: { id: string; on: boolean }) =>
      on ? api.post(`/seasons/${id}/watched`, {}) : api.del(`/seasons/${id}/watched`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['showEpisodes'] }),
  });
};

// ---------------- Episode voting (icon-based interaction sections) ----------------
// Four independent mutations, each operating only on its own slice of the
// ['episode', id] cache so sections never overwrite one another. Optimistic
// counts are recomputed deterministically; the server response reconciles.

type EpisodeInteractions = EpisodeDetailDto['interactions'];

/** Recompute a generic section (device / rating / reaction) after a vote change. */
function recomputeVoteSection(section: VoteSectionDto, to: string | null): VoteSectionDto {
  const { options, total } = applyVoteChange(section.options, section.total, section.userVote, to);
  return { userVote: to, total, options };
}

/** Recompute the character section (options keyed by castId, not `value`). */
function recomputeCharacterSection(section: CharacterVoteSectionDto, to: string | null): CharacterVoteSectionDto {
  const valueOpts = section.options.map((o) => ({ value: o.castId, count: o.count }));
  const { options, total } = applyVoteChange(valueOpts, section.total, section.userVote, to);
  return { userVote: to, total, options: options.map((o) => ({ castId: o.value, count: o.count })) };
}

/**
 * Recompute the multi-select reaction section after toggling one reaction.
 * `total` (distinct users) only changes when the user crosses zero<->nonzero.
 */
function recomputeReactionSection(section: ReactionVoteSectionDto, toggle: string): ReactionVoteSectionDto {
  // Defensive: tolerate an older single-select payload where userVotes is absent.
  const prevVotes = section.userVotes ?? [];
  const has = prevVotes.includes(toggle);
  const userVotes = has ? prevVotes.filter((v) => v !== toggle) : [...prevVotes, toggle];
  const hadAny = prevVotes.length > 0;
  const hasAnyNow = userVotes.length > 0;

  const options = section.options.map((o) => {
    if (o.value !== toggle) return o;
    return { ...o, count: Math.max(0, o.count + (has ? -1 : 1)) };
  });

  let total = section.total;
  if (!hadAny && hasAnyNow) total += 1;
  if (hadAny && !hasAnyNow) total = Math.max(0, total - 1);

  return { userVotes, total, options };
}

/** Coerce a possibly-older single-select reaction payload into the multi-select shape. */
function normalizeReactionSection(data: any): ReactionVoteSectionDto {
  if (data && Array.isArray(data.userVotes)) return data;
  const userVote = data?.userVote;
  return { userVotes: userVote ? [userVote] : [], total: data?.total ?? 0, options: data?.options ?? [] };
}

export function useEpisodeVotes(episodeId: string) {
  const qc = useQueryClient();
  const key = qk.episode(episodeId);

  const snapshot = () => qc.getQueryData<EpisodeDetailDto>(key);
  const apply = (fn: (old: EpisodeDetailDto) => EpisodeDetailDto) => {
    const prev = snapshot();
    qc.setQueryData<EpisodeDetailDto>(key, (old) => (old ? fn(old) : old));
    return { prev };
  };
  const merge = (section: keyof EpisodeInteractions, data: any) => {
    qc.setQueryData<EpisodeDetailDto>(key, (old) =>
      old ? { ...old, interactions: { ...old.interactions, [section]: data } } : old,
    );
  };

  const device = useMutation({
    mutationFn: (value: string) => api.put<VoteSectionDto>(`/episodes/${episodeId}/vote/device`, { value }),
    onMutate: async (value) => {
      await qc.cancelQueries({ queryKey: key });
      return apply((old) => ({
        ...old,
        interactions: { ...old.interactions, device: recomputeVoteSection(old.interactions.device, value) },
      }));
    },
    onError: (_e, _v, ctx) => { if (ctx?.prev) qc.setQueryData(key, ctx.prev); },
    onSuccess: (data) => merge('device', data),
  });

  const rating = useMutation({
    mutationFn: (value: number) => api.put<VoteSectionDto>(`/episodes/${episodeId}/vote/rating`, { value }),
    onMutate: async (value) => {
      await qc.cancelQueries({ queryKey: key });
      return apply((old) => ({
        ...old,
        interactions: { ...old.interactions, rating: recomputeVoteSection(old.interactions.rating, String(value)) },
      }));
    },
    onError: (_e, _v, ctx) => { if (ctx?.prev) qc.setQueryData(key, ctx.prev); },
    onSuccess: (data) => merge('rating', data),
  });

  const reaction = useMutation({
    mutationFn: (value: string) =>
      api.put<ReactionVoteSectionDto>(`/episodes/${episodeId}/vote/reaction`, { value }),
    onMutate: async (value) => {
      await qc.cancelQueries({ queryKey: key });
      return apply((old) => ({
        ...old,
        interactions: { ...old.interactions, reaction: recomputeReactionSection(old.interactions.reaction, value) },
      }));
    },
    onError: (_e, _v, ctx) => { if (ctx?.prev) qc.setQueryData(key, ctx.prev); },
    onSuccess: (data) => {
      // Adopt the server's authoritative counts/total, but keep the client's
      // userVotes so a server snapshot can never wipe an in-flight/optimistic
      // selection (the source of the "doesn't stay selected" flicker).
      const norm = normalizeReactionSection(data);
      qc.setQueryData<EpisodeDetailDto>(key, (old) => {
        if (!old) return old;
        const current = old.interactions.reaction;
        const userVotes = current?.userVotes ?? norm.userVotes;
        return {
          ...old,
          interactions: { ...old.interactions, reaction: { userVotes, total: norm.total, options: norm.options } },
        };
      });
    },
  });

  const character = useMutation({
    mutationFn: (value: string | null) =>
      api.put<CharacterVoteSectionDto>(`/episodes/${episodeId}/vote/character`, { value }),
    onMutate: async (value) => {
      await qc.cancelQueries({ queryKey: key });
      return apply((old) => {
        if (!old.interactions.character) return old;
        return {
          ...old,
          interactions: { ...old.interactions, character: recomputeCharacterSection(old.interactions.character, value) },
        };
      });
    },
    onError: (_e, _v, ctx) => { if (ctx?.prev) qc.setQueryData(key, ctx.prev); },
    onSuccess: (data) => merge('character', data),
  });

  return { device, rating, reaction, character };
}

export const useToggleMovieWatchlist = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, on }: { id: string; on: boolean }) =>
      on ? api.post(`/movies/${id}/watchlist`, {}) : api.del(`/movies/${id}/watchlist`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['watchlist'] });
      qc.invalidateQueries({ queryKey: ['movie'] });
    },
  });
};

export const useMarkMovieWatched = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, on }: { id: string; on: boolean }) =>
      on ? api.post(`/movies/${id}/watched`, {}) : api.del(`/movies/${id}/watched`),
    onMutate: async ({ id, on }) => {
      const prevMovie = qc.getQueryData(qk.movie(id));
      qc.setQueryData(qk.movie(id), (old: any) => (old ? { ...old, watched: on } : old));

      // watchlist entries carry { id, ... } keyed by mediaId; flip watched optimistically.
      const prevWatchlist = qc.getQueriesData({ queryKey: ['watchlist'] });
      prevWatchlist.forEach(([key, data]: [any, any]) => {
        if (!data) return;
        if (Array.isArray((data as any).items)) {
          qc.setQueryData(key, {
            ...(data as any),
            items: (data as any).items.map((it: any) =>
              it.id === id ? { ...it, watched: on } : it,
            ),
          });
        }
      });

      return { prevMovie, prevWatchlist };
    },
    onError: (_e, vars, ctx) => {
      if (ctx?.prevMovie) qc.setQueryData(qk.movie(vars.id), ctx.prevMovie);
      ctx?.prevWatchlist?.forEach(([key, data]: [any, any]) => qc.setQueryData(key, data));
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['statsSummary'] });
      qc.invalidateQueries({ queryKey: ['movie'] });
      qc.invalidateQueries({ queryKey: ['watchlist'] });
    },
  });
};

export const useToggleWatchlist = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, on }: { id: string; on: boolean }) =>
      on ? api.post(`/shows/${id}/watchlist`, {}) : api.del(`/shows/${id}/watchlist`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['watchlist'] });
      qc.invalidateQueries({ queryKey: ['show'] });
    },
  });
};

export const useToggleFavorite = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, on, kind }: { id: string; on: boolean; kind: 'shows' | 'movies' }) =>
      on ? api.post(`/${kind}/${id}/favorite`, {}) : api.del(`/${kind}/${id}/favorite`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['favorites'] });
      qc.invalidateQueries({ queryKey: ['show'] });
      qc.invalidateQueries({ queryKey: ['movie'] });
    },
  });
};

export const useUpdateProfile = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dto: any) => api.patch<CurrentUserDto>('/me', dto),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
  });
};

async function uriToBlob(uri: string): Promise<Blob> {
  const res = await fetch(uri);
  return res.blob();
}

export const useUploadAvatar = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (uri: string) => {
      const blob = await uriToBlob(uri);
      const fd = new FormData();
      fd.append('file', blob, 'avatar.jpg');
      return api.post<{ url: string }>('/me/avatar', fd);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
  });
};

export const useUploadCover = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (uri: string) => {
      const blob = await uriToBlob(uri);
      const fd = new FormData();
      fd.append('file', blob, 'cover.jpg');
      return api.post<{ url: string }>('/me/cover', fd);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
  });
};

export const useMarkNotificationRead = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, all }: { id?: string; all?: boolean }) =>
      all ? api.post('/me/notifications/mark-all-read', {}) : api.patch(`/me/notifications/${id}/read`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
};

// ---------------- Import system ----------------
const TERMINAL = ['READY_FOR_REVIEW', 'COMPLETED', 'FAILED', 'CANCELLED', 'ROLLED_BACK'];

export const useUploadImport = () =>
  useMutation({ mutationFn: (fd: FormData) => api.post<{ importId: string; status: string }>('/imports/upload', fd) });

export const useImport = (id?: string) =>
  useQuery({
    queryKey: ['import', id],
    queryFn: () => api.get<any>(`/imports/${id}`),
    enabled: !!id,
    refetchInterval: (q) => {
      const s = (q.state.data as any)?.status;
      return s && !TERMINAL.includes(s) ? 2500 : false;
    },
  });

/** Rating/emotion/comment summary for the import preview + result screens. */
export const useImportSummary = (id?: string) =>
  useQuery({
    queryKey: ['importSummary', id],
    queryFn: () => api.get<ImportExtraSummaryDto>(`/imports/${id}/summary`),
    enabled: !!id,
  });

// ---------------- Feature Flags ----------------
export const useFeatureFlags = () =>
  useQuery({
    queryKey: ['featureFlags'],
    queryFn: () => api.get<Record<string, boolean>>('/feature-flags'),
    staleTime: 5 * 60 * 1000, // 5 min cache
  });

// A single large page instead of an infinite query: the review list's underlying set shifts
// as items change status, which breaks offset pagination and causes stale/duplicate rows.
export const useImportItems = (id: string, status: string | undefined, entity: string | undefined) =>
  useQuery({
    queryKey: ['importItems', id, status ?? 'all', entity ?? 'all'],
    queryFn: () =>
      api.get<{ items: any[]; total: number; page: number; pageSize: number }>(`/imports/${id}/items`, {
        status,
        entity,
        page: 1,
        pageSize: 500,
      }),
    enabled: !!id,
    // No placeholderData: after a status change / filter switch we'd otherwise briefly show the
    // previous (wrong) filter's rows. Correctness over flicker for the review list.
  });

/** Manually resolve a staged import item: match it to a media id, or skip it. */
export const usePatchImportItem = (importId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { itemId: string; matchedMediaId?: string; userResolution?: 'skip' }) =>
      api.patch<any>(`/imports/${importId}/items/${args.itemId}`, {
        matchedMediaId: args.matchedMediaId,
        userResolution: args.userResolution,
      }),
    // Invalidate the item list AND the import summary so the counts (needs_review, etc.) refresh.
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['importItems'] });
      qc.invalidateQueries({ queryKey: ['import'] });
    },
  });
};

/** Resolve every unresolved item for the same source show at once ("apply to all episodes"). */
export const useResolveAllForShow = (importId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { matchedMediaId: string; sourceTitle: string; season?: number | null }) =>
      api.post<{ resolved: number; matched: number; needsReview: number }>(`/imports/${importId}/resolve-episodes`, {
        matchedMediaId: args.matchedMediaId,
        sourceTitle: args.sourceTitle,
        season: args.season ?? undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['importItems'] });
      qc.invalidateQueries({ queryKey: ['import'] });
    },
  });
};

export const useConfirmImport = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<{ importId: string; created: number; skipped: number }>(`/imports/${id}/confirm`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['import'] }),
  });
};

export const useCancelImport = () => {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => api.post(`/imports/${id}/cancel`, {}), onSuccess: () => qc.invalidateQueries({ queryKey: ['import'] }) });
};

// ---------------- Comment images ----------------
export const useUploadCommentImage = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ commentId, uri }: { commentId: string; uri: string }) => {
      const fd = new FormData();
      fd.append('file', { uri, name: 'image.jpg', type: 'image/jpeg' } as any);
      return api.post<{ commentImageId: string; status: string }>(`/comments/${commentId}/image`, fd);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['comments'] }),
  });
};

export const useCommentImageStatus = (imageId: string | null) =>
  useQuery({
    queryKey: ['commentImageStatus', imageId],
    queryFn: () => api.get<any>(`/comment-images/${imageId}/status`),
    enabled: !!imageId,
    refetchInterval: (q) => {
      const s = (q.state.data as any)?.status;
      return s && !['ready', 'rejected', 'failed', 'deleted', 'needs_manual_review'].includes(s) ? 2000 : false;
    },
  });

// ---------------- Leaderboard ----------------
export const useLeaderboard = (type: LeaderboardType, page: number, pageSize = 10) =>
  useQuery({
    queryKey: ['leaderboard', type, page, pageSize],
    queryFn: () =>
      api.get<LeaderboardPageDto>(`/me/stats/leaderboard?type=${type}&page=${page}&pageSize=${pageSize}`),
    placeholderData: keepPreviousData,
  });

/** Prefetch the next page (if any) so arrow/swipe navigation is instant. */
export const usePrefetchLeaderboard = (type: LeaderboardType, page: number, totalPages: number, pageSize = 10) => {
  const qc = useQueryClient();
  useEffect(() => {
    if (page + 1 <= totalPages) {
      qc.prefetchQuery({
        queryKey: ['leaderboard', type, page + 1, pageSize],
        queryFn: () =>
          api.get<LeaderboardPageDto>(`/me/stats/leaderboard?type=${type}&page=${page + 1}&pageSize=${pageSize}`),
      });
    }
  }, [type, page, totalPages, pageSize, qc]);
};

export function formatWatchTime(totalMinutes: number): string {
  const mins = Math.max(0, Math.round(totalMinutes));
  const hours = Math.floor(mins / 60) % 24;
  const days = Math.floor(mins / (60 * 24)) % 30;
  const months = Math.floor(mins / (60 * 24 * 30)) % 12;
  const years = Math.floor(mins / (60 * 24 * 365));
  const parts: string[] = [];
  if (years > 0) parts.push(`${years}y`);
  if (years > 0 || months > 0) parts.push(`${months}mo`);
  if (years > 0 || months > 0 || days > 0) parts.push(`${days}d`);
  parts.push(`${hours}h`);
  return parts.join(' ');
}

// ---------------- Lists ----------------
export const useMyLists = () =>
  useQuery({ queryKey: ['myLists'], queryFn: () => api.get<any[]>('/me/lists') });

export const useFollowedLists = () =>
  useQuery({ queryKey: ['followedLists'], queryFn: () => api.get<any[]>('/me/followed-lists') });

export const useListItems = (id: string, page = 1) =>
  useQuery({ queryKey: ['listItems', id, page], queryFn: () => api.get<any>(`/lists/${id}/items?page=${page}`), enabled: !!id });

export const useToggleListLike = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/lists/${id}/like`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['list'] }); qc.invalidateQueries({ queryKey: ['myLists'] }); },
  });
};

export const useToggleListSub = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/lists/${id}/subscribe`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['list'] }); qc.invalidateQueries({ queryKey: ['followedLists'] }); },
  });
};

export const useToggleListNotify = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/lists/${id}/notify`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['list'] }),
  });
};

export const useCreateList = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (dto: { title: string; description?: string; visibility?: string; items?: string[] }) =>
      api.post<any>('/me/lists', dto),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['myLists'] }),
  });
};

export const useAddListItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ listId, mediaId }: { listId: string; mediaId: string }) =>
      api.post(`/lists/${listId}/items`, { mediaId }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['listItems'] }); qc.invalidateQueries({ queryKey: ['list'] }); },
  });
};

export const useRemoveListItem = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ listId, itemId }: { listId: string; itemId: string }) =>
      api.delete(`/lists/${listId}/items/${itemId}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['listItems'] }); qc.invalidateQueries({ queryKey: ['list'] }); },
  });
};

// ---------------- Users ----------------
export const useSearchUsers = (q: string) =>
  useQuery({
    queryKey: ['userSearch', q],
    queryFn: () => api.get<any[]>('/users/search', { q }),
    enabled: q.trim().length >= 2,
  });

export const usePublicProfile = (username: string) =>
  useQuery({ queryKey: ['profile', username], queryFn: () => api.get<any>(`/users/${username}`), enabled: !!username });

export const useFollows = (username: string, type: 'followers' | 'following') =>
  useQuery({ queryKey: ['follows', username, type], queryFn: () => api.get<any[]>(`/users/${username}/follows?type=${type}`), enabled: !!username });

export const useFollowUser = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => api.post(`/users/${userId}/follow`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['profile'] }); qc.invalidateQueries({ queryKey: ['userSearch'] }); qc.invalidateQueries({ queryKey: ['follows'] }); },
  });
};

export const useUnfollowUser = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => api.delete(`/users/${userId}/follow`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['profile'] }); qc.invalidateQueries({ queryKey: ['userSearch'] }); qc.invalidateQueries({ queryKey: ['follows'] }); },
  });
};
