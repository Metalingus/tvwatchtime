import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import {
  MEDIA_TAG_SLUGS,
  MediaType,
  type ExploreDefaultFilters,
  type MediaTagSlug,
} from '@tvwatch/shared';
import { Header } from '../../components/Header';
import { ActivityFeed } from '../../components/ActivityFeed';
import { cardYear, Carousel, PosterCard } from '../../components/cards';
import { Chip, Screen, Spinner, T } from '../../components/primitives';
import {
  FilterPicker,
  FilterReset,
  FilterToggle,
  type FilterPickerOption,
} from '../../components/FilterPicker';
import {
  ExploreFilters,
  useDiscoverSections,
  useForYou,
  useGenres,
  useSearch,
  useUpdateProfile,
} from '../../api/hooks';
import { useAuth } from '../../context/AuthContext';
import { useTabPressReset } from '../../hooks/useTabPressReset';
import { useContentWidth } from '../../hooks/useContentWidth';
import { useAppearance } from '../../context/PreferencesProvider';
import { radius, spacing, typography } from '../../theme/theme';
import { useTranslation } from 'react-i18next';
import { showToast } from '../../lib/toast';

/** Curated ISO 3166-1 country filter list (display names are localized via i18n). */
const COUNTRY_CODES = [
  'US',
  'GB',
  'FR',
  'DE',
  'ES',
  'IT',
  'JP',
  'KR',
  'CN',
  'IN',
  'TR',
  'BR',
  'MX',
  'CA',
  'AU',
];

type ExploreType = 'both' | 'movies' | 'shows';
type ExploreOrder = 'popularity' | 'releaseDate';

function ExploreFilterBar({
  genreLabel,
  genre,
  genreOptions,
  onGenreChange,
  tagLabel,
  tags,
  tagOptions,
  onTagsChange,
  orderLabel,
  order,
  onOrderChange,
  typeIcons,
  mediaType,
  onMediaTypeChange,
  excludedLabel,
  excludeGenres,
  onExcludeChange,
  countryLabel,
  country,
  countryOptions,
  onCountryChange,
  hideAnime,
  onHideAnimeChange,
  onReset,
  onSave,
  hasSavedDefault,
}: {
  genreLabel: string;
  genre: string | null;
  genreOptions: FilterPickerOption[];
  onGenreChange: (value: string | null) => void;
  tagLabel: string;
  tags: MediaTagSlug[];
  tagOptions: FilterPickerOption[];
  onTagsChange: (values: MediaTagSlug[]) => void;
  orderLabel: string;
  order: ExploreOrder;
  onOrderChange: (value: ExploreOrder) => void;
  typeIcons: React.ComponentProps<typeof Ionicons>['name'][];
  mediaType: ExploreType;
  onMediaTypeChange: (value: ExploreType) => void;
  excludedLabel: string;
  excludeGenres: string[];
  onExcludeChange: (values: string[]) => void;
  countryLabel: string;
  country: string | null;
  countryOptions: FilterPickerOption[];
  onCountryChange: (value: string | null) => void;
  hideAnime: boolean;
  onHideAnimeChange: (value: boolean) => void;
  onReset: () => void;
  onSave: () => void;
  hasSavedDefault: boolean;
}) {
  const { t } = useTranslation(['explore', 'common']);
  const [open, setOpen] = useState(false);

  return (
    <View style={styles.filterStack}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.inlineFilterScroll}
        contentContainerStyle={styles.inlineFilters}
      >
        <FilterPicker
          label={t('explore:filters.genre')}
          valueLabel={genreLabel}
          showLabelPrefix={false}
          active={!!genre}
          dialogTitle={t('explore:filters.genre')}
          options={[{ value: '', label: t('common:all') }, ...genreOptions]}
          selected={[genre ?? '']}
          onChange={(values) => onGenreChange(values[0] || null)}
          onClear={() => onGenreChange(null)}
        />
        <FilterPicker
          label={t('explore:filters.tags')}
          valueLabel={tagLabel}
          showLabelPrefix={false}
          active={tags.length > 0}
          dialogTitle={t('explore:filters.tags')}
          options={tagOptions}
          selected={tags}
          multi
          onChange={(values) => onTagsChange(values as MediaTagSlug[])}
          onClear={() => onTagsChange([])}
        />
        <FilterPicker
          label={t('explore:filters.order')}
          valueLabel={orderLabel}
          showLabelPrefix={false}
          active={order !== 'popularity'}
          dialogTitle={t('explore:filters.order')}
          options={[
            { value: 'popularity', label: t('explore:filters.orderPopularity') },
            { value: 'releaseDate', label: t('explore:filters.orderReleaseDate') },
          ]}
          selected={[order]}
          onChange={(values) => onOrderChange((values[0] as ExploreOrder) ?? 'popularity')}
        />
        <FilterPicker
          label={t('explore:filters.type')}
          valueLabel=""
          showLabelPrefix={false}
          icons={typeIcons}
          active={mediaType !== 'both'}
          dialogTitle={t('explore:filters.type')}
          options={[
            { value: 'both', label: t('explore:filters.typeBoth') },
            { value: 'movies', label: t('explore:filters.typeMovies') },
            { value: 'shows', label: t('explore:filters.typeShows') },
          ]}
          selected={[mediaType]}
          onChange={(values) => onMediaTypeChange((values[0] as ExploreType) ?? 'both')}
        />
        <FilterPicker
          label={t('explore:filters.exclude')}
          valueLabel={excludedLabel}
          showLabelPrefix={false}
          active={excludeGenres.length > 0}
          dialogTitle={t('explore:filters.exclude')}
          options={genreOptions}
          selected={excludeGenres}
          multi
          onChange={onExcludeChange}
          onClear={() => onExcludeChange([])}
        />
        <FilterPicker
          label={t('explore:filters.country')}
          valueLabel={countryLabel}
          showLabelPrefix={false}
          active={!!country}
          dialogTitle={t('explore:filters.country')}
          options={countryOptions}
          selected={[country ?? '']}
          onChange={(values) => onCountryChange(values[0] || null)}
          onClear={() => onCountryChange(null)}
        />
        <FilterReset
          label={t('explore:filters.advanced')}
          onPress={() => setOpen((value) => !value)}
          icon={open ? 'chevron-up-outline' : 'options-outline'}
        />
      </ScrollView>
      {open ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.inlineFilterScroll}
          contentContainerStyle={styles.inlineFilters}
        >
          <FilterToggle
            label={t('explore:filters.hideAnime')}
            value={hideAnime}
            onChange={onHideAnimeChange}
          />
          <FilterReset label={t('explore:filters.resetAll')} onPress={onReset} />
          <FilterReset
            label={t('explore:filters.saveDefault')}
            onPress={onSave}
            icon="bookmark-outline"
            iconActive={hasSavedDefault}
          />
        </ScrollView>
      ) : null}
    </View>
  );
}

