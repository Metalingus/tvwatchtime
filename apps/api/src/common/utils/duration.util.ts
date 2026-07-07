import type { DurationDto } from '@tvwatch/shared';

/** Break total minutes into months/days/hours for display. */
export function toDuration(totalMinutes: number): DurationDto {
  const mins = Math.max(0, Math.round(totalMinutes || 0));
  const totalHours = Math.floor(mins / 60);
  const hours = totalHours % 24;
  const totalDays = Math.floor(totalHours / 24);
  const days = totalDays % 30;
  const months = Math.floor(totalDays / 30);
  return { months, days, hours, totalMinutes: mins };
}

export function weeksAgoLabel(date: Date): string {
  return date.toISOString().slice(0, 10);
}
