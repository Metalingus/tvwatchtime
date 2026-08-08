import React, { useMemo, useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useShowEpisodes } from '../../api/hooks';
import { Spinner, T } from '../primitives';
import { useAppearance } from '../../context/PreferencesProvider';
import { DraftShow, countThrough, eligibleAiredEpisodes } from '../../lib/onboarding/draft';
import { isEpisodeProgressEligible } from '../../lib/episode-progress';
import { radius, spacing } from '../../theme/theme';

type Step = 'menu' | 'seasons' | 'episodes';

/**
 * Show-progress editor — ONE bottom sheet for everything: the action menu,
 * season pick and episode pick navigate INSIDE the sheet (no modal-on-modal).
 * Specials (season 0) and explicit future episodes are never offered — they can't be
 * marked watched by onboarding. Nothing is written to the server here; the
 * selection only updates the local onboarding draft.
 */
export function ProgressEditorSheet({
  mediaId,
  showTitle,
  visible,
  current,
  onClose,
  onAllAired,
  onThrough,
  onMoveToWatchlist,
  onRemove,
}: {
  mediaId: string;
  showTitle: string;
  visible: boolean;
  current?: DraftShow;
  onClose: () => void;
  onAllAired: () => void;
  onThrough: (
    seasonNumber: number,
    episodeNumber: number,
    label: string,
    episodeTitle: string | undefined,
    count: number,
  ) => void;
  onMoveToWatchlist: () => void;
  onRemove: () => void;
}) {
  const { tokens } = useAppearance();
  const { t } = useTranslation(['onboarding', 'common']);
  const seasonsQ = useShowEpisodes(visible ? mediaId : '');
  const [step, setStep] = useState<Step>('menu');
  const [seasonNumber, setSeasonNumber] = useState<number | null>(null);

  const seasons = useMemo(() => {
    const now = Date.now();
    return (seasonsQ.data ?? [])
      .filter((s: any) => s.number > 0) // season 0 = specials — always excluded
      .map((s: any) => ({
        number: s.number as number,
        episodes: (s.episodes ?? []).filter((episode: any) =>
          isEpisodeProgressEligible(episode.airDate, now),
        ),
      }))
      .filter((s: any) => s.episodes.length > 0)
      .sort((a: any, b: any) => a.number - b.number);
  }, [seasonsQ.data]);

  const allEligible = useMemo(
    () => eligibleAiredEpisodes((seasonsQ.data ?? []) as any),
    [seasonsQ.data],
  );
  const activeSeason = seasons.find((s: any) => s.number === seasonNumber) ?? null;

  const close = () => {
    setStep('menu');
    setSeasonNumber(null);
    onClose();
  };

  const throughLabel = (s: number, e: number) =>
    t('onboarding:throughLabel', { season: s, episode: e });

  const pickEpisode = (episodeNumber: number, episodeTitle?: string | null) => {
    if (seasonNumber == null) return;
    onThrough(
      seasonNumber,
      episodeNumber,
      throughLabel(seasonNumber, episodeNumber),
      episodeTitle ?? undefined,
      countThrough(allEligible, seasonNumber, episodeNumber),
    );
    close();
  };

  const menuRows: {
    key: string;
    icon: keyof typeof Ionicons.glyphMap;
    label: string;
    selected?: boolean;
    danger?: boolean;
    onPress: () => void;
  }[] = [
    {
      key: 'all',
      icon: 'checkmark-done',
      label: t('onboarding:sheetAllAired'),
      selected: current?.action === 'CAUGHT_UP',
      onPress: () => {
        onAllAired();
        close();
      },
    },
    {
      key: 'through',
      icon: 'play-forward-outline',
      label: t('onboarding:sheetChooseStop'),
      selected: current?.action === 'WATCHED_THROUGH',
      onPress: () => setStep('seasons'),
    },
    {
      key: 'watchlist',
      icon: 'bookmark-outline',
      label: t('onboarding:sheetMoveToWatchlist'),
      onPress: () => {
        onMoveToWatchlist();
        close();
      },
    },
    {
      key: 'remove',
      icon: 'trash-outline',
      label: t('onboarding:sheetRemove'),
      danger: true,
      onPress: () => {
        onRemove();
        close();
      },
    },
  ];

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={close}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.flex}
      >
        <Pressable
          style={[styles.backdrop, { backgroundColor: tokens.overlayStrong }]}
          onPress={close}
        />
        <View style={[styles.sheet, { backgroundColor: tokens.cardBackground }]}>
          <View style={styles.headerRow}>
            {step !== 'menu' ? (
              <Pressable
                onPress={() => (step === 'episodes' ? setStep('seasons') : setStep('menu'))}
                hitSlop={10}
                accessibilityRole="button"
              >
                <Ionicons name="chevron-back" size={22} color={tokens.textPrimary} />
              </Pressable>
            ) : null}
            <T variant="h2" style={{ flex: 1 }} numberOfLines={1}>
              {step === 'menu'
                ? showTitle
                : step === 'seasons'
                  ? t('onboarding:stopTitle')
                  : t('onboarding:seasonNumber', { number: seasonNumber })}
            </T>
            <Pressable
              onPress={close}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel={t('common:cancel')}
            >
              <Ionicons name="close" size={22} color={tokens.textMuted} />
            </Pressable>
          </View>
          {step === 'seasons' ? (
            <T variant="caption" muted style={styles.supporting}>
              {t('onboarding:stopBody')}
            </T>
          ) : null}
          {step === 'episodes' ? (
            <T variant="caption" muted style={styles.supporting}>
              {t('onboarding:inclusiveNote')}
            </T>
          ) : null}

          {step === 'menu' ? (
            <View style={styles.list}>
              {menuRows.map((row) => (
                <Pressable
                  key={row.key}
                  accessibilityRole="button"
                  onPress={row.onPress}
                  style={({ pressed }) => [
                    styles.row,
                    pressed && { backgroundColor: tokens.surfaceElevated },
                  ]}
                >
                  <Ionicons
                    name={row.icon}
                    size={20}
                    color={row.danger ? tokens.danger : tokens.textPrimary}
                  />
                  <T
                    variant="body"
                    style={{ flex: 1, color: row.danger ? tokens.danger : tokens.textPrimary }}
                  >
                    {row.label}
                  </T>
                  {row.selected ? (
                    <Ionicons name="checkmark" size={20} color={tokens.watched} />
                  ) : null}
                </Pressable>
              ))}
            </View>
          ) : seasonsQ.isLoading ? (
            <Spinner />
          ) : seasons.length === 0 ? (
            <T variant="body" muted style={{ padding: spacing.lg }}>
              {t('onboarding:noAiredEpisodes')}
            </T>
          ) : (
            <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
              {step === 'seasons'
                ? seasons.map((s: any) => (
                    <Pressable
                      key={s.number}
                      accessibilityRole="button"
                      onPress={() => {
                        setSeasonNumber(s.number);
                        setStep('episodes');
                      }}
                      style={({ pressed }) => [
                        styles.row,
                        pressed && { backgroundColor: tokens.surfaceElevated },
                      ]}
                    >
                      <T variant="body" style={{ flex: 1 }} numberOfLines={1}>
                        {t('onboarding:seasonNumber', { number: s.number })}
                      </T>
                      <T variant="caption" muted>
                        {t('onboarding:episodeCount', { count: s.episodes.length })}
                      </T>
                      <Ionicons name="chevron-forward" size={18} color={tokens.textMuted} />
                    </Pressable>
                  ))
                : activeSeason?.episodes.map((e: any) => (
                    <Pressable
                      key={e.id ?? `${activeSeason.number}-${e.number}`}
                      accessibilityRole="button"
                      onPress={() => pickEpisode(e.number, e.title)}
                      style={({ pressed }) => [
                        styles.row,
                        pressed && { backgroundColor: tokens.surfaceElevated },
                      ]}
                    >
                      <T variant="body" style={{ flex: 1 }} numberOfLines={1}>
                        {throughLabel(activeSeason.number, e.number)}
                        {e.title ? ` — ${e.title}` : ''}
                      </T>
                      {e.watched ? (
                        <Ionicons name="checkmark" size={18} color={tokens.watched} />
                      ) : null}
                    </Pressable>
                  ))}
            </ScrollView>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  sheet: {
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
    maxHeight: '70%',
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xs,
  },
  supporting: { paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
  list: { paddingHorizontal: spacing.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 48,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
  },
});