export default function ExploreScreen() {
  const { tokens } = useAppearance();
  const width = useContentWidth();
  const { t, i18n } = useTranslation(['explore', 'common']);
  const { user, refreshUser } = useAuth();
  const updateProfile = useUpdateProfile();
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [category, setCategory] = useState<'feed' | 'discover'>('discover');
  const discoverRef = useRef<ScrollView>(null);

  // Debounce so we don't hit the API on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 400);
    return () => clearTimeout(t);
  }, [q]);

  const searching = debouncedQ.length > 1;
  // Filters apply to both modes: search results AND the discover carousels.
  const [genre, setGenre] = useState<string | null>(null);
  const [excludeGenres, setExcludeGenres] = useState<string[]>([]);
  const [tags, setTags] = useState<MediaTagSlug[]>([]);
  const [order, setOrder] = useState<ExploreOrder>('popularity');
  const [mediaType, setMediaType] = useState<ExploreType>('both');
  const [country, setCountry] = useState<string | null>(null);
  const [hideAnime, setHideAnime] = useState(false);
  const [defaultsHydrated, setDefaultsHydrated] = useState(false);
  const applyDefaults = useCallback((value?: ExploreDefaultFilters | null) => {
    setGenre(value?.genre ?? null);
    setExcludeGenres(value?.excludeGenres ?? []);
    setTags(value?.tags ?? []);
    setOrder(value?.order ?? 'popularity');
    setMediaType(value?.mediaType ?? 'both');
    setCountry(value?.country ?? null);
    setHideAnime(value?.hideAnime ?? false);
  }, []);
  useEffect(() => {
    applyDefaults(user?.exploreDefaultFilters);
    setDefaultsHydrated(true);
  }, [applyDefaults, user?.exploreDefaultFilters, user?.id]);
  const resetFilters = useCallback(() => {
    setGenre(null);
    setExcludeGenres([]);
    setTags([]);
    setOrder('popularity');
    setMediaType('both');
    setCountry(null);
    setHideAnime(false);
  }, []);
  const filters = useMemo<ExploreFilters>(
    () => ({ excludeGenres, tags, sort: order, country, hideAnime }),
    [excludeGenres, tags, order, country, hideAnime],
  );
  const genres = useGenres();
  const searchType =
    mediaType === 'movies' ? MediaType.MOVIE : mediaType === 'shows' ? MediaType.SHOW : undefined;
  const search = useSearch(debouncedQ, searchType, genre, filters);
  const sections = useDiscoverSections(user?.id, genre, filters, defaultsHydrated);
  const topShowsForYou = useForYou(
    MediaType.SHOW,
    user?.id,
    genre,
    filters,
    defaultsHydrated && mediaType !== 'movies',
  );
  const topMoviesForYou = useForYou(
    MediaType.MOVIE,
    user?.id,
    genre,
    filters,
    defaultsHydrated && mediaType !== 'shows',
  );
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([
      sections.refetch(),
      ...(mediaType !== 'movies' ? [topShowsForYou.refetch()] : []),
      ...(mediaType !== 'shows' ? [topMoviesForYou.refetch()] : []),
    ]);
    setRefreshing(false);
  }, [mediaType, sections, topMoviesForYou, topShowsForYou]);

  // Adaptive grid: column count scales with the available width (same approach
  // as My Shows). Renders pre-grouped rows per the project grid pattern.
  const containerW = Math.max(0, width - spacing.lg * 2);
  const gridGap = spacing.sm;
  const cols = Math.max(3, Math.floor((containerW + gridGap) / (96 + gridGap)));
  const cellW = Math.floor((containerW - gridGap * (cols - 1)) / cols);

  const searchItems = useMemo(
    () => (search.data?.pages ?? []).flatMap((p) => p.items ?? []),
    [search.data],
  );
  const searchRows: (typeof searchItems)[] = [];
  for (let i = 0; i < searchItems.length; i += cols)
    searchRows.push(searchItems.slice(i, i + cols));

  useTabPressReset(() => {
    setQ('');
    setDebouncedQ('');
    applyDefaults(user?.exploreDefaultFilters);
    discoverRef.current?.scrollTo({ y: 0, animated: true });
  });

  const saveDefaults = useCallback(async () => {
    const value: ExploreDefaultFilters = {
      genre,
      excludeGenres,
      tags,
      order,
      mediaType,
      country,
      hideAnime,
    };
    const empty =
      !genre &&
      !excludeGenres.length &&
      !tags.length &&
      order === 'popularity' &&
      mediaType === 'both' &&
      !country &&
      !hideAnime;
    try {
      await updateProfile.mutateAsync({ exploreDefaultFilters: empty ? null : value });
      await refreshUser();
      showToast(t(empty ? 'explore:filters.defaultCleared' : 'explore:filters.defaultSaved'));
    } catch {
      showToast(t('explore:filters.defaultSaveFailed'));
    }
  }, [
    country,
    excludeGenres,
    genre,
    hideAnime,
    mediaType,
    order,
    refreshUser,
    t,
    tags,
    updateProfile,
  ]);

  // Localized country names: Intl.DisplayNames when the runtime supports it
  // (Hermes doesn't), else the i18n name map shipped in every locale.
  const countryNames = useMemo(() => {
    let dn: { of: (code: string) => string | undefined } | null = null;
    try {
      const DisplayNames = (Intl as any)?.DisplayNames;
      if (DisplayNames) dn = new DisplayNames([i18n.language], { type: 'region' });
    } catch {
      dn = null;
    }
    const map: Record<string, string> = {};
    for (const code of COUNTRY_CODES) {
      map[code] = dn?.of(code) ?? t(`explore:filters.countries.${code}`);
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i18n.language]);

  const genreOptions = useMemo(
    () => (genres.data ?? []).map((g) => ({ value: g.slug, label: g.name })),
    [genres.data],
  );
  const genreName = (slug: string) =>
    (genres.data ?? []).find((item) => item.slug === slug)?.name ?? slug;
  const genreLabel = genre ? genreName(genre) : t('explore:filters.genre');
  const tagOptions = useMemo<FilterPickerOption[]>(
    () =>
      MEDIA_TAG_SLUGS.map((slug) => ({
        value: slug,
        label: t(`explore:filters.tagNames.${slug}`),
      })),
    [t],
  );
  const tagName = (slug: MediaTagSlug) =>
    tagOptions.find((item) => item.value === slug)?.label ?? slug;
  const tagLabel = tags.length
    ? tags.length === 1
      ? tagName(tags[0])
      : `${tagName(tags[0])} +${tags.length - 1}`
    : t('explore:filters.tags');
  const excludedLabel = excludeGenres.length
    ? excludeGenres.length === 1
      ? genreName(excludeGenres[0])
      : `${genreName(excludeGenres[0])} +${excludeGenres.length - 1}`
    : t('explore:filters.exclude');
  const orderLabel =
    order === 'releaseDate' ? t('explore:filters.orderReleaseDate') : t('explore:filters.order');
  const countryLabel = country ? (countryNames[country] ?? country) : t('explore:filters.country');
  const typeIcons: React.ComponentProps<typeof Ionicons>['name'][] =
    mediaType === 'movies'
      ? ['film-outline']
      : mediaType === 'shows'
        ? ['tv-outline']
        : ['film-outline', 'tv-outline'];
  const countryOptions: FilterPickerOption[] = [
    { value: '', label: t('common:all') },
    ...COUNTRY_CODES.map((code) => ({
      value: code,
      label: countryNames[code] ?? code,
    })),
  ];

  // Active filters ride along into see-all screens so they survive navigation.
  const moreHref = (key: string) => {
    let url = `/more?t=${key}`;
    if (genre) url += `&g=${encodeURIComponent(genre)}`;
    if (excludeGenres.length) url += `&x=${encodeURIComponent(excludeGenres.join(','))}`;
    if (tags.length) url += `&k=${encodeURIComponent(tags.join(','))}`;
    if (order !== 'popularity') url += `&s=${order}`;
    if (country) url += `&c=${encodeURIComponent(country)}`;
    if (hideAnime) url += '&a=1';
    return url as any;
  };

  return (
    <Screen>
      <Header title={t('explore:title')} />
      <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.sm }}>
        <View style={[styles.search, { backgroundColor: tokens.surface }]}>
          <Ionicons
            name="search"
            size={18}
            color={tokens.textMuted}
            style={{ marginHorizontal: spacing.sm }}
          />
          <TextInput
            value={q}
            onChangeText={setQ}
            placeholder={t('explore:searchPlaceholder')}
            placeholderTextColor={tokens.placeholder}
            style={[styles.input, { color: tokens.textPrimary }]}
          />
          {q.length > 0 ? (
            <Pressable
              onPress={() => {
                setQ('');
                setDebouncedQ('');
              }}
              hitSlop={10}
              style={{ paddingHorizontal: spacing.sm }}
            >
              <Ionicons name="close-circle" size={20} color={tokens.textMuted} />
            </Pressable>
          ) : null}
        </View>
        <View style={{ flexDirection: 'row', marginTop: spacing.sm }}>
          <Chip
            label={t('explore:discover')}
            active={category === 'discover'}
            onPress={() => setCategory('discover')}
          />
          <Chip
            label={t('explore:feed')}
            active={category === 'feed'}
            onPress={() => setCategory('feed')}
          />
          <Chip label={t('explore:groups')} onPress={() => router.push('/groups' as any)} />
        </View>
        {/* Discovery filters don't apply to the activity feed — hide them there. */}
        {category === 'discover' ? (
          <ExploreFilterBar
            genreLabel={genreLabel}
            genre={genre}
            genreOptions={genreOptions}
            onGenreChange={setGenre}
            tagLabel={tagLabel}
            tags={tags}
            tagOptions={tagOptions}
            onTagsChange={setTags}
            orderLabel={orderLabel}
            order={order}
            onOrderChange={setOrder}
            typeIcons={typeIcons}
            mediaType={mediaType}
            onMediaTypeChange={setMediaType}
            excludedLabel={excludedLabel}
            excludeGenres={excludeGenres}
            onExcludeChange={setExcludeGenres}
            countryLabel={countryLabel}
            country={country}
            countryOptions={countryOptions}
            onCountryChange={setCountry}
            hideAnime={hideAnime}
            onHideAnimeChange={setHideAnime}
            onReset={resetFilters}
            onSave={saveDefaults}
            hasSavedDefault={!!user?.exploreDefaultFilters}
          />
        ) : null}
      </View>

      {/* Adaptive grid (chunked rows) when searching. */}
      {searching ? (
        search.isLoading ? (
          <Spinner />
        ) : (
          <FlatList
            data={searchRows}
            key={`grid-${cols}`}
            contentContainerStyle={{ padding: spacing.lg }}
            keyExtractor={(row, i) => row[0]?.id ?? `row-${i}`}
            ListEmptyComponent={
              <T variant="body" muted>
                {t('explore:noResults', { query: debouncedQ })}
              </T>
            }
            onEndReached={() => {
              if (search.hasNextPage && !search.isFetchingNextPage) search.fetchNextPage();
            }}
            onEndReachedThreshold={0.6}
            ListFooterComponent={search.isFetchingNextPage ? <Spinner /> : null}
            renderItem={({ item: row }) => {
              const fill = cols - row.length;
              return (
                <View style={{ flexDirection: 'row' }}>
                  {row.map((item) => (
                    <View
                      key={item.id}
                      style={{ width: cellW, marginRight: gridGap, marginBottom: gridGap }}
                    >
                      <PosterCard
                        id={item.id}
                        kind={item.type === 'SHOW' ? 'shows' : 'movies'}
                        title={item.title}
                        poster={item.images?.poster ?? item.images?.backdrop}
                        rating={item.rating}
                        year={cardYear(item)}
                        width={cellW}
                        style={{ marginRight: 0 }}
                        typeBadge
                      />
                    </View>
                  ))}
                  {fill > 0
                    ? Array.from({ length: fill }).map((_, i) => (
                        <View key={'pad_' + i} style={{ width: cellW, marginRight: gridGap }} />
                      ))
                    : null}
                </View>
              );
            }}
          />
        )
      ) : category === 'feed' ? (
        <ActivityFeed />
      ) : (
        <ScrollView
          ref={discoverRef}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              colors={[tokens.primary]}
              tintColor={tokens.primary}
            />
          }
        >
          <>
            {/* Personalized rails load independently so a cold affinity rebuild
                never blocks the catalog rails below. */}
            {mediaType !== 'movies' &&
              (topShowsForYou.isLoading ? (
                <Spinner />
              ) : (
                <Carousel
                  title={t('explore:topShowsForYou')}
                  data={topShowsForYou.data ?? []}
                  kind="shows"
                  action={t('explore:seeAll')}
                  onAction={() => router.push(moreHref('top-for-you'))}
                />
              ))}
            {mediaType !== 'shows' &&
              (topMoviesForYou.isLoading ? (
                <Spinner />
              ) : (
                <Carousel
                  title={t('explore:topMoviesForYou')}
                  data={topMoviesForYou.data ?? []}
                  kind="movies"
                  action={t('explore:seeAll')}
                  onAction={() => router.push(moreHref('top-movies-for-you'))}
                />
              ))}
            {mediaType !== 'movies' && sections.data ? (
              <Carousel
                title={t('explore:trendingShows')}
                data={sections.data?.trendingShows ?? []}
                kind="shows"
                action={t('explore:seeAll')}
                onAction={() => router.push(moreHref('trending-shows'))}
              />
            ) : null}
            {mediaType !== 'shows' && sections.data ? (
              <>
                <Carousel
                  title={t('explore:trendingMovies')}
                  data={sections.data?.trendingMovies ?? []}
                  kind="movies"
                  action={t('explore:seeAll')}
                  onAction={() => router.push(moreHref('trending-movies'))}
                />
                <Carousel
                  title={t('explore:nowPlayingMovies')}
                  data={sections.data?.nowPlayingMovies ?? []}
                  kind="movies"
                  action={t('explore:seeAll')}
                  onAction={() => router.push(moreHref('now-playing-movies'))}
                />
              </>
            ) : null}
            {mediaType !== 'movies' && sections.data ? (
              <Carousel
                title={t('explore:topRatedShows')}
                data={sections.data?.topRatedShows ?? []}
                kind="shows"
                action={t('explore:seeAll')}
                onAction={() => router.push(moreHref('top-rated-shows'))}
              />
            ) : null}
            {mediaType !== 'shows' && sections.data ? (
              <Carousel
                title={t('explore:topRatedMovies')}
                data={sections.data?.topRatedMovies ?? []}
                kind="movies"
                action={t('explore:seeAll')}
                onAction={() => router.push(moreHref('top-rated-movies'))}
              />
            ) : null}
            {sections.isLoading ? <Spinner /> : null}
          </>
        </ScrollView>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radius.pill,
    height: 44,
  },
  input: { flex: 1, ...typography.body },
  // The search controls sit inside a padded screen header. Break horizontal
  // scrollers out to the viewport edge, then restore the inset on their content:
  // the first chip stays aligned while later chips can scroll beneath the margin.
  filterStack: {
    marginTop: spacing.sm,
    marginHorizontal: -spacing.lg,
    gap: spacing.sm,
  },
  inlineFilterScroll: { flexGrow: 0, flexShrink: 0 },
  inlineFilters: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
});
