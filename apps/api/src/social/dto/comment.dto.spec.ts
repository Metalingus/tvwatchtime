import { isAllowedGifUrl } from './comment.dto';

describe('GIF URLs from any provider', () => {
  it.each([
    'https://media.giphy.com/media/abc/giphy.gif',
    'https://media4.giphy.com/media/abc/200.gif',
    'https://media.tenor.com/abc/tenor.gif',
    'https://cdn.klipy.com/abc.gif',
    'https://another-provider.example/asset?id=123',
  ])('accepts a public HTTPS URL: %s', (url) => {
    expect(isAllowedGifUrl(url)).toBe(true);
  });
  it.each([
    'http://media.giphy.com/a.gif',
    'data:image/gif;base64,AAAA',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'https://localhost/a.gif',
    'https://localhost./a.gif',
    'https://machine.local/a.gif',
    'https://127.0.0.1/a.gif',
    'https://[::1]/a.gif',
    'https://user:password@media.giphy.com/a.gif',
    '',
    undefined,
    'not a url',
    'https://media.giphy.com/' + 'x'.repeat(2048),
  ])('rejects a non-public or invalid URL: %s', (url) => {
    expect(isAllowedGifUrl(url)).toBe(false);
  });
});
