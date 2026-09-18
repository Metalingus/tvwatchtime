import { useEffect, useRef } from 'react';
import LottieView from 'lottie-react-native';
import { router } from 'expo-router';
import { Animated, Platform, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useAppearance } from '../context/PreferencesProvider';
import { radius, spacing } from '../theme/theme';
import { IntegrationIcon, type IntegrationBrand } from './IntegrationIcon';
import { Button, T } from './primitives';

const INTEGRATIONS: { provider: IntegrationBrand; name: string }[] = [
  { provider: 'SIMKL', name: 'SIMKL' },
  { provider: 'STREMIO', name: 'Stremio' },
  { provider: 'JELLYFIN', name: 'Jellyfin' },
  { provider: 'PLEX', name: 'Plex' },
  { provider: 'EMBY', name: 'Emby' },
];

// Illustration size is independent of screen width; explicit dimensions keep
// Android from reserving a full-width square around the compact animation.
const EMPTY_STATE_ANIMATION_SIZE = 120;
const emptyStateSource = require('../assets/empty_state.json');
// The exported text layer references an embedded font that Lottie does not render
// consistently across native and web. Render the localized text natively instead.
const emptyStateAnimation = {
  ...emptyStateSource,
  layers: emptyStateSource.layers.filter((layer: { ty?: number }) => layer.ty !== 5),
};

interface LibraryEmptyStateProps {
  kind: 'movies' | 'shows';
  refreshing?: boolean;
  onRefresh?: () => void;
}

