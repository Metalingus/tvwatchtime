import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Image } from 'expo-image';
import { Pressable, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import type { CommsUniOrigin } from '@tvwatch/shared';
import { T, APP_ICON } from '../primitives';
import { useAppearance } from '../../context/PreferencesProvider';
import { radius, spacing } from '../../theme/theme';

export function CommentSourceBadge({
  origin,
  local = false,
}: {
  origin: CommsUniOrigin;
  local?: boolean;
}) {
  const { tokens } = useAppearance();
  const { t } = useTranslation('common');
  const displayName =
    local || /^TVWatch(?:Time)?$/.test(origin.displayName)
      ? t('common:appName')
      : origin.displayName;
  const [expanded, setExpanded] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const image =
    origin.iconUrl && failed !== origin.iconUrl ? { uri: origin.iconUrl } : local ? APP_ICON : null;
  return (
    <View
      style={{
        position: 'absolute',
        top: -spacing.sm,
        right: -spacing.sm,
        zIndex: 1,
        alignItems: 'flex-start',
      }}
    >
      <Pressable
        testID="comment-source-badge"
        accessibilityRole="button"
        accessibilityLabel={displayName}
        onPress={(event) => {
          event.stopPropagation();
          setExpanded((value) => !value);
        }}
        hitSlop={spacing.xs}
        style={{
          padding: spacing.xs / 2,
          borderRadius: radius.pill,
          backgroundColor: tokens.cardBackground,
        }}
      >
        {image ? (
          <Image
            source={image}
            contentFit="contain"
            onError={() => setFailed(origin.iconUrl)}
            style={{ width: spacing.lg, height: spacing.lg, borderRadius: radius.pill }}
          />
        ) : (
          <Svg width={spacing.lg} height={spacing.lg} viewBox="0 0 24 24">
            <Path d="M3 3h18v14H9l-6 4V3z" fill={tokens.textMuted} />
          </Svg>
        )}
      </Pressable>
      {expanded ? (
        <View
          testID="comment-source-label"
          style={{
            position: 'absolute',
            top: spacing.xl + spacing.xs,
            left: 0,
            minWidth: spacing.xl * 5,
            maxWidth: spacing.xl * 8,
            padding: spacing.xs,
            borderRadius: radius.sm,
            backgroundColor: tokens.surfaceElevated,
          }}
        >
          <T variant="micro" numberOfLines={1} style={{ color: tokens.textPrimary }}>
            {displayName}
          </T>
        </View>
      ) : null}
    </View>
  );
}

export { localCommentOrigin } from '../../api/commsuni-presentation';
