import { QueryClient } from '@tanstack/react-query';
import { patchSeasonEpisodes, restoreSeasonEpisodes } from '../season-watch-optimistic';

const season = (id: string, watched = false) => ({
  id,
  episodes: [{ id: `${id}-episode`, watched, watchCount: watched ? 1 : 0 }],
});

describe('season watch optimistic cache updates', () => {
  it('rolls back only the failed season while preserving another pending season update', () => {
    const queryClient = new QueryClient();
    const queryKey = ['showEpisodes', 'show-1'];
    queryClient.setQueryData(queryKey, [season('season-1'), season('season-2')]);

    const firstSnapshot = patchSeasonEpisodes(queryClient, 'season-1', (episode) => ({
      ...episode,
      watched: true,
      watchCount: 1,
    }));
    patchSeasonEpisodes(queryClient, 'season-2', (episode) => ({
      ...episode,
      watched: true,
      watchCount: 1,
    }));

    restoreSeasonEpisodes(queryClient, 'season-1', firstSnapshot);

    expect(queryClient.getQueryData(queryKey)).toEqual([
      season('season-1'),
      season('season-2', true),
    ]);
  });
});
