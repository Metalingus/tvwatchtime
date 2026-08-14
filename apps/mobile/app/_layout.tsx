import React, { useEffect, useRef } from 'react';
import { InteractionManager, Platform, View, ActivityIndicator } from 'react-native';
import '../utils/alert-polyfill'; // Web safety-net: routes residual Alert.alert to themed dialog
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import * as WebBrowser from 'expo-web-browser';
import { QueryClient } from '@tanstack/react-query';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';

WebBrowser.maybeCompleteAuthSession();
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { AuthProvider, useAuth } from '../context/AuthContext';
import { PreferencesProvider, useAppearance } from '../context/PreferencesProvider';
import { DialogProvider } from '../components/DialogProvider';
import { ToastHost } from '../components/ToastHost';
import { useNotificationNavigation } from '../hooks/useNotificationNavigation';
import { initAnalytics } from '../lib/analytics';
import { isOnboardingDone } from '../lib/onboarding/draft';
import { serializeQueryClient } from '../lib/query-persistence';
import { WEB_PORTRAIT_MAX_WIDTH } from '../hooks/useContentWidth';
import { installIosWebInputZoomGuard } from '../utils/web-input-zoom';
import { useIntegrationForegroundSync } from '../hooks/useIntegrationForegroundSync';

if (Platform.OS !== 'web') {
  SplashScreen.preventAutoHideAsync();
  initAnalytics();
}

const queryClient = new QueryClient({
  // 5-min staleTime: server caches are invalidated on every user action (watch,
  // watchlist, pause, import), so data stays correct without constant refetches.
  // refetchOnWindowFocus stays on for native (app-foreground refresh of stale
  // queries) but off on web: every browser alt-tab refocus would otherwise storm
  // all mounted queries (watchNext, 4× 500-item lists, stats, …) at once.
  defaultOptions: {
    queries: {
      staleTime: 5 * 60_000,
      retry: 1,
      refetchOnWindowFocus: Platform.OS !== 'web',
    },
  },
});

function Gate() {
  const { loading, user } = useAuth();
  const { tokens, resolvedTheme } = useAppearance();
  const insets = useSafeAreaInsets();
  const segments = useSegments();
  const router = useRouter();
  const segmentsRef = useRef(segments);
  segmentsRef.current = segments;
  const needsPasswordChange = !!user?.mustChangePassword;
  useIntegrationForegroundSync(!loading && user && !needsPasswordChange ? user.id : null);
  // Server onboarding fields ride on /me; the stored user doubles as the local
  // cache so cold starts don't flicker (hybrid server + device state). Users cached
  // by an older app version lack the fields — treat them as done until /me refreshes
  // rather than flashing onboarding at long-time users.
  const onboardingDone =
    user?.onboardingStatus === undefined
      ? true
      : isOnboardingDone(user?.onboardingStatus, user?.onboardingVersion);

  // Navigate on push-notification tap (whitelisted action or legacy deep link).
  useNotificationNavigation();

  // Register service worker on web (for PWA + push notifications)
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    installIosWebInputZoomGuard(typeof document === 'undefined' ? undefined : document);
    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator)
      navigator.serviceWorker.register('/sw.js').catch(() => {});
  }, []);

  useEffect(() => {
    if (loading) return;
    const segs = segmentsRef.current;
    const inAuthGroup = segs[0] === '(auth)';
    if (!user && !inAuthGroup) {
      queryClient.clear();
      // Detail payloads are per-user (userProgress, inWatchlist, votes) — drop
      // the persisted cache too or the next account on this device would
      // restore the previous user's state.
      void queryPersister.removeClient();
      router.replace('/(auth)/login');
    } else if (user && needsPasswordChange && segs[1] !== 'change-password') {
      router.replace('/(auth)/change-password');
    } else if (
      user &&
      !needsPasswordChange &&
      !onboardingDone &&
      (segs[0] as string) !== 'onboarding'
    ) {
      // Quick-setup onboarding: exactly once per user/version, right after auth.
      router.replace('/onboarding' as any);
    } else if (user && !needsPasswordChange && onboardingDone && inAuthGroup) {
      router.replace('/(tabs)/shows');
    }
    // Note: onboarding routes are never redirected AWAY from — completed/skipped
    // users may deliberately reopen Quick setup from Settings.
  }, [user, loading, onboardingDone]);

  useEffect(() => {
    if (!loading && Platform.OS !== 'web') SplashScreen.hideAsync();
  }, [loading]);
  if (loading) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: tokens.background,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <ActivityIndicator color={tokens.primary} size="large" />
      </View>
    );
  }
  const androidBottomInset = Platform.OS === 'android' ? insets.bottom : 0;
  return (
    <Stack
      screenOptions={({ route }) => {
        // Tabs, auth, and onboarding already own their safe-area spacing. Root-pushed screens
        // do not, so Android edge-to-edge navigation would otherwise cover their bottom content.
        const managesOwnSafeArea = ['(tabs)', '(auth)', 'onboarding'].includes(route.name);
        return {
          headerShown: false,
          contentStyle: {
            backgroundColor: tokens.background,
            paddingBottom: managesOwnSafeArea ? 0 : androidBottomInset,
          },
        };
      }}
    >
      <Stack.Screen name="(auth)" />
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="onboarding" />
      // Detail screens use the default card push (NOT presentation:'modal'): a native // modal
      screen on iOS renders above the app-root dialog host, so root RN Modals // opened from these
      screens appeared underneath (dead taps) and could orphan // after pop (frozen backdrop). Card
      presentation keeps dialogs working.
      <Stack.Screen name="show/[id]" />
      <Stack.Screen name="movie/[id]" />
      <Stack.Screen name="episode/[id]" />
      <Stack.Screen name="stats" />
      <Stack.Screen name="notifications" />
      <Stack.Screen name="import" />
      <Stack.Screen name="more" />
      <Stack.Screen name="myshows" />
      <Stack.Screen name="list/[id]" />
      <Stack.Screen name="create-list" />
      <Stack.Screen name="my-lists" />
      <Stack.Screen name="followed-lists" />
      <Stack.Screen name="find-user" />
      <Stack.Screen name="user/[username]" />
      <Stack.Screen name="user/[username]/more" />
      <Stack.Screen name="follows" />
    </Stack>
  );
}

