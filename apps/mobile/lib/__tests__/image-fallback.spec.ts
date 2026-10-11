import { resolveImageFallback } from '../image-fallback';

describe('resolveImageFallback', () => {
  const role = 'https://artworks.example/role.jpg';
  const portrait = 'https://image.example/portrait.jpg';

  it('loads the primary first and allows one fallback', () => {
    expect(resolveImageFallback(role, portrait, null)).toEqual({ uri: role, canFallback: true });
  });

  it('switches to the fallback after the primary fails, without looping', () => {
    expect(resolveImageFallback(role, portrait, role)).toEqual({
      uri: portrait,
      canFallback: false,
    });
  });

  it('retries a new primary in a recycled cell', () => {
    const next = 'https://artworks.example/other.jpg';
    expect(resolveImageFallback(next, portrait, role)).toEqual({ uri: next, canFallback: true });
  });

  it('has nothing to fall back to without a distinct fallback', () => {
    expect(resolveImageFallback(portrait, portrait, null)).toEqual({
      uri: portrait,
      canFallback: false,
    });
    expect(resolveImageFallback(role, null, null)).toEqual({ uri: role, canFallback: false });
    expect(resolveImageFallback(null, portrait, null)).toEqual({ uri: null, canFallback: false });
  });
});