export function LibraryEmptyState({ kind, refreshing = false, onRefresh }: LibraryEmptyStateProps) {
  const { tokens } = useAppearance();
  const { t } = useTranslation(['common', 'import']);
  const animationTextOpacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    // Match the JSON timeline: text fades in around frame 14, remains visible,
    // then fades out around frame 60 of the 89-frame, 29.97fps loop.
    const textLoop = Animated.loop(
      Animated.sequence([
        Animated.delay(467),
        Animated.timing(animationTextOpacity, {
          toValue: 1,
          duration: 200,
          useNativeDriver: true,
        }),
        Animated.delay(1100),
        Animated.timing(animationTextOpacity, {
          toValue: 0,
          duration: 233,
          useNativeDriver: true,
        }),
        Animated.delay(967),
      ]),
    );
    textLoop.start();
    return () => textLoop.stop();
  }, [animationTextOpacity]);

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.scrollContent}
      showsVerticalScrollIndicator={false}
      refreshControl={
        onRefresh ? (
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            colors={[tokens.primary]}
            tintColor={tokens.primary}
          />
        ) : undefined
      }
    >
      <View style={styles.content}>
        <View style={styles.animationWrap}>
          <LottieView
            source={emptyStateAnimation}
            autoPlay
            loop
            resizeMode="contain"
            style={[styles.animation, Platform.OS === 'web' ? styles.animationWeb : undefined]}
          />
          <Animated.View
            pointerEvents="none"
            style={[styles.animationText, { opacity: animationTextOpacity }]}
          >
            <T variant="caption" style={{ color: tokens.primary, textAlign: 'center' }}>
              {t('libraryEmptyAnimationText')}
            </T>
          </Animated.View>
        </View>

        <T variant="h1" style={styles.title}>
          {t(kind === 'movies' ? 'libraryEmptyMovieTitle' : 'libraryEmptyShowTitle')}
        </T>
        <T variant="body" muted style={styles.description}>
          {t('libraryEmptyExplore')}
        </T>
        <Button
          title={t('libraryEmptyExploreCta')}
          icon="compass-outline"
          onPress={() => router.push('/(tabs)/explore')}
          style={styles.button}
        />

        <View
          style={[
            styles.integrationsCard,
            { backgroundColor: tokens.surface, borderColor: tokens.border },
          ]}
        >
          <View style={styles.integrationBrands}>
            {INTEGRATIONS.map(({ provider, name }) => (
              <View key={provider} style={styles.integrationBrand}>
                <View style={[styles.integrationIcon, { backgroundColor: tokens.background }]}>
                  <IntegrationIcon provider={provider} size={spacing.xxl} />
                </View>
                <T variant="micro" style={styles.integrationName}>
                  {name}
                </T>
              </View>
            ))}
          </View>
          <T variant="h2" style={styles.integrationTitle}>
            {t('libraryEmptyIntegrationsTitle')}
          </T>
          <T variant="caption" muted style={styles.description}>
            {t('libraryEmptyIntegrationsDescription')}
          </T>
          <Button
            title={t('libraryEmptyIntegrationsCta')}
            icon="link-outline"
            variant="ghost"
            onPress={() => router.push('/integrations')}
            style={{
              ...styles.button,
              backgroundColor: tokens.primarySoft,
              borderColor: tokens.primary,
            }}
          />
        </View>

        <View style={styles.orRow}>
          <View style={[styles.divider, { backgroundColor: tokens.divider }]} />
          <T variant="caption" muted style={styles.orLabel}>
            {t('or')}
          </T>
          <View style={[styles.divider, { backgroundColor: tokens.divider }]} />
        </View>

        <T variant="body" muted style={styles.description}>
          {t('libraryEmptyBuilder')}
        </T>
        <Button
          title={t('libraryEmptyBuilderCta')}
          icon="flash-outline"
          variant="ghost"
          onPress={() => router.push('/onboarding' as any)}
          style={styles.button}
        />

        <View style={styles.orRow}>
          <View style={[styles.divider, { backgroundColor: tokens.divider }]} />
          <T variant="caption" muted style={styles.orLabel}>
            {t('or')}
          </T>
          <View style={[styles.divider, { backgroundColor: tokens.divider }]} />
        </View>

        <T variant="body" muted style={styles.description}>
          {t('libraryEmptyImport')}
        </T>
        <Button
          title={t('import:importFromTvTimeOrTrakt')}
          icon="cloud-upload-outline"
          variant="ghost"
          onPress={() => router.push('/import' as any)}
          style={styles.button}
        />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  scrollContent: {
    flexGrow: 1,
    justifyContent: 'flex-start',
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xxl,
  },
  content: {
    width: '100%',
    maxWidth: 420,
    alignSelf: 'center',
    alignItems: 'center',
  },
  animationWrap: {
    width: EMPTY_STATE_ANIMATION_SIZE,
    height: EMPTY_STATE_ANIMATION_SIZE,
    flexShrink: 0,
    overflow: 'hidden',
  },
  animation: {
    width: EMPTY_STATE_ANIMATION_SIZE,
    height: EMPTY_STATE_ANIMATION_SIZE,
  },
  // lottie-react-native's web renderer compresses this precomposition to about half
  // its authored width. Correct only that renderer; native already preserves the asset.
  animationWeb: { transform: [{ scaleX: 2 }] },
  animationText: {
    position: 'absolute',
    top: spacing.lg,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  title: { textAlign: 'center', marginTop: spacing.sm },
  description: { textAlign: 'center', marginTop: spacing.sm },
  button: { width: '100%', marginTop: spacing.lg },
  integrationsCard: {
    width: '100%',
    marginTop: spacing.lg,
    padding: spacing.lg,
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
  },
  integrationBrands: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  integrationBrand: { flex: 1, alignItems: 'center', minWidth: 0 },
  integrationIcon: {
    width: spacing.xl * 2,
    height: spacing.xl * 2,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  integrationName: { width: '100%', textAlign: 'center', marginTop: spacing.sm },
  integrationTitle: { textAlign: 'center', marginTop: spacing.md },
  orRow: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing.xl,
  },
  divider: { flex: 1, height: StyleSheet.hairlineWidth },
  orLabel: { marginHorizontal: spacing.md },
});
