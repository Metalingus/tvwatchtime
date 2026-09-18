import { TvmazeProvider } from './tvmaze.provider';
import configuration from '../../config/configuration';

it('cannot reactivate TVmaze with the legacy environment flag', async () => {
  const previous = process.env.TVMAZE_ENABLED;
  const fetchMock = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Network forbidden'));
  try {
    process.env.TVMAZE_ENABLED = 'true';
    expect(configuration().metadata.tvmazeEnabled).toBe(false);
    const provider = new TvmazeProvider({ get: () => true } as any);
    expect(provider.enabled).toBe(false);
    expect((await provider.getEpisodeAirTimes('389492')).size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  } finally {
    if (previous === undefined) delete process.env.TVMAZE_ENABLED;
    else process.env.TVMAZE_ENABLED = previous;
    fetchMock.mockRestore();
  }
});
