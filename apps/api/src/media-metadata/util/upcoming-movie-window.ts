export interface UpcomingMovieWindow {
  start: string;
  end: string;
}

/** Global catalog window in UTC calendar days; clamp month ends instead of rolling over. */
export function upcomingMovieWindow(now = new Date()): UpcomingMovieWindow {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(today);
  start.setUTCDate(start.getUTCDate() - 3);
  const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 2, 1));
  const lastDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate();
  end.setUTCDate(Math.min(today.getUTCDate(), lastDay));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

export function upcomingMovieDateFilter(window: UpcomingMovieWindow) {
  const endExclusive = new Date(window.end + 'T00:00:00.000Z');
  endExclusive.setUTCDate(endExclusive.getUTCDate() + 1);
  return { gte: new Date(window.start + 'T00:00:00.000Z'), lt: endExclusive };
}
