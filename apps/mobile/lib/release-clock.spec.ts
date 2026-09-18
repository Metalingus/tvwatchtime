import { nextReleaseBoundary } from './release-clock';
it('finds the next precise broadcast in nested/paged data and ignores date-only midnight', () => {
  const now = Date.parse('2026-09-17T12:00:00Z');
  expect(
    nextReleaseBoundary(
      {
        pages: [
          {
            items: [
              { airDate: '2026-09-18T00:00:00Z', airTime: null },
              { airDate: '2026-09-18T02:00:00Z', airTime: '22:00' },
            ],
          },
        ],
      },
      now,
    ),
  ).toBe(Date.parse('2026-09-18T02:00:00Z'));
});
it('uses the server boundary even when no watch-next episode is available yet', () => {
  expect(
    nextReleaseBoundary({ items: [], refreshAt: '2026-09-18T02:00:00Z' }, Date.parse('2026-09-17')),
  ).toBe(Date.parse('2026-09-18T02:00:00Z'));
  expect(nextReleaseBoundary({ refreshAt: '2026-09-17' }, Date.parse('2026-09-18'))).toBeNull();
});
