import {
  REVIEW_DAY_MS,
  REVIEW_MONTH_MS,
  REVIEW_QUARTER_MS,
  storeReviewDecision,
} from './store-review-policy';

const registeredAt = new Date('2026-01-01T00:00:00.000Z');
const atDay = (day: number) => new Date(registeredAt.getTime() + day * REVIEW_DAY_MS);

describe('storeReviewDecision', () => {
  it('makes the first prompt eligible after one week on both platforms', () => {
    const state = { createdAt: registeredAt, promptedAt: null, promptCount: 0 };
    expect(storeReviewDecision(state, 'IOS', atDay(7)).eligible).toBe(true);
    expect(storeReviewDecision(state, 'ANDROID', atDay(7)).eligible).toBe(true);
  });

  it('uses day 30 then quarterly spacing on iOS', () => {
    const afterFirst = {
      createdAt: registeredAt,
      promptedAt: atDay(7),
      promptCount: 1,
    };
    expect(storeReviewDecision(afterFirst, 'IOS', atDay(29)).eligible).toBe(false);
    expect(storeReviewDecision(afterFirst, 'IOS', atDay(30)).eligible).toBe(true);

    const afterSecond = {
      createdAt: registeredAt,
      promptedAt: atDay(30),
      promptCount: 2,
    };
    expect(
      storeReviewDecision(afterSecond, 'IOS', new Date(atDay(30).getTime() + REVIEW_QUARTER_MS - 1))
        .eligible,
    ).toBe(false);
    expect(
      storeReviewDecision(afterSecond, 'IOS', new Date(atDay(30).getTime() + REVIEW_QUARTER_MS))
        .eligible,
    ).toBe(true);
  });

  it('keeps day 14 then monthly spacing on Android', () => {
    const afterFirst = {
      createdAt: registeredAt,
      promptedAt: atDay(7),
      promptCount: 1,
    };
    expect(storeReviewDecision(afterFirst, 'ANDROID', atDay(14)).eligible).toBe(true);

    const afterSecond = {
      createdAt: registeredAt,
      promptedAt: atDay(14),
      promptCount: 2,
    };
    expect(
      storeReviewDecision(afterSecond, 'ANDROID', new Date(atDay(14).getTime() + REVIEW_MONTH_MS))
        .eligible,
    ).toBe(true);
  });
});
