export const REVIEW_DAY_MS = 24 * 60 * 60 * 1000;
export const REVIEW_MONTH_MS = 30 * REVIEW_DAY_MS;
export const REVIEW_QUARTER_MS = 90 * REVIEW_DAY_MS;
export type StoreReviewPlatform = 'IOS' | 'ANDROID';

export interface StoreReviewAccountState {
  createdAt: Date;
  promptedAt: Date | null;
  promptCount: number;
}

export interface StoreReviewDecision {
  eligible: boolean;
  nextEligibleAt: Date;
}

export function storeReviewDecision(
  state: StoreReviewAccountState,
  platform: StoreReviewPlatform,
  now = new Date(),
): StoreReviewDecision {
  const nowMs = now.getTime();
  const createdMs = state.createdAt.getTime();
  const promptedMs = state.promptedAt?.getTime() ?? null;
  const promptCount = Math.max(0, state.promptCount);

  let nextEligibleMs: number;
  if (promptedMs === null || promptCount === 0) {
    nextEligibleMs = createdMs + 7 * REVIEW_DAY_MS;
  } else if (platform === 'IOS' && promptCount === 1) {
    nextEligibleMs = Math.max(createdMs + 30 * REVIEW_DAY_MS, promptedMs + 23 * REVIEW_DAY_MS);
  } else if (platform === 'IOS') {
    nextEligibleMs = promptedMs + REVIEW_QUARTER_MS;
  } else if (promptCount === 1) {
    nextEligibleMs = Math.max(createdMs + 14 * REVIEW_DAY_MS, promptedMs + 7 * REVIEW_DAY_MS);
  } else {
    nextEligibleMs = promptedMs + REVIEW_MONTH_MS;
  }

  return {
    eligible: nowMs >= nextEligibleMs,
    nextEligibleAt: new Date(nextEligibleMs),
  };
}
