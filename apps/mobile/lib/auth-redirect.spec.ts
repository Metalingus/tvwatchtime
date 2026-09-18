import { authRedirect } from './auth-redirect';

const base = {
  loading: false,
  authenticated: true,
  needsPasswordChange: false,
  onboardingDone: true,
  segments: ['expo-auth-session'],
};

it('leaves the OAuth spinner immediately after an existing account session is saved', () => {
  expect(authRedirect(base)).toBe('/(tabs)/shows');
});

it('keeps an unauthenticated OAuth callback mounted while code exchange runs', () => {
  expect(authRedirect({ ...base, authenticated: false })).toBeNull();
});

it('waits for session bootstrap before choosing a destination', () => {
  expect(authRedirect({ ...base, loading: true })).toBeNull();
});

it('sends a new social account to onboarding', () => {
  expect(authRedirect({ ...base, onboardingDone: false })).toBe('/onboarding');
});

it('preserves mandatory password change priority', () => {
  expect(authRedirect({ ...base, needsPasswordChange: true, onboardingDone: false })).toBe(
    '/(auth)/change-password',
  );
});

it('keeps completed users on onboarding when they deliberately reopen it', () => {
  expect(authRedirect({ ...base, segments: ['onboarding', 'index'] })).toBeNull();
});

it.each(['login', 'register'])('still finishes ordinary %s sessions', (page) => {
  expect(authRedirect({ ...base, segments: ['(auth)', page] })).toBe('/(tabs)/shows');
});

it('keeps signed-out users on login and redirects protected screens to login', () => {
  expect(authRedirect({ ...base, authenticated: false, segments: ['(auth)', 'login'] })).toBeNull();
  expect(authRedirect({ ...base, authenticated: false, segments: ['show', '[id]'] })).toBe(
    '/(auth)/login',
  );
});

it('does not interrupt an authenticated detail screen', () => {
  expect(authRedirect({ ...base, segments: ['show', '[id]'] })).toBeNull();
});
