import React, { useState } from 'react';
import { Linking, Pressable, View } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useCommsUniSources } from '../../api/commsuni';
import { useAppearance } from '../../context/PreferencesProvider';
import { radius, spacing } from '../../theme/theme';
import { T } from '../primitives';

export function CommsUniAttribution({ leading }: { leading?: React.ReactNode }) {
  const { data } = useCommsUniSources();
  const { tokens } = useAppearance();
  const { t } = useTranslation(['comments', 'common']);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState(false);
  const platforms = [
    data?.sources.find((source) => source.sourceId === 2 || source.slug === 'commsunitv'),
    data?.sources.find((source) => source.slug === 'tvtime'),
  ];
  const icons = (large = false) =>
    platforms.map((source, index) => (
      <View key={index} style={{ marginHorizontal: spacing.xs }}>
        {source?.iconUrl ? (
          <Image
            source={{ uri: source.iconUrl }}
            contentFit="contain"
            accessibilityLabel={source.displayName}
            style={{
              width: large ? spacing.xl * 2 : spacing.xl,
              height: large ? spacing.xl * 2 : spacing.xl,
              borderRadius: radius.pill,
            }}
          />
        ) : (
          <Ionicons
            name="chatbubbles-outline"
            size={large ? spacing.xl * 2 : spacing.xl}
            color={tokens.textMuted}
          />
        )}
      </View>
    ));
  const link = (url: string, label: string) => (
    <Pressable
      accessibilityRole="link"
      onPress={() => {
        void Linking.openURL(url).catch(() => setError(true));
      }}
      style={{ paddingVertical: spacing.sm }}
    >
      <T variant="caption" style={{ color: tokens.textPrimary, textDecorationLine: 'underline' }}>
        {label}
      </T>
    </Pressable>
  );
  return (
    <View style={{ marginBottom: spacing.md }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingVertical: spacing.sm,
          borderBottomWidth: 1,
          borderBottomColor: tokens.border,
        }}
      >
        {leading}
        <Pressable
          onPress={() => setOpen((value) => !value)}
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          accessibilityLabel={
            t('comments:commsuni.attribution') + '. ' + t('comments:commsuni.aboutTitle')
          }
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            flex: 1,
            minWidth: 0,
            marginLeft: leading ? spacing.sm : 0,
            paddingVertical: spacing.xs,
            justifyContent: 'flex-end',
          }}
        >
          <T
            variant="micro"
            muted
            style={{ fontStyle: 'italic', fontWeight: '400', flexShrink: 1 }}
          >
            {t('comments:commsuni.attributionPrefix')}
          </T>
          <View
            style={{
              width: spacing.xl * 5,
              height: spacing.xl,
              overflow: 'hidden',
              borderRadius: radius.sm,
              backgroundColor: tokens.mediaScrim,
              marginHorizontal: spacing.xs,
              flexShrink: 0,
            }}
          >
            <Image
              source={require('../../assets/branding/commsuni_logo_smooth.svg')}
              accessibilityLabel="CommsUni.tv"
              contentFit="cover"
              cachePolicy="memory-disk"
              style={{ width: '100%', height: '100%' }}
            />
          </View>
          <Ionicons name="information-circle-outline" size={spacing.lg} color={tokens.textMuted} />
        </Pressable>
      </View>
      {open ? (
        <View
          style={{
            marginTop: spacing.sm,
            padding: spacing.md,
            backgroundColor: tokens.surfaceAlt,
            borderRadius: radius.md,
          }}
        >
          <View
            testID="community-project-icons"
            style={{
              flexDirection: 'row',
              justifyContent: 'center',
              alignItems: 'center',
              marginBottom: spacing.sm,
            }}
          >
            {icons(true)}
          </View>
          <T variant="caption">{t('comments:commsuni.aboutBody')}</T>
          <T variant="caption" style={{ marginTop: spacing.sm, color: tokens.textSecondary }}>
            {t('comments:commsuni.sharedIdentity')}
          </T>
          {link('https://commsuni.tv', t('comments:commsuni.visitCommsUni'))}
          {link('https://tvtime-archive.com', t('comments:commsuni.visitArchive'))}
          {error ? <T variant="caption">{t('common:pleaseTryAgain')}</T> : null}
        </View>
      ) : null}
    </View>
  );
}
