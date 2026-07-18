import React, { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { MediaType, type MediaCardDto, type MovieDto, type ShowDto } from '@tvwatch/shared';
import { PosterImage, Spinner, T } from '../primitives';
import { useSearch } from '../../api/hooks';
import { useAppearance } from '../../context/PreferencesProvider';
import { radius, spacing } from '../../theme/theme';

export interface AttachedMedia {
  mediaType: 'SHOW' | 'MOVIE';
  mediaId: string;
  title: string;
  posterUrl?: string | null;
  year?: number | null;
}

interface MediaPickerModalProps {
  visible: boolean;
  onClose: () => void;
  onSelect: (media: AttachedMedia) => void;
}

function toAttached(item: MediaCardDto): AttachedMedia {
  if (item.type === MediaType.SHOW) {
    const s = item as ShowDto;
    return { mediaType: 'SHOW', mediaId: s.id, title: s.title, posterUrl: s.images?.poster ?? null, year: s.yearStart ?? null };
  }
  const m = item as MovieDto;
  return { mediaType: 'MOVIE', mediaId: m.id, title: m.title, posterUrl: m.images?.poster ?? null, year: m.releaseYear ?? null };
}

export function MediaPickerModal({ visible, onClose, onSelect }: MediaPickerModalProps) {
  const { tokens } = useAppearance();
  const { t } = useTranslation(['comments', 'common']);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 400);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!visible) {
      setQuery('');
      setDebounced('');
    }
  }, [visible]);

  // Server order is kept as-is: /search ranks by text match + popularity.
  const search = useSearch(debounced, undefined);
  const results = debounced.length > 1 ? search.data?.items ?? [] : [];

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={[styles.backdrop, { backgroundColor: tokens.overlayStrong }]} onPress={onClose}>
        <Pressable style={[styles.sheet, { backgroundColor: tokens.surface }]} onPress={(e) => e.stopPropagation()}>
          <View style={styles.header}>
            <T variant="h2" numberOfLines={1}>
              {t('comments:mediaPickerTitle')}
            </T>
            <Pressable onPress={onClose} hitSlop={8}>
              <Ionicons name="close" size={24} color={tokens.textPrimary} />
            </Pressable>
          </View>

          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={t('comments:mediaSearchPlaceholder')}
            placeholderTextColor={tokens.textMuted}
            style={[styles.input, { color: tokens.textPrimary, borderColor: tokens.divider }]}
            autoFocus
          />

          {search.isFetching && debounced.length > 1 ? (
            <Spinner />
          ) : results.length === 0 ? (
            debounced.length > 1 ? (
              <T variant="micro" muted style={{ padding: spacing.md, textAlign: 'center' }}>
                {t('comments:mediaNoResults')}
              </T>
            ) : null
          ) : (
            <ScrollView style={{ maxHeight: 500 }} keyboardShouldPersistTaps="handled">
              {results.map((item) => {
                const media = toAttached(item);
                return (
                  <Pressable
                    key={`${media.mediaType}-${media.mediaId}`}
                    onPress={() => onSelect(media)}
                    style={[styles.resultRow, { borderBottomColor: tokens.divider }]}
                  >
                    <PosterImage
                      uri={media.posterUrl}
                      style={{ ...styles.poster, backgroundColor: tokens.surfaceElevated }}
                    />
                    <View style={{ flex: 1 }}>
                      <T variant="body" numberOfLines={1}>
                        {media.title}
                      </T>
                      <View style={styles.metaRow}>
                        <Ionicons
                          name={media.mediaType === 'SHOW' ? 'tv-outline' : 'film-outline'}
                          size={12}
                          color={tokens.textMuted}
                        />
                        {media.year ? (
                          <T variant="micro" muted style={{ marginLeft: 4 }}>
                            {media.year}
                          </T>
                        ) : null}
                      </View>
                    </View>
                    <Ionicons name="add-circle-outline" size={22} color={tokens.primary} />
                  </Pressable>
                );
              })}
            </ScrollView>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: spacing.lg, paddingBottom: 32 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.md },
  input: { borderWidth: 1, borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, fontSize: 16 },
  resultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  poster: { width: 38, height: 57, marginRight: spacing.sm, borderRadius: radius.sm },
  metaRow: { flexDirection: 'row', alignItems: 'center', marginTop: 2 },
});
