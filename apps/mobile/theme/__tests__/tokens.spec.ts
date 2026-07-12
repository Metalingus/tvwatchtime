import { buildTokens, TOKEN_KEYS, type Tokens, type ResolvedTheme } from '@tvwatch/shared';

describe('design tokens', () => {
  const light = buildTokens('light' as ResolvedTheme);
  const dark = buildTokens('dark' as ResolvedTheme);

  it('light and dark expose exactly the same keys', () => {
    expect(Object.keys(light).sort()).toEqual(Object.keys(dark).sort());
  });

  it('token keys mirror the Tokens interface fields (incl. new media/control tokens)', () => {
    // TOKEN_KEYS is generated from the dark palette; both palettes must cover it.
    for (const key of TOKEN_KEYS) {
      expect(light).toHaveProperty(key);
      expect(dark).toHaveProperty(key);
    }
    // New tokens added by the theme migration must be present.
    expect(light).toHaveProperty('mediaText');
    expect(light).toHaveProperty('mediaScrim');
    expect(light).toHaveProperty('mediaGradient');
    expect(light).toHaveProperty('controlThumb');
    expect(dark).toHaveProperty('mediaText');
    expect(dark).toHaveProperty('mediaScrim');
    expect(dark).toHaveProperty('mediaGradient');
    expect(dark).toHaveProperty('controlThumb');
  });

  it('no token is undefined or empty', () => {
    const check = (t: Tokens) => {
      for (const key of Object.keys(t) as (keyof Tokens)[]) {
        const v = t[key];
        expect(v).not.toBeUndefined();
        expect(v).not.toBe('');
        if (Array.isArray(v)) {
          expect(v.length).toBe(2);
          expect(v.every((s) => typeof s === 'string' && s.length > 0)).toBe(true);
        }
      }
    };
    check(light);
    check(dark);
  });

  it('gradient and mediaGradient are 2-stop tuples', () => {
    expect(light.gradient.length).toBe(2);
    expect(dark.gradient.length).toBe(2);
    expect(light.mediaGradient.length).toBe(2);
    expect(dark.mediaGradient.length).toBe(2);
  });

  it('media tokens stay dark/white in both themes (media owns its contrast)', () => {
    // Media text is white and the media gradient darkens artwork bottoms in both themes,
    // so white text stays legible regardless of the resolved UI theme.
    expect(light.mediaText).toBe(dark.mediaText);
    expect(light.mediaScrim).toBe(dark.mediaScrim);
    expect(light.mediaGradient).toEqual(dark.mediaGradient);
    expect(light.controlThumb).toBe(dark.controlThumb);
  });

  it('brand primary (yellow) and primaryForeground are stable across themes', () => {
    expect(light.primary).toBe(dark.primary);
    expect(light.primaryForeground).toBe(dark.primaryForeground);
    // primaryForeground must be dark so text-on-yellow is legible in light mode too.
    expect(light.primaryForeground).toBe('#0F1115');
  });
});
