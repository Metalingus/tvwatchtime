import React, {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AccessibilityInfo,
  Animated,
  AppState,
  Easing,
  type AppStateStatus,
  Pressable,
  StyleSheet,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import type { GalleryImageDto } from '@tvwatch/shared';
import { useSetGalleryCover } from '../api/hooks';
import { useAppearance } from '../context/PreferencesProvider';
import { showConfirm, showError } from '../lib/dialog';
import { showToast } from '../lib/toast';
import { galleryIndexForHero, landscapeGallery, nextHeroIndex } from '../lib/artwork-gallery';
import { radius, spacing } from '../theme/theme';
import { T } from './primitives';
import { MediaViewer } from './comments/MediaViewer';
import { ArtworkGalleryGrid } from './ArtworkGalleryGrid';

const ROTATION_MS = 6000;
const CROSSFADE_MS = 700;
const AnimatedExpoImage = Animated.createAnimatedComponent(Image);
type ImageSlot = 'a' | 'b';
type ImageTransition = { from: ImageSlot; to: ImageSlot; targetUri: string };

export function ArtworkHero({
  gallery,
  fallbackUri,
  ownerType,
  style,
  imageOpacity = 1,
  children,
}: {
  gallery?: GalleryImageDto[];
  fallbackUri?: string | null;
  ownerType: 'MEDIA' | 'EPISODE';
  style: StyleProp<ViewStyle>;
  imageOpacity?: number;
  children: ReactNode;
}) {
  const { tokens } = useAppearance();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation(['common']);
  const setCover = useSetGalleryCover();
  const [heroIndex, setHeroIndex] = useState(0);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [galleryGridOpen, setGalleryGridOpen] = useState(false);
  const [galleryIndex, setGalleryIndex] = useState(0);
  const [focused, setFocused] = useState(true);
  const [appState, setAppState] = useState<AppStateStatus>(AppState.currentState);
  const [reduceMotion, setReduceMotion] = useState(false);

  const images = gallery ?? [];
  const heroImages = useMemo(() => landscapeGallery(images), [images]);
  const currentHero = heroImages[heroIndex % Math.max(1, heroImages.length)];
  // Hydration updates the gallery and controls immediately, but index zero keeps the
  // exact pre-hydration bitmap. A different image appears only on the six-second tick.
  const targetUri =
    heroIndex === 0 && fallbackUri
      ? fallbackUri
      : (currentHero?.previewUrl ?? currentHero?.url ?? fallbackUri ?? undefined);
  const [slotAUri, setSlotAUri] = useState<string | undefined>(targetUri);
  const [slotBUri, setSlotBUri] = useState<string | undefined>();
  const [activeSlot, setActiveSlot] = useState<ImageSlot>('a');
  const [imageTransition, setImageTransition] = useState<ImageTransition | null>(null);
  const opacityA = useRef(new Animated.Value(targetUri ? imageOpacity : 0)).current;
  const opacityB = useRef(new Animated.Value(0)).current;
  const slotASource = useMemo(() => (slotAUri ? { uri: slotAUri } : undefined), [slotAUri]);
  const slotBSource = useMemo(() => (slotBUri ? { uri: slotBUri } : undefined), [slotBUri]);
  const activeUri = activeSlot === 'a' ? slotAUri : slotBUri;

  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );

  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion);
    const motion = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    const state = AppState.addEventListener('change', setAppState);
    return () => {
      motion.remove();
      state.remove();
    };
  }, []);

  useEffect(() => {
    if (reduceMotion || galleryOpen || !focused || appState !== 'active' || heroImages.length < 2) {
      return;
    }
    const timer = setInterval(
      () => setHeroIndex((current) => nextHeroIndex(current, heroImages.length)),
      ROTATION_MS,
    );
    return () => clearInterval(timer);
  }, [appState, focused, galleryOpen, heroImages.length, reduceMotion]);

  useEffect(() => {
    if (heroIndex >= heroImages.length) setHeroIndex(0);
  }, [heroImages.length, heroIndex]);

  // Load the next URI into the hidden slot. The active slot and its opacity are never
  // mutated here, so there is no frame where the outgoing image can disappear early.
  useEffect(() => {
    if (!targetUri || targetUri === activeUri || imageTransition) return;
    let cancelled = false;
    void Image.prefetch(targetUri).then((loaded) => {
      if (cancelled || !loaded) return;
      if (reduceMotion || !activeUri) {
        if (activeSlot === 'a') {
          setSlotAUri(targetUri);
          setSlotBUri(undefined);
          opacityA.setValue(imageOpacity);
          opacityB.setValue(0);
        } else {
          setSlotBUri(targetUri);
          setSlotAUri(undefined);
          opacityB.setValue(imageOpacity);
          opacityA.setValue(0);
        }
        return;
      }
      const incomingSlot: ImageSlot = activeSlot === 'a' ? 'b' : 'a';
      if (incomingSlot === 'a') {
        opacityA.setValue(0);
        setSlotAUri(targetUri);
      } else {
        opacityB.setValue(0);
        setSlotBUri(targetUri);
      }
      setImageTransition({ from: activeSlot, to: incomingSlot, targetUri });
    });
    return () => {
      cancelled = true;
    };
  }, [
    activeSlot,
    activeUri,
    imageOpacity,
    imageTransition,
    opacityA,
    opacityB,
    reduceMotion,
    targetUri,
  ]);

  useLayoutEffect(() => {
    if (!imageTransition) return;
    const outgoingOpacity = imageTransition.from === 'a' ? opacityA : opacityB;
    const incomingOpacity = imageTransition.to === 'a' ? opacityA : opacityB;
    if (reduceMotion) {
      outgoingOpacity.setValue(0);
      incomingOpacity.setValue(imageOpacity);
      setActiveSlot(imageTransition.to);
      if (imageTransition.from === 'a') setSlotAUri(undefined);
      else setSlotBUri(undefined);
      setImageTransition(null);
      return;
    }
    const animation = Animated.parallel([
      Animated.timing(outgoingOpacity, {
        toValue: 0,
        duration: CROSSFADE_MS,
        easing: Easing.inOut(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(incomingOpacity, {
        toValue: imageOpacity,
        duration: CROSSFADE_MS,
        easing: Easing.inOut(Easing.cubic),
        useNativeDriver: true,
      }),
    ]);
    animation.start(({ finished }) => {
      if (!finished) return;
      setActiveSlot(imageTransition.to);
      if (imageTransition.from === 'a') setSlotAUri(undefined);
      else setSlotBUri(undefined);
      setImageTransition(null);
    });
    return () => animation.stop();
  }, [imageOpacity, imageTransition, opacityA, opacityB, reduceMotion]);

  useEffect(
    () => () => {
      opacityA.stopAnimation();
      opacityB.stopAnimation();
    },
    [opacityA, opacityB],
  );

  const openGallery = () => {
    if (!images.length) return;
    setGalleryIndex(galleryIndexForHero(images, currentHero));
    setGalleryOpen(true);
  };

  const openGalleryGrid = () => {
    if (!images.length) return;
    setGalleryOpen(false);
    setGalleryGridOpen(true);
  };

  const selectFromGrid = (index: number) => {
    setGalleryIndex(index);
    setGalleryGridOpen(false);
    setGalleryOpen(true);
  };

  const useAsCover = (index: number) => {
    const image = images[index];
    if (!image || setCover.isPending) return;
    showConfirm({
      title: t('common:gallery.useAsCoverTitle'),
      description: t('common:gallery.useAsCoverDescription'),
      confirmLabel: t('common:yes'),
      cancelLabel: t('common:no'),
      onConfirm: () => {
        setCover.mutate(
          { ownerType, imageId: image.id },
          {
            onSuccess: () => {
              showToast(t('common:gallery.coverUpdated'));
            },
            onError: () => showError({ description: t('common:gallery.coverFailed') }),
          },
        );
      },
    });
  };

  return (
    <>
      <Pressable
        style={style}
        onPress={openGallery}
        disabled={!images.length}
        accessibilityRole={images.length ? 'button' : undefined}
        accessibilityLabel={
          images.length ? t('common:gallery.open', { count: images.length }) : undefined
        }
      >
        {slotASource ? (
          <AnimatedExpoImage
            source={slotASource}
            style={[StyleSheet.absoluteFill, { opacity: opacityA }]}
            contentFit="cover"
            cachePolicy="memory-disk"
            transition={0}
          />
        ) : null}
        {slotBSource ? (
          <AnimatedExpoImage
            source={slotBSource}
            style={[StyleSheet.absoluteFill, { opacity: opacityB }]}
            contentFit="cover"
            cachePolicy="memory-disk"
            transition={0}
          />
        ) : null}
        {children}
        {images.length ? (
          <Pressable
            style={[
              styles.countBadge,
              {
                top: insets.top + 52,
                backgroundColor: tokens.mediaScrim,
              },
            ]}
            onPress={(event) => {
              event.stopPropagation();
              openGalleryGrid();
            }}
            accessibilityRole="button"
            accessibilityLabel={t('common:gallery.open', { count: images.length })}
          >
            <Ionicons name="images-outline" size={15} color={tokens.mediaText} />
            <T variant="caption" style={{ color: tokens.mediaText }}>
              {images.length}
            </T>
          </Pressable>
        ) : null}
      </Pressable>
      <MediaViewer
        visible={galleryOpen}
        sources={images.map((image, index) => ({
          id: image.id,
          source: image.url,
          accessibilityLabel: t('common:gallery.imageLabel', {
            current: index + 1,
            total: images.length,
          }),
        }))}
        initialIndex={galleryIndex}
        onClose={() => setGalleryOpen(false)}
        closeLabel={t('common:close')}
        previousLabel={t('common:gallery.previousImage')}
        nextLabel={t('common:gallery.nextImage')}
        galleryLabel={t('common:gallery.galleryMode')}
        onOpenGallery={openGalleryGrid}
        counterLabel={(current, total) => t('common:gallery.counter', { current, total })}
        actionLabel={t('common:gallery.setCover')}
        actionPending={setCover.isPending}
        onAction={useAsCover}
      />
      <ArtworkGalleryGrid
        visible={galleryGridOpen}
        images={images}
        title={t('common:gallery.imagesCount', { count: images.length })}
        closeLabel={t('common:close')}
        imageLabel={(current, total) => t('common:gallery.imageLabel', { current, total })}
        onClose={() => setGalleryGridOpen(false)}
        onSelect={selectFromGrid}
      />
    </>
  );
}

const styles = StyleSheet.create({
  countBadge: {
    position: 'absolute',
    right: spacing.lg,
    zIndex: 5,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
});
