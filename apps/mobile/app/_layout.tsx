import React, { useEffect, useRef } from 'react';
import { Platform, View, ActivityIndicator } from 'react-native';
import '../utils/alert-polyfill'; // Patches Alert.alert for web
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import * as WebBrowser from 'expo-web-browser';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

WebBrowser.maybeCompleteAuthSession();
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider, useAuth } from '../context/AuthContext';
import { colors } from '../theme/theme';

if (Platform.OS !== 'web') {
  SplashScreen.preventAutoHideAsync();
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
});

function Gate() {
  const { loading, user } = useAuth();
  const segments = useSegments();
  const router = useRouter();
  const segmentsRef = useRef(segments);
  segmentsRef.current = segments;

  // Register service worker on web (for PWA + push notifications)
  useEffect(() => {
    if (Platform.OS === 'web' && typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  }, []);

  useEffect(() => {
    if (loading) return;
    const segs = segmentsRef.current;
    const inAuthGroup = segs[0] === '(auth)';
    const needsPasswordChange = !!user?.mustChangePassword;
    if (!user && !inAuthGroup) {
      queryClient.clear();
      router.replace('/(auth)/login');
    } else if (user && needsPasswordChange && segs[1] !== 'change-password') {
      router.replace('/(auth)/change-password');
    } else if (user && !needsPasswordChange && inAuthGroup) {
      router.replace('/(tabs)/shows');
    }
  }, [user, loading]);

  useEffect(() => {
    if (!loading && Platform.OS !== 'web') SplashScreen.hideAsync();
  }, [loading]);
  if (loading) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.background, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}>
      <Stack.Screen name="(auth)" />
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="show/[id]" options={{ presentation: 'modal' }} />
      <Stack.Screen name="movie/[id]" options={{ presentation: 'modal' }} />
      <Stack.Screen name="episode/[id]" options={{ presentation: 'modal' }} />
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
      <Stack.Screen name="follows" />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.background }}>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <StatusBar style="light" />
            <Gate />
          </AuthProvider>
        </QueryClientProvider>
      </GestureHandlerRootView>
    </SafeAreaProvider>
  );
}
