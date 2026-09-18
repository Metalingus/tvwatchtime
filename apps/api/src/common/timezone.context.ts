import { AsyncLocalStorage } from 'async_hooks';
import { calendarDay, validTimeZone } from '@tvwatch/shared';

const timezone = new AsyncLocalStorage<string>();
export function currentTimeZone(): string {
  return timezone.getStore() ?? 'UTC';
}
export function runInTimeZone<T>(zone: unknown, fn: () => T): T {
  return timezone.run(validTimeZone(zone), fn);
}
export function currentCalendarDay(now = new Date()): Date {
  return calendarDay(now, currentTimeZone());
}
export function releaseCacheScope(now = new Date()): string {
  return (
    'release-v1:' + currentTimeZone() + ':' + currentCalendarDay(now).toISOString().slice(0, 10)
  );
}
