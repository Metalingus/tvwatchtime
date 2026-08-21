import { attemptInitialWatchNextLanding } from '../watch-next-landing';

describe('attemptInitialWatchNextLanding', () => {
  it('does not consume the landing while loading or before the list ref exists', () => {
    const list = { scrollToIndex: jest.fn() };

    expect(
      attemptInitialWatchNextLanding(list, {
        isLoading: true,
        alreadyLanded: false,
        landingIndex: 4,
      }),
    ).toBe(false);
    expect(
      attemptInitialWatchNextLanding(null, {
        isLoading: false,
        alreadyLanded: false,
        landingIndex: 4,
      }),
    ).toBe(false);
    expect(list.scrollToIndex).not.toHaveBeenCalled();
  });

  it('lands once the list is ready and refuses a later re-scroll', () => {
    const list = { scrollToIndex: jest.fn() };

    expect(
      attemptInitialWatchNextLanding(list, {
        isLoading: false,
        alreadyLanded: false,
        landingIndex: 4,
      }),
    ).toBe(true);
    expect(list.scrollToIndex).toHaveBeenCalledWith({ index: 4, animated: false });
    expect(
      attemptInitialWatchNextLanding(list, {
        isLoading: false,
        alreadyLanded: true,
        landingIndex: 4,
      }),
    ).toBe(false);
    expect(list.scrollToIndex).toHaveBeenCalledTimes(1);
  });
});
