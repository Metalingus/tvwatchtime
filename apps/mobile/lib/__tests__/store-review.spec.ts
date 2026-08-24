const mockPost = jest.fn();
const mockIsAvailable = jest.fn();
const mockRequestReview = jest.fn();
const mockStoreUrl = jest.fn();
const mockOpenUrl = jest.fn();

jest.mock('../../api/client', () => ({ api: { post: mockPost } }));
jest.mock('expo-store-review', () => ({
  isAvailableAsync: mockIsAvailable,
  requestReview: mockRequestReview,
  storeUrl: mockStoreUrl,
}));
jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  Linking: { openURL: mockOpenUrl },
}));

import { maybeRequestStoreReview, openStoreReviewPage } from '../store-review';

describe('account-backed store review flow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsAvailable.mockResolvedValue(true);
  });

  it('requests the native prompt only after the API atomically grants eligibility', async () => {
    mockPost.mockResolvedValue({ eligible: true });
    mockRequestReview.mockResolvedValue(undefined);

    await expect(maybeRequestStoreReview()).resolves.toBe(true);
    expect(mockPost).toHaveBeenCalledWith('/me/store-review/claim', {
      platform: 'IOS',
    });
    expect(mockRequestReview).toHaveBeenCalledTimes(1);
  });

  it('does not invoke the OS flow when the account is not yet eligible', async () => {
    mockPost.mockResolvedValue({ eligible: false });
    await expect(maybeRequestStoreReview()).resolves.toBe(false);
    expect(mockRequestReview).not.toHaveBeenCalled();
  });

  it('keeps the manual Settings action independent from prompt eligibility', async () => {
    mockStoreUrl.mockReturnValue('https://apps.example/review');
    mockOpenUrl.mockResolvedValue(undefined);
    await expect(openStoreReviewPage()).resolves.toBe(true);
    expect(mockOpenUrl).toHaveBeenCalledWith('https://apps.example/review');
    expect(mockPost).not.toHaveBeenCalled();
  });
});
