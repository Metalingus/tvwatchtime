import React, { useCallback, useEffect, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  TextInput,
  View,
} from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { Header } from '../../components/Header';
import { Screen, Spinner, T } from '../../components/primitives';
import { useReplyContactThread, useContactThread } from '../../api/hooks';
import { useAppearance } from '../../context/PreferencesProvider';
import { useTranslation } from 'react-i18next';
import { spacing, radius } from '../../theme/theme';

export default function ContactDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { tokens } = useAppearance();
  const { t } = useTranslation(['contact', 'common']);
  const { data, isLoading, refetch, isRefetching } = useContactThread(id);
  const reply = useReplyContactThread(id);
  const [text, setText] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refetch();
    setRefreshing(false);
  }, [refetch]);

  const send = async () => {
    const body = text.trim();
    if (!body) return;
    setText('');
    try {
      await reply.mutateAsync(body);
      refetch();
    } catch {}
  };

  const messages = data?.messages ?? [];
  const closed = data?.status === 'CLOSED';

  return (
    <Screen>
      <Header title={data?.subject ?? t('contact:title')} showBack />
      {isLoading ? (
        <Spinner />
      ) : (
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <FlatList
            data={messages}
            keyExtractor={(m) => m.id}
            contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.md }}
            refreshControl={
              <RefreshControl
                refreshing={refreshing || isRefetching}
                onRefresh={onRefresh}
                colors={[tokens.primary]}
                tintColor={tokens.primary}
              />
            }
            ItemSeparatorComponent={() => <View style={{ height: spacing.md }} />}
            renderItem={({ item }) => {
              const mine = item.authorRole === 'USER';
              return (
                <View
                  style={{ flexDirection: 'row', justifyContent: mine ? 'flex-end' : 'flex-start' }}
                >
                  <View
                    style={{
                      maxWidth: '82%',
                      backgroundColor: mine ? tokens.primary : tokens.surfaceElevated,
                      paddingHorizontal: spacing.md,
                      paddingVertical: spacing.sm + 2,
                      borderRadius: radius.lg,
                      borderBottomRightRadius: mine ? radius.sm : radius.lg,
                      borderBottomLeftRadius: mine ? radius.lg : radius.sm,
                    }}
                  >
                    {!mine ? (
                      <T
                        variant="micro"
                        style={{ color: tokens.primary, marginBottom: 2, fontWeight: '700' }}
                      >
                        {t('contact:admin')}
                      </T>
                    ) : null}
                    <T
                      variant="body"
                      style={{ color: mine ? tokens.primaryForeground : tokens.textPrimary }}
                    >
                      {item.body}
                    </T>
                  </View>
                </View>
              );
            }}
          />
          {closed ? (
            <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.md }}>
              <T variant="caption" muted>
                {t('contact:closedHint')}
              </T>
            </View>
          ) : null}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'flex-end',
              paddingHorizontal: spacing.lg,
              paddingVertical: spacing.sm,
              gap: spacing.sm,
              borderTopWidth: 1,
              borderTopColor: tokens.border,
            }}
          >
            <TextInput
              value={text}
              onChangeText={setText}
              placeholder={t('contact:replyPlaceholder')}
              placeholderTextColor={tokens.placeholder}
              multiline
              style={{
                flex: 1,
                minHeight: 40,
                maxHeight: 120,
                paddingHorizontal: spacing.md,
                paddingVertical: spacing.sm,
                borderRadius: radius.lg,
                backgroundColor: tokens.inputBackground,
                color: tokens.textPrimary,
                borderWidth: 1,
                borderColor: tokens.border,
              }}
            />
            <Pressable
              onPress={send}
              disabled={reply.isPending || !text.trim()}
              style={{
                width: 40,
                height: 40,
                borderRadius: 20,
                backgroundColor: text.trim() ? tokens.primary : tokens.surfaceElevated,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <T
                variant="h2"
                style={{ color: text.trim() ? tokens.primaryForeground : tokens.textMuted }}
              >
                ↑
              </T>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      )}
    </Screen>
  );
}
