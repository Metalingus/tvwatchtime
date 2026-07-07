import React, { useEffect } from 'react';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider, useAuth } from '../context/AuthContext';
import { colors } from '../theme/theme';
import { View, ActivityIndicator } from 'react-native';

SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
});

function Gate() {
  const { loading, user } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    const inAuthGroup = segments[0] === '(auth)';
    const needsPasswordChange = !!user?.mustChangePassword;
    if (!user && !inAuthGroup) {
      queryClient.clear();
      router.replace('/(auth)/login');
    } else if (user && needsPasswordChange && segments[1] !== 'change-password') {
      router.replace('/(auth)/change-password');
    } else if (user && !needsPasswordChange && inAuthGroup && segments[1] !== 'change-password') {
      router.replace('/(tabs)/shows');
    }
  }, [user, loading, segments]);

  useEffect(() => {
    if (!loading) SplashScreen.hideAsync();
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
