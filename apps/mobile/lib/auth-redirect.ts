type AuthDestination =
  '/(auth)/login' | '/(auth)/change-password' | '/onboarding' | '/(tabs)/shows';

/** One navigation decision for session changes, including browser OAuth returns. */
export function authRedirect({
  loading,
  authenticated,
  needsPasswordChange,
  onboardingDone,
  segments,
}: {
  loading: boolean;
  authenticated: boolean;
  needsPasswordChange: boolean;
  onboardingDone: boolean;
  segments: readonly string[];
}): AuthDestination | null {
  if (loading) return null;
  // OAuth returns to a root route, outside the (auth) group. It must remain
  // mounted during exchange and leave its spinner once the session is saved.
  const authEntry = segments[0] === '(auth)' || segments[0] === 'expo-auth-session';
  if (!authenticated) return authEntry ? null : '/(auth)/login';
  if (needsPasswordChange) {
    return segments[1] === 'change-password' ? null : '/(auth)/change-password';
  }
  if (!onboardingDone && segments[0] !== 'onboarding') return '/onboarding';
  if (onboardingDone && authEntry) return '/(tabs)/shows';
  return null;
}
