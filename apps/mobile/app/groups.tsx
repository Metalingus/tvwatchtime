import React from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { COMMUNITY_GROUPS, type CommunityGroup } from '@tvwatch/shared';
import { Header } from '../components/Header';
import { Screen, T } from '../components/primitives';
import { feedColumn } from '../components/comments/layout';
import { useAppearance } from '../context/PreferencesProvider';
import { radius, spacing } from '../theme/theme';

export default function GroupsScreen() {
  const { tokens } = useAppearance();
  const { t } = useTranslation(['groups']);

  const pinned = COMMUNITY_GROUPS.filter((g) => g.pinned);
  const rest = COMMUNITY_GROUPS.filter((g) => !g.pinned);

  const renderRow = (group: CommunityGroup) => (
    <Pressable
      key={group.id}
      onPress={() => router.push(`/group/${group.id}` as any)}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: tokens.cardBackground,
        borderRadius: radius.lg,
        padding: spacing.md,
        marginBottom: spacing.sm,
        opacity: pressed ? 0.85 : 1,
      })}
    >
      <View
        style={{
          width: 40,
          height: 40,
          borderRadius: radius.md,
          backgroundColor: tokens.surfaceElevated,
          alignItems: 'center',
          justifyContent: 'center',
          marginRight: spacing.md,
        }}
      >
        <Ionicons name={group.icon as keyof typeof Ionicons.glyphMap} size={20} color={tokens.primary} />
      </View>
      <T variant="h2" style={{ flex: 1 }}>
        {t(`groups:names.${group.id}`)}
      </T>
      <Ionicons name="chevron-forward" size={18} color={tokens.textMuted} />
    </Pressable>
  );

  return (
    <Screen>
      <Header title={t('groups:title')} showBack />
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.xl }}
      >
        <View style={feedColumn.root}>
          <T variant="caption" muted style={{ marginBottom: spacing.sm, marginTop: spacing.xs }}>
            {t('groups:featured')}
          </T>
          {pinned.map(renderRow)}
          <T variant="caption" muted style={{ marginBottom: spacing.sm, marginTop: spacing.md }}>
            {t('groups:allGroups')}
          </T>
          {rest.map(renderRow)}
        </View>
      </ScrollView>
    </Screen>
  );
}
