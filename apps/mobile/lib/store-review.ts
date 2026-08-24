import { Linking, Platform } from 'react-native';
import * as StoreReview from 'expo-store-review';
import { api } from '../api/client';
const IOS_REVIEW_URL =
  'https://apps.apple.com/us/app/tv-watch-time/id6793281668?action=write-review';
const ANDROID_REVIEW_URL =
  'https://play.google.com/store/apps/details?id=app.tvwatchtime.mobile&showAllReviews=true';

let prompting: Promise<boolean> | null = null;

export async function maybeRequestStoreReview(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  if (prompting) return prompting;

  const work = (async () => {
    try {
      if (!(await StoreReview.isAvailableAsync())) return false;
      const claim = await api.post<{ eligible: boolean }>('/me/store-review/claim', {
        platform: Platform.OS === 'ios' ? 'IOS' : 'ANDROID',
      });
      if (!claim.eligible) return false;
      // The API records the claimed attempt before invoking the OS flow. The
      // platform may suppress it and never reveals whether the user rated.
      await StoreReview.requestReview();
      return true;
    } catch {
      return false;
    }
  })();
  prompting = work.finally(() => {
    prompting = null;
  });
  return prompting;
}

/** Manual Settings action: open the store listing instead of the quota-limited native prompt. */
export async function openStoreReviewPage(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  const configured = StoreReview.storeUrl();
  const url = configured ?? (Platform.OS === 'ios' ? IOS_REVIEW_URL : ANDROID_REVIEW_URL);
  try {
    await Linking.openURL(url);
    return true;
  } catch {
    return false;
  }
}
