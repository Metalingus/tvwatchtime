import { signAccountRestoreToken, verifyAccountRestoreToken } from './restore-token';

const SECRET = 'test-secret-value-1234';

describe('account restore token', () => {
  it('round-trips the original user id', () => {
    const token = signAccountRestoreToken(SECRET, 'cku1abc');
    expect(verifyAccountRestoreToken(SECRET, token)).toBe('cku1abc');
  });

  it('rejects a token signed with another secret', () => {
    const token = signAccountRestoreToken('another-secret-value', 'cku1abc');
    expect(verifyAccountRestoreToken(SECRET, token)).toBeNull();
  });

  it('rejects a forged user id with a copied signature', () => {
    const [version, , signature] = signAccountRestoreToken(SECRET, 'cku1abc').split('.');
    expect(verifyAccountRestoreToken(SECRET, `${version}.victim.${signature}`)).toBeNull();
  });

  it.each([null, 42, '', 'v1.only-two', 'v2.cku1abc.sig', 'v1.bad id.sig', 'v1.a.b.c'])(
    'rejects malformed input %p',
    (token) => {
      expect(verifyAccountRestoreToken(SECRET, token)).toBeNull();
    },
  );

  it('rejects everything when no secret is configured', () => {
    const token = signAccountRestoreToken(SECRET, 'cku1abc');
    expect(verifyAccountRestoreToken('', token)).toBeNull();
  });
});
