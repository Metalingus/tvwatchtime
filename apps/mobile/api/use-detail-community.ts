import { useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import type { ConversationCountDto, ConversationType, CurrentUserDto } from '@tvwatch/shared';
import { getBaseUrl, request } from './client';
import {
  applyCommunityCount,
  applyCommunityInteractions,
  type DetailInteractions,
  type MediaDetail,
} from './detail-community-cache';

/**
 * These queries never contribute to the main detail's loading/error state. Their keys
 * follow the detail prefix so normal vote/comment invalidations refresh them too.
 * Metadata/artwork polling does not invalidate them.
 */
export function useDetailCommunity(
  queryKey: QueryKey,
  type: ConversationType,
  detail: MediaDetail | undefined,
  enabled: boolean,
  userId: string | undefined,
) {
  const qc = useQueryClient();
  const id = detail?.id;
  const ready = enabled && !!userId && !!id && !!detail?.communityDetailsDeferred;
  const resource = type === 'SHOW' ? 'shows' : type === 'MOVIE' ? 'movies' : 'episodes';
  const common = {
    enabled: ready,
    retry: false,
    gcTime: 0,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  };
  const snapshot = () => ({
    detail: qc.getQueryData<MediaDetail>(queryKey),
    query: qc.getQueryCache().find({ queryKey, exact: true }),
  });
  const stillCurrent = async (
    before: ReturnType<typeof snapshot>,
    signal: AbortSignal,
    baseUrl: string,
  ) => {
    const currentUrl = await getBaseUrl();
    return (
      currentUrl === baseUrl &&
      !signal.aborted &&
      qc.getQueryData<CurrentUserDto>(['me'])?.id === userId &&
      qc.getQueryCache().find({ queryKey, exact: true }) === before.query
    );
  };

  const counts = useQuery({
    ...common,
    queryKey: [...queryKey, 'community-counts', userId, id],
    queryFn: async ({ signal }) => {
      const before = snapshot();
      const baseUrl = await getBaseUrl();
      const result = await request<ConversationCountDto>('/conversations/counts', {
        query: { threadType: type, threadId: id },
        signal,
      });
      if (
        result.threadType === type &&
        result.threadId === id &&
        (await stillCurrent(before, signal, baseUrl))
      ) {
        qc.setQueryData<MediaDetail>(queryKey, (current) =>
          applyCommunityCount(current, before.detail, result),
        );
      }
      return result;
    },
  });
  const interactions = useQuery({
    ...common,
    queryKey: [...queryKey, 'community-interactions', userId, id],
    queryFn: async ({ signal }) => {
      const before = snapshot();
      const baseUrl = await getBaseUrl();
      const result = await request<DetailInteractions>(`/${resource}/${id}/interactions`, {
        signal,
      });
      if (await stillCurrent(before, signal, baseUrl)) {
        qc.setQueryData<MediaDetail>(queryKey, (current) =>
          applyCommunityInteractions(current, before.detail, id!, result),
        );
      }
      return result;
    },
  });
  // Callers can request fresh community data without awaiting it in pull-to-refresh.
  return () => {
    if (!ready) return;
    void counts.refetch();
    void interactions.refetch();
  };
}
