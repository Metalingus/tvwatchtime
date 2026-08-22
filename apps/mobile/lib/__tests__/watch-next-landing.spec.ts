import {
  attemptInitialWatchNextLanding,
  shouldWaitForAuthoritativeWatchNext,
} from '../watch-next-landing';

describe('shouldWaitForAuthoritativeWatchNext', () => {
  it('uses a restored primary bucket immediately without a history flash', () => {
    expect(
      shouldWaitForAuthoritativeWatchNext({
        isLoading: false,
        isFetchedAfterMount: false,
        hasWatchNext: true,
      }),
    ).toBe(false);
  });

  it('waits when restored data has only secondary buckets', () => {
    expect(
      shouldWaitForAuthoritativeWatchNext({
        isLoading: false,
        isFetchedAfterMount: false,
        hasWatchNext: false,
      }),
    ).toBe(true);
  });

  it('allows the real secondary fallback after the mount fetch settles', () => {
    expect(
      shouldWaitForAuthoritativeWatchNext({
        isLoading: false,
        isFetchedAfterMount: true,
        hasWatchNext: false,
      }),
    ).toBe(false);
  });
});

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
