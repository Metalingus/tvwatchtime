import React, { useMemo } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import {
  LIBRARY_SORTS,
  MEDIA_TAG_SLUGS,
  type LibraryFilters,
  type LibrarySort,
  type MediaTagSlug,
} from '@tvwatch/shared';
import { useTranslation } from 'react-i18next';
import { useGenres } from '../api/hooks';
import { FilterPicker, FilterReset, type FilterPickerOption } from './FilterPicker';
import { spacing } from '../theme/theme';
import { FILTER_COUNTRY_CODES } from '../lib/country';

export function LibraryFilterBar({
  value,
  onChange,
}: {
  value: LibraryFilters;
  onChange: (value: LibraryFilters) => void;
}) {
  const { t, i18n } = useTranslation(['explore', 'common']);
  const genres = useGenres();
  const included = value.genres ?? [];
  const excluded = value.excludeGenres ?? [];
  const tags = value.tags ?? [];
  const sort = value.sort ?? 'addedDate';

  const genreOptions = useMemo(
    () => (genres.data ?? []).map((genre) => ({ value: genre.slug, label: genre.name })),
    [genres.data],
  );
  const genreName = (slug: string) =>
    genreOptions.find((option) => option.value === slug)?.label ?? slug;
  const compactLabel = (values: string[], empty: string, name: (value: string) => string) =>
    values.length === 0
      ? empty
      : values.length === 1
        ? name(values[0])
        : `${name(values[0])} +${values.length - 1}`;

  const tagOptions = useMemo<FilterPickerOption[]>(
    () =>
      MEDIA_TAG_SLUGS.map((slug) => ({
        value: slug,
        label: t(`explore:filters.tagNames.${slug}`),
      })),
    [t],
  );
  const tagName = (slug: string) =>
    tagOptions.find((option) => option.value === slug)?.label ?? slug;

  const countryNames = useMemo(() => {
    let displayNames: { of: (code: string) => string | undefined } | null = null;
    try {
      const DisplayNames = (Intl as any)?.DisplayNames;
      if (DisplayNames) displayNames = new DisplayNames([i18n.language], { type: 'region' });
    } catch {
      displayNames = null;
    }
    return Object.fromEntries(
      FILTER_COUNTRY_CODES.map((code) => [
        code,
        displayNames?.of(code) ?? t(`explore:filters.countries.${code}`),
      ]),
    ) as Record<string, string>;
  }, [i18n.language, t]);
  const countryOptions: FilterPickerOption[] = [
    { value: '', label: t('common:all') },
    ...FILTER_COUNTRY_CODES.map((code) => ({ value: code, label: countryNames[code] ?? code })),
  ];
  const orderOptions: FilterPickerOption[] = LIBRARY_SORTS.map((option) => ({
    value: option,
    label:
      option === 'addedDate'
        ? t('explore:filters.orderAddedDate')
        : option === 'releaseDate'
          ? t('explore:filters.orderReleaseDate')
          : option === 'popularity'
            ? t('explore:filters.orderPopularity')
            : option === 'rating'
              ? t('explore:filters.orderRating')
              : t('explore:filters.orderName'),
  }));
  const orderLabel = orderOptions.find((option) => option.value === sort)?.label ?? sort;
  const active =
    included.length > 0 ||
    excluded.length > 0 ||
    tags.length > 0 ||
    !!value.country ||
    sort !== 'addedDate';

  return (
    <View style={styles.root}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.content}
      >
        <FilterPicker
          label={t('explore:filters.genre')}
          valueLabel={compactLabel(included, t('explore:filters.genre'), genreName)}
          showLabelPrefix={false}
          active={included.length > 0}
          dialogTitle={t('explore:filters.genre')}
          options={genreOptions}
          selected={included}
          multi
          onChange={(next) =>
            onChange({
              ...value,
              genres: next,
              excludeGenres: excluded.filter((slug) => !next.includes(slug)),
            })
          }
          onClear={() => onChange({ ...value, genres: [] })}
        />
        <FilterPicker
          label={t('explore:filters.order')}
          valueLabel={orderLabel}
          showLabelPrefix={false}
          active={sort !== 'addedDate'}
          dialogTitle={t('explore:filters.order')}
          options={orderOptions}
          selected={[sort]}
          onChange={(next) => onChange({ ...value, sort: (next[0] as LibrarySort) ?? 'addedDate' })}
        />
        <FilterPicker
          label={t('explore:filters.exclude')}
          valueLabel={compactLabel(excluded, t('explore:filters.exclude'), genreName)}
          showLabelPrefix={false}
          active={excluded.length > 0}
          dialogTitle={t('explore:filters.exclude')}
          options={genreOptions}
          selected={excluded}
          multi
          onChange={(next) =>
            onChange({
              ...value,
              excludeGenres: next,
              genres: included.filter((slug) => !next.includes(slug)),
            })
          }
          onClear={() => onChange({ ...value, excludeGenres: [] })}
        />
        <FilterPicker
          label={t('explore:filters.country')}
          valueLabel={
            value.country
              ? (countryNames[value.country] ?? value.country)
              : t('explore:filters.country')
          }
          showLabelPrefix={false}
          active={!!value.country}
          dialogTitle={t('explore:filters.country')}
          options={countryOptions}
          selected={[value.country ?? '']}
          onChange={(next) => onChange({ ...value, country: next[0] || null })}
          onClear={() => onChange({ ...value, country: null })}
        />
        <FilterPicker
          label={t('explore:filters.tags')}
          valueLabel={compactLabel(tags, t('explore:filters.tags'), tagName)}
          showLabelPrefix={false}
          active={tags.length > 0}
          dialogTitle={t('explore:filters.tags')}
          options={tagOptions}
          selected={tags}
          multi
          onChange={(next) => onChange({ ...value, tags: next as MediaTagSlug[] })}
          onClear={() => onChange({ ...value, tags: [] })}
        />
        {active ? (
          <FilterReset
            label={t('explore:filters.resetAll')}
            onPress={() => onChange({ sort: 'addedDate' })}
          />
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flexGrow: 0, flexShrink: 0 },
  content: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
});
