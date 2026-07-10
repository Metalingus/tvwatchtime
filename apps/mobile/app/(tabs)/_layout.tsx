import { useEffect } from 'react';
import { Alert } from 'react-native';
import { Redirect, Tabs, router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as WebBrowser from 'expo-web-browser';
import { useAuth } from '../../context/AuthContext';
import { colors } from '../../theme/theme';
import { usePushNotifications } from '../../hooks/usePushNotifications';
import { useWebPush } from '../../hooks/useWebPush';
import { tokenStorage } from '../../api/storage';

const DISCORD_URL = 'https://discord.gg/g9JBPUeqQV';
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

export default function TabsLayout() {
  const { user } = useAuth();
  usePushNotifications(!!user);
  useWebPush(!!user);

  useEffect(() => {
    if (!user) return;

    // 1. First-time import popup
    (async () => {
      const shown = await tokenStorage.getImportPopupShown();
      if (!shown) {
        await tokenStorage.setImportPopupShown();
        // Delay Discord popup to next session (3 days from now)
        await tokenStorage.setDiscordLastShown(Date.now());
        Alert.alert(
          'Welcome to TVWatchTime! 🎬',
          'You can import your full watch history, watchlist, and favorites from TV Time. Go to your Profile → Import to upload your TV Time .zip file.',
          [
            { text: 'Maybe later', style: 'cancel' },
            { text: 'Go to Import', onPress: () => router.push('/import') },
          ],
        );
      }
    })();

    // 2. Periodic Discord popup (every 3 days, unless dismissed forever)
    (async () => {
      const neverShow = await tokenStorage.getDiscordNeverShow();
      if (neverShow) return;
      const lastShown = await tokenStorage.getDiscordLastShown();
      const now = Date.now();
      if (lastShown && now - lastShown < THREE_DAYS_MS) return;

      // Delay popup slightly so it doesn't fight with the import popup
      setTimeout(async () => {
        await tokenStorage.setDiscordLastShown(now);
        Alert.alert(
          'Join the Community 💬',
          'Come hang out with other TVWatchTime users on Discord. Share what you\'re watching, request features, report bugs, and help shape the app.',
          [
            { text: 'Never', onPress: () => tokenStorage.setDiscordNeverShow(), style: 'destructive' },
            { text: 'Later', style: 'cancel' },
            { text: 'Join', onPress: () => WebBrowser.openBrowserAsync(DISCORD_URL) },
          ],
        );
      }, 3000);
    })();
  }, [user]);

  if (!user) return <Redirect href="/(auth)/login" />;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border, height: 60, paddingBottom: 6 },
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarLabelStyle: { fontSize: 11, fontWeight: '700' },
      }}
    >
      <Tabs.Screen
        name="shows"
        options={{
          title: 'Shows',
          tabBarIcon: ({ color }) => <Ionicons name="tv" size={24} color={color} />,
        }}
      />
      <Tabs.Screen
        name="movies"
        options={{
          title: 'Movies',
          tabBarIcon: ({ color }) => <Ionicons name="film" size={24} color={color} />,
        }}
      />
      <Tabs.Screen
        name="explore"
        options={{
          title: 'Explore',
          tabBarIcon: ({ color }) => <Ionicons name="compass" size={24} color={color} />,
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'Profile',
          tabBarIcon: ({ color }) => <Ionicons name="person" size={24} color={color} />,
        }}
      />
    </Tabs>
  );
}
