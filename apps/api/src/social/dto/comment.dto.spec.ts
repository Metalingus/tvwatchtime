import { isAllowedGiphyUrl } from './comment.dto';

describe('isAllowedGiphyUrl', () => {
  it('accepts https media.giphy.com URLs', () => {
    expect(isAllowedGiphyUrl('https://media.giphy.com/media/abc/giphy.gif')).toBe(true);
  });
  it('accepts https mediaN.giphy.com subdomains', () => {
    expect(isAllowedGiphyUrl('https://media1.giphy.com/media/abc/200.gif')).toBe(true);
  });
  it('accepts exact giphy.com host', () => {
    expect(isAllowedGiphyUrl('https://giphy.com/gifs/abc-xyz')).toBe(true);
  });
  it('rejects http URLs', () => {
    expect(isAllowedGiphyUrl('http://media.giphy.com/media/abc/giphy.gif')).toBe(false);
  });
  it('rejects non-GIPHY hosts', () => {
    expect(isAllowedGiphyUrl('https://example.com/x.gif')).toBe(false);
    expect(isAllowedGiphyUrl('https://giphy.com.evil.com/x.gif')).toBe(false);
    expect(isAllowedGiphyUrl('https://evilsomethinggiphy.com/x.gif')).toBe(false);
  });
  it('rejects data:, file:, javascript: schemes', () => {
    expect(isAllowedGiphyUrl('data:image/gif;base64,AAAA')).toBe(false);
    expect(isAllowedGiphyUrl('file:///etc/passwd')).toBe(false);
    expect(isAllowedGiphyUrl('javascript:alert(1)')).toBe(false);
  });
  it('rejects localhost and malformed input', () => {
    expect(isAllowedGiphyUrl('https://localhost/x')).toBe(false);
    expect(isAllowedGiphyUrl('')).toBe(false);
    expect(isAllowedGiphyUrl(undefined)).toBe(false);
    expect(isAllowedGiphyUrl('not a url')).toBe(false);
  });
  it('rejects oversized URLs', () => {
    const big = 'https://media.giphy.com/media/abc/giphy.gif?' + 'x'.repeat(2100);
    expect(isAllowedGiphyUrl(big)).toBe(false);
  });
});
