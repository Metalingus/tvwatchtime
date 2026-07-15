import React, { useCallback, useState } from 'react';
import { FlatList, Pressable, RefreshControl, View } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Header, IconButton } from '../../components/Header';
import { Button, Card, EmptyState, Screen, T } from '../../components/primitives';
import { useContactThreads } from '../../api/hooks';
import { useAppearance } from '../../context/PreferencesProvider';
import { useTranslation } from 'react-i18next';
import { spacing, radius } from '../../theme/theme';
import { timeAgo } from '../../components/cards';

export default function ContactListScreen() {
  const { tokens } = useAppearance();
  const { t } = useTranslation(['contact', 'common']);
  const { data, isLoading, refetch, isRefetching } = useContactThreads();
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refetch();
    setRefreshing(false);
  }, [refetch]);
  const items = data?.items ?? [];

  return (
    <Screen>
      <Header
        title={t('contact:title')}
        showBack
        right={
          <IconButton icon="create-outline" onPress={() => router.push('/contact/new' as any)} />
        }
      />
      {isLoading ? null : items.length === 0 ? (
        <EmptyState
          title={t('contact:noThreads')}
          subtitle={t('contact:noThreadsDesc')}
          icon="chatbubbles-outline"
          cta={t('contact:newMessage')}
          onCta={() => router.push('/contact/new' as any)}
        />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(i) => i.id}
          contentContainerStyle={{ padding: spacing.lg }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing || isRefetching}
              onRefresh={onRefresh}
              colors={[tokens.primary]}
              tintColor={tokens.primary}
            />
          }
          ItemSeparatorComponent={() => <View style={{ height: spacing.md }} />}
          renderItem={({ item }) => (
            <Pressable onPress={() => router.push(`/contact/${item.id}` as any)}>
              <Card style={{ padding: spacing.md }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                  <T variant="h2" style={{ flex: 1 }} numberOfLines={1}>
                    {item.subject}
                  </T>
                  {item.unreadForUser ? (
                    <View
                      style={{
                        width: 9,
                        height: 9,
                        borderRadius: 5,
                        backgroundColor: tokens.primary,
                      }}
                    />
                  ) : null}
                </View>
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    marginTop: 2,
                    gap: spacing.sm,
                  }}
                >
                  <T variant="caption" style={{ color: tokens.primary }}>
                    {t(`contact:reason.${reasonKey(item.reason)}`)}
                  </T>
                  {item.status === 'CLOSED' ? (
                    <T variant="micro" muted>
                      {t('contact:closed')}
                    </T>
                  ) : null}
                </View>
                {item.lastMessagePreview ? (
                  <T variant="caption" muted numberOfLines={2} style={{ marginTop: 4 }}>
                    {item.lastMessagePreview}
                  </T>
                ) : null}
                <T variant="micro" muted style={{ marginTop: 6 }}>
                  {timeAgo(item.lastMessageAt)}
                </T>
              </Card>
            </Pressable>
          )}
        />
      )}
    </Screen>
  );
}

function reasonKey(reason: string): string {
  switch (reason) {
    case 'BUG_REPORT':
      return 'bugReport';
    case 'PERSONAL_INFO':
      return 'personalInfo';
    case 'FEEDBACK':
      return 'feedback';
    case 'DATA':
      return 'data';
    case 'ACCOUNT':
      return 'account';
    default:
      return 'other';
  }
}
