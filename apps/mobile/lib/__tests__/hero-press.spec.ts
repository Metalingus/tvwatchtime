import { isHeaderNearMiss } from '../hero-press';

describe('isHeaderNearMiss', () => {
  // Hero at window y=0, 47px status bar inset + 48px header + 12px slop.
  const band = 47 + 48 + 12;

  it('ignores taps in the header band and just below it', () => {
    expect(isHeaderNearMiss(60, 0, band)).toBe(true);
    expect(isHeaderNearMiss(106, 0, band)).toBe(true);
  });

  it('keeps taps below the band as gallery taps', () => {
    expect(isHeaderNearMiss(107, 0, band)).toBe(false);
    expect(isHeaderNearMiss(200, 0, band)).toBe(false);
  });

  it('measures relative to the hero when the page is scrolled', () => {
    // Hero scrolled 80px up: a tap at window y=20 is 100px into the hero (in the band).
    expect(isHeaderNearMiss(20, -80, band)).toBe(true);
    expect(isHeaderNearMiss(40, -80, band)).toBe(false);
  });

  it('falls back to a gallery tap when coordinates are unknown', () => {
    expect(isHeaderNearMiss(undefined, 0, band)).toBe(false);
    expect(isHeaderNearMiss(60, Number.NaN, band)).toBe(false);
  });
});
