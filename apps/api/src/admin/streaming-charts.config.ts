import { BadRequestException } from '@nestjs/common';
import { STREAMING_TOP_SERVICES } from '@tvwatch/shared';
import { MOTN_CHART_COUNTRIES } from '../media-metadata/providers/motn.client';

/** Scheduled Hydrations row type for the daily streaming top charts. */
export const STREAMING_TOP_HYDRATION_TYPE = 'streaming_top';
export const STREAMING_CHARTS_MAX_COUNTRIES = 6;

/** Options stored on the `streaming_top` ScheduledHydration row (`config`). */
export interface StreamingChartsConfig {
  countries: string[];
  services: string[];
  monthlyBudget: number;
  reserve: number;
  watchforge: boolean;
  retentionDays: number;
}

export const STREAMING_CHARTS_DEFAULT_CONFIG: StreamingChartsConfig = {
  countries: ['US'],
  services: [...STREAMING_TOP_SERVICES],
  monthlyBudget: 1000,
  reserve: 20,
  watchforge: true,
  retentionDays: 14,
};

function subset(value: unknown, choices: readonly string[]): string[] | null {
  if (!Array.isArray(value)) return null;
  const picked = [...new Set(value.filter((v): v is string => typeof v === 'string'))];
  return picked.length === value.length && picked.every((v) => choices.includes(v)) ? picked : null;
}

function int(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : null;
}

/** Stored config resolved against defaults; invalid values fall back instead of failing a run. */
export function resolveStreamingChartsConfig(stored: unknown): StreamingChartsConfig {
  const raw =
    stored && typeof stored === 'object' && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)
      : {};
  const d = STREAMING_CHARTS_DEFAULT_CONFIG;
  const countries = subset(raw.countries, MOTN_CHART_COUNTRIES);
  const services = subset(raw.services, STREAMING_TOP_SERVICES);
  return {
    countries:
      countries?.length && countries.length <= STREAMING_CHARTS_MAX_COUNTRIES
        ? countries
        : d.countries,
    services: services?.length ? services : d.services,
    monthlyBudget: int(raw.monthlyBudget, 1, 1_000_000) ?? d.monthlyBudget,
    reserve: int(raw.reserve, 0, 1000) ?? d.reserve,
    watchforge: typeof raw.watchforge === 'boolean' ? raw.watchforge : d.watchforge,
    retentionDays: int(raw.retentionDays, 2, 90) ?? d.retentionDays,
  };
}

/** Worst-case monthly spend: one call per service per country per day. */
export function projectedMonthlyCalls(
  config: Pick<StreamingChartsConfig, 'countries' | 'services'>,
  days = 31,
): number {
  return config.services.length * config.countries.length * days;
}

/** Strict admin-edit validation: unknown keys, bad values and over-budget sets are refused. */
export function validateStreamingChartsConfig(input: unknown): StreamingChartsConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new BadRequestException('config must be an object');
  const raw = input as Record<string, unknown>;
  for (const key of Object.keys(raw))
    if (!(key in STREAMING_CHARTS_DEFAULT_CONFIG))
      throw new BadRequestException(`Unknown option "${key}"`);
  const fail = (message: string) => {
    throw new BadRequestException(message);
  };
  if ('countries' in raw) {
    const c = subset(raw.countries, MOTN_CHART_COUNTRIES);
    if (!c?.length || c.length > STREAMING_CHARTS_MAX_COUNTRIES)
      fail(
        `Countries must be 1–${STREAMING_CHARTS_MAX_COUNTRIES} distinct values of ${MOTN_CHART_COUNTRIES.join(', ')}`,
      );
  }
  if ('services' in raw && !subset(raw.services, STREAMING_TOP_SERVICES)?.length)
    fail(`Services must be distinct values of ${STREAMING_TOP_SERVICES.join(', ')}`);
  if ('monthlyBudget' in raw && int(raw.monthlyBudget, 1, 1_000_000) === null)
    fail('Monthly budget must be an integer 1–1000000');
  if ('reserve' in raw && int(raw.reserve, 0, 1000) === null)
    fail('Reserve must be an integer 0–1000');
  if ('retentionDays' in raw && int(raw.retentionDays, 2, 90) === null)
    fail('Retention must be an integer 2–90 days');
  if ('watchforge' in raw && typeof raw.watchforge !== 'boolean')
    fail('WatchForge must be true or false');
  const config = resolveStreamingChartsConfig(raw);
  const usable = config.monthlyBudget - config.reserve;
  const projected = projectedMonthlyCalls(config);
  if (projected > usable)
    fail(
      `${config.services.length} services × ${config.countries.length} countries × 31 days = ${projected} calls, over the ${usable}-call budget (monthly budget minus reserve)`,
    );
  return config;
}
