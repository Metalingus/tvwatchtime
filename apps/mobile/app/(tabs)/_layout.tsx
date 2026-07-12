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

  useEffect(() => {
    if (!user) return;

    // 1. First-time import popup
    (async () => {
      const shown = await tokenStorage.getImportPopupShown();
      if (!shown) {
        await tokenStorage.setImportPopupShown();
        await tokenStorage.setDiscordLastShown(Date.now());
        showDialog({
          title: t('common:welcomeTitle'),
          description: t('common:welcomeDesc'),
          buttons: [
            { label: t('common:maybeLater'), variant: 'secondary' },
            { label: t('common:goToImport'), variant: 'primary', onPress: () => router.push('/import') },
          ],
        });
      }
    })();

    // 2. Periodic Discord popup
    (async () => {
      const neverShow = await tokenStorage.getDiscordNeverShow();
      if (neverShow) return;
      const lastShown = await tokenStorage.getDiscordLastShown();
      const now = Date.now();
      if (lastShown && now - lastShown < THREE_DAYS_MS) return;

      setTimeout(async () => {
        await tokenStorage.setDiscordLastShown(now);
        showDialog({
          title: t('common:discordTitle'),
          description: t('common:discordDesc'),
          buttons: [
            { label: t('common:never'), variant: 'danger', onPress: () => tokenStorage.setDiscordNeverShow() },
            { label: t('common:later'), variant: 'secondary' },
            { label: t('common:join'), variant: 'primary', onPress: () => WebBrowser.openBrowserAsync(DISCORD_URL) },
          ],
        });
      }, 3000);
    })();
  }, [user, t]);

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