function RootShell() {
  const { resolvedTheme, tokens } = useAppearance();
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: Platform.OS === 'web' ? tokens.surfaceAlt : tokens.background,
      }}
    >
      <View
        style={[
          { flex: 1, backgroundColor: tokens.background },
          Platform.OS === 'web' && {
            width: '100%',
            maxWidth: WEB_PORTRAIT_MAX_WIDTH,
            alignSelf: 'center',
            overflow: 'hidden',
            borderLeftWidth: 1,
            borderRightWidth: 1,
            borderColor: tokens.border,
          },
        ]}
      >
        <StatusBar style={resolvedTheme === 'dark' ? 'light' : 'dark'} />
        <Gate />
      </View>
    </View>
  );
}

/**
 * Detail payloads + main-tab first-paint queries persist to AsyncStorage so the
 * app reopens INSTANTLY after a restart (stale-while-revalidate: cached render,
 * background refetch, smooth in-place update). The dangers of persisting tabs,
 * and how they're contained here:
 *  - Size: Android AsyncStorage caps at 6MB. User-paged collections (movies tab)
 *    are truncated to their first pages at serialize time; bucket/history/past
 *    pager pages and search/discover-result pages are never persisted.
 *  - Write amplification: every cache change re-serializes the dehydrated set,
 *    so it stays lean (details + first paints only) and writes are throttled.
 *  - Staleness: server invalidates watch-next/upcoming on every user action and
 *    restored queries refetch in the background on mount; per-user leakage on
 *    logout is prevented by removeClient() in Gate.
 *  - Shape drift across app versions: bump `buster` to drop stale restores.
 * maxAge matches the 24h gcTime on detail queries.
 */
const queryPersister = createAsyncStoragePersister({
  storage: AsyncStorage,
  // Short throttle: narrows the window where a killed app's last persisted
  // snapshot still holds in-flight optimistic mutation state.
  throttleTime: 1000,
  serialize: serializeQueryClient,
});
/** Detail payloads (24h gcTime) — instant detail screens. */
const PERSISTED_DETAIL_ROOTS = new Set([
  'show',
  'movie',
  'episode',
  'showEpisodes',
  'episodeSiblings',
  'person',
]);
/** Main-tab first paints. Excludes pager slices (watchNext bucket/history,
 *  upcoming past) and single-shot variants — those refetch on demand. */
const isPersistedTabQuery = (key: readonly unknown[]): boolean => {
  switch (key[0]) {
    case 'watchNext':
      return key.length <= 2; // main payload + paused rail
    case 'upcoming':
      return key.length === 1;
    case 'discoverSections':
    case 'forYou':
    case 'genres':
      return true;
    case 'watchlist':
    case 'favorites':
      return key[1] === 'paged'; // movies-tab collections (truncated at serialize)
    case 'movies':
      return key[1] === 'watched' && key[2] === 'paged';
    default:
      return false;
  }
};

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <PersistQueryClientProvider
          client={queryClient}
          persistOptions={{
            persister: queryPersister,
            maxAge: 24 * 60 * 60 * 1000,
            // Bump when a persisted payload's shape changes — stale restores
            // are dropped instead of crashing against a new client.
            buster: 'v2',
            dehydrateOptions: {
              shouldDehydrateQuery: (q) =>
                q.state.status === 'success' &&
                (PERSISTED_DETAIL_ROOTS.has(q.queryKey[0] as string) ||
                  isPersistedTabQuery(q.queryKey)),
            },
          }}
          onSuccess={() => {
            // A restored snapshot is never trusted as fresh: it can contain
            // optimistic mutation state captured mid-flight (app backgrounded
            // within the persister's throttle window, before the server
            // reconcile landed) — e.g. an episode unwatched right before
            // closing the app restoring as Watched. Mark everything stale so
            // mounted queries reconcile in the background; the cached paint
            // stays on screen and the corrected data swaps in smoothly.
            //
            // Deferred until after first-paint interactions settle: invalidating
            // synchronously on restore fired a refetch storm for every mounted
            // query on the exact frames where disk-cached images needed the JS
            // thread for their load events — posters sat blank for seconds on
            // cold start even though the bytes were already on disk.
            InteractionManager.runAfterInteractions(() => {
              void queryClient.invalidateQueries();
            });
          }}
        >
          <AuthProvider>
            <PreferencesProvider>
              <DialogProvider>
                <RootShell />
                <ToastHost />
              </DialogProvider>
            </PreferencesProvider>
          </AuthProvider>
        </PersistQueryClientProvider>
      </GestureHandlerRootView>
    </SafeAreaProvider>
  );
}
