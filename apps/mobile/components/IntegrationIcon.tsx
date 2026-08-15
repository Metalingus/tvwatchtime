import { Image } from 'expo-image';
import type { IntegrationProvider } from '@tvwatch/shared';
import { useAppearance } from '../context/PreferencesProvider';

export type IntegrationBrand = IntegrationProvider | 'TRAKT';

const ICONS: Record<IntegrationBrand, number> = {
  SIMKL: require('../assets/integration-icons/simkl.svg'),
  STREMIO: require('../assets/integration-icons/stremio.svg'),
  JELLYFIN: require('../assets/integration-icons/jellyfin_logo.svg'),
  PLEX: require('../assets/integration-icons/plex.svg'),
  TRAKT: require('../assets/integration-icons/trakt.svg'),
  EMBY: require('../assets/integration-icons/emby.svg'),
};

export function IntegrationIcon({
  provider,
  size = 30,
  disabled = false,
}: {
  provider: IntegrationBrand;
  size?: number;
  disabled?: boolean;
}) {
  const { tokens } = useAppearance();
  const jellyfinMark = provider === 'JELLYFIN';
  return (
    <Image
      source={ICONS[provider]}
      contentFit={jellyfinMark ? 'cover' : 'contain'}
      contentPosition={jellyfinMark ? 'left' : 'center'}
      accessible={false}
      tintColor={provider === 'SIMKL' ? tokens.textPrimary : undefined}
      style={{
        width: size,
        height: size,
        opacity: disabled ? 0.45 : 1,
      }}
    />
  );
}
