import { useEffect } from 'react';
import { Redirect, Tabs, router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as WebBrowser from 'expo-web-browser';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../context/AuthContext';
import { useAppearance } from '../../context/PreferencesProvider';
import { usePushNotifications } from '../../hooks/usePushNotifications';
import { useWebPush } from '../../hooks/useWebPush';
import { tokenStorage } from '../../api/storage';
import { showDialog } from '../../lib/dialog';

const DISCORD_URL = 'https://discord.gg/g9JBPUeqQV';
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

export default function TabsLayout() {
  const { user } = useAuth();
  const { t } = useTranslation(['navigation', 'common']);
  const { tokens } = useAppearance();
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
        showDialog({
          title: 'Welcome to TVWatchTime! 🎬',
          description:
            'You can import your full watch history, watchlist, and favorites from TV Time. Go to your Profile → Import to upload your TV Time .zip file.',
          buttons: [
            { label: 'Maybe later', variant: 'secondary' },
            { label: 'Go to Import', variant: 'primary', onPress: () => router.push('/import') },
          ],
        });
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
        showDialog({
          title: 'Join the Community 💬',
          description:
            'Come hang out with other TVWatchTime users on Discord. Share what you\'re watching, request features, report bugs, and help shape the app.',
          buttons: [
            { label: 'Never', variant: 'danger', onPress: () => tokenStorage.setDiscordNeverShow() },
            { label: 'Later', variant: 'secondary' },
            { label: 'Join', variant: 'primary', onPress: () => WebBrowser.openBrowserAsync(DISCORD_URL) },
          ],
        });
      }, 3000);
    })();
  }, [user]);

  if (!user) return <Redirect href="/(auth)/login" />;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: { backgroundColor: tokens.tabBarBackground, borderTopColor: tokens.border, height: 60, paddingBottom: 6 },
        tabBarActiveTintColor: tokens.primary,
        tabBarInactiveTintColor: tokens.textMuted,
        tabBarLabelStyle: { fontSize: 11, fontWeight: '700' },
      }}
    >
      <Tabs.Screen
        name="shows"
        options={{
          title: t('navigation:tabs.shows'),
          tabBarIcon: ({ color }) => <Ionicons name="tv" size={24} color={color} />,
        }}
      />
      <Tabs.Screen
        name="movies"
        options={{
          title: t('navigation:tabs.movies'),
          tabBarIcon: ({ color }) => <Ionicons name="film" size={24} color={color} />,
        }}
      />
      <Tabs.Screen
        name="explore"
        options={{
          title: t('navigation:tabs.explore'),
          tabBarIcon: ({ color }) => <Ionicons name="compass" size={24} color={color} />,
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: t('navigation:tabs.profile'),
          tabBarIcon: ({ color }) => <Ionicons name="person" size={24} color={color} />,
        }}
      />
    </Tabs>
  );
}
