import { BadRequestException } from '@nestjs/common';
import {
  STREAMING_CHARTS_DEFAULT_CONFIG,
  projectedMonthlyCalls,
  resolveStreamingChartsConfig,
  validateStreamingChartsConfig,
} from './streaming-charts.config';

describe('streaming chart options', () => {
  it('projects one call per service per country per day', () => {
    expect(projectedMonthlyCalls({ services: ['netflix', 'hbo'], countries: ['US'] }, 28)).toBe(56);
    expect(projectedMonthlyCalls(STREAMING_CHARTS_DEFAULT_CONFIG)).toBe(155);
  });

  it('resolves stored options against defaults without failing a run', () => {
    expect(resolveStreamingChartsConfig(null)).toEqual(STREAMING_CHARTS_DEFAULT_CONFIG);
    expect(
      resolveStreamingChartsConfig({ countries: ['FR', 'XX'], services: [], reserve: -1 }),
    ).toEqual(STREAMING_CHARTS_DEFAULT_CONFIG);
    expect(
      resolveStreamingChartsConfig({ countries: ['FR', 'US'], watchforge: false }),
    ).toMatchObject({
      countries: ['FR', 'US'],
      watchforge: false,
    });
  });

  it('validates admin edits strictly, including the monthly budget', () => {
    expect(validateStreamingChartsConfig({ countries: ['US', 'FR'] }).countries).toEqual([
      'US',
      'FR',
    ]);
    // The documented maximum (5 services × 6 countries = 930) fits the default reserve.
    expect(() =>
      validateStreamingChartsConfig({ countries: ['US', 'FR', 'DE', 'ES', 'IT', 'BR'] }),
    ).not.toThrow();
    expect(() =>
      validateStreamingChartsConfig({
        countries: ['US', 'FR', 'DE', 'ES', 'IT', 'BR'],
        reserve: 100,
      }),
    ).toThrow(/930 calls, over the 900-call budget/);
    for (const bad of [
      { countries: ['US', 'US'] },
      { countries: ['XX'] },
      { countries: [] },
      { countries: ['US', 'FR', 'DE', 'ES', 'IT', 'BR', 'JP'] },
      { services: ['hulu'] },
      { reserve: 1.5 },
      { watchforge: 'yes' },
      { pages: 2 },
      [],
    ]) {
      expect(() => validateStreamingChartsConfig(bad)).toThrow(BadRequestException);
    }
  });
});
