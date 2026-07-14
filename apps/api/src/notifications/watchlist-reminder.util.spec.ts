import { pickReminderShow } from './watchlist-reminder.util';

const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2026-07-13T00:00:00Z');

describe('pickReminderShow (watchlist reminder rotation)', () => {
  it('returns null for no candidates', () => {
    expect(pickReminderShow([], new Map(), 30 * DAY, now)).toBeNull();
  });

  it('prefers a never-reminded show over a recently-reminded one', () => {
    const candidates = [
      { mediaId: 'A', lastWatchedAt: new Date('2026-01-01') },
      { mediaId: 'B', lastWatchedAt: new Date('2026-02-01') },
    ];
    const lastReminded = new Map([['A', new Date('2026-07-12')]]); // A reminded yesterday
    const pick = pickReminderShow(candidates, lastReminded, 30 * DAY, now);
    expect(pick?.mediaId).toBe('B'); // B never reminded -> chosen, daily reminder still goes out
  });

  it('does not repeat a show until the cooldown elapses', () => {
    const candidates = [
      { mediaId: 'A', lastWatchedAt: new Date('2026-01-01') },
      { mediaId: 'B', lastWatchedAt: new Date('2026-02-01') },
      { mediaId: 'C', lastWatchedAt: new Date('2026-03-01') },
    ];
    // All reminded recently except C.
    const lastReminded = new Map([
      ['A', new Date('2026-07-10')],
      ['B', new Date('2026-07-11')],
    ]);
    const pick = pickReminderShow(candidates, lastReminded, 30 * DAY, now);
    expect(pick?.mediaId).toBe('C');
  });

  it('round-robins to the least-recently-reminded show when all are on cooldown', () => {
    const candidates = [
      { mediaId: 'A', lastWatchedAt: new Date('2026-01-01') },
      { mediaId: 'B', lastWatchedAt: new Date('2026-02-01') },
    ];
    // Both reminded within 30 days, but A was reminded longest ago.
    const lastReminded = new Map([
      ['A', new Date('2026-06-20')], // 23 days ago
      ['B', new Date('2026-07-12')], // 1 day ago
    ]);
    const pick = pickReminderShow(candidates, lastReminded, 30 * DAY, now);
    expect(pick?.mediaId).toBe('A'); // least-recently-reminded -> cycles back to A
  });

  it('becomes eligible again once the cooldown passes', () => {
    const candidates = [{ mediaId: 'A', lastWatchedAt: new Date('2026-01-01') }];
    const lastReminded = new Map([['A', new Date('2026-06-10')]]); // >30 days ago at now=2026-07-13
    const pick = pickReminderShow(candidates, lastReminded, 30 * DAY, now);
    expect(pick?.mediaId).toBe('A');
  });

  it('tie-breaks never-reminded shows by oldest lastWatchedAt', () => {
    const candidates = [
      { mediaId: 'A', lastWatchedAt: new Date('2026-05-01') },
      { mediaId: 'B', lastWatchedAt: new Date('2026-01-01') }, // older -> more overdue
    ];
    const pick = pickReminderShow(candidates, new Map(), 30 * DAY, now);
    expect(pick?.mediaId).toBe('B');
  });
});
