import React, { useState } from 'react';
import { View } from 'react-native';
import { Image } from 'expo-image';
import Svg, { Circle, Path } from 'react-native-svg';
import { useAppearance } from '../context/PreferencesProvider';
import { radius, spacing } from '../theme/theme';

/** A profile silhouette remains visible for missing, loading, or broken avatar URLs. */
export function ProfileAvatar({
  uri,
  size = spacing.xl * 2,
}: {
  uri?: string | null;
  size?: number;
}) {
  const { tokens } = useAppearance();
  const [failedUri, setFailedUri] = useState<string | null>(null);
  return (
    <View
      testID="profile-avatar"
      style={{
        width: size,
        height: size,
        borderRadius: radius.pill,
        overflow: 'hidden',
        backgroundColor: tokens.surfaceElevated,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      <Svg
        testID="profile-placeholder"
        width={size}
        height={size}
        viewBox="0 0 40 40"
        aria-hidden
        focusable={false}
      >
        <Circle cx="20" cy="14" r="7" fill={tokens.textMuted} />
        <Path d="M7 36c0-9 5-14 13-14s13 5 13 14" fill={tokens.textMuted} />
      </Svg>
      {uri && uri !== failedUri ? (
        <Image
          source={{ uri }}
          recyclingKey={uri}
          contentFit="cover"
          style={{ position: 'absolute', width: size, height: size }}
          onError={() => setFailedUri(uri)}
        />
      ) : null}
    </View>
  );
}
