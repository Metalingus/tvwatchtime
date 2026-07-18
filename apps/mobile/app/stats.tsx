import React, { useCallback, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { Header } from '../components/Header';
import { BadgeGrid, BarChart, StatsCard } from '../components/cards';
import { Leaderboard } from '../components/Leaderboard';
import { Chip, Screen, SectionHeader, Spinner, T } from '../components/primitives';
import { useBadges, useStatsMovies, useStatsShows, useStatsSummary } from '../api/hooks';
import { fmtDuration } from './(tabs)/profile';
import { useAppearance } from '../context/PreferencesProvider';
import { spacing } from '../theme/theme';
import { useTranslation } from 'react-i18next';

export default function StatsScreen() {
  const { tokens } = useAppearance();
  const { t } = useTranslation(['stats', 'common']);
  const [tab, setTab] = useState<'shows' | 'movies'>('shows');
  const summary = useStatsSummary();
  const shows = useStatsShows();
  const movies = useStatsMovies();
  const badges = useBadges();
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([summary.refetch(), shows.refetch(), movies.refetch(), badges.refetch()]);
    setRefreshing(false);
  }, [summary, shows, movies, badges]);

  return (
    <Screen>
      <Header title={t('stats:stats')} showBack />
      <View style={[styles.tabs, { paddingHorizontal: spacing.lg }]}>
        <Chip label={t('stats:shows')} active={tab === 'shows'} onPress={() => setTab('shows')} />
        <Chip label={t('stats:movies')} active={tab === 'movies'} onPress={() => setTab('movies')} />
      </View>
      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: 60 }} showsVerticalScrollIndicator={false} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[tokens.primary]} tintColor={tokens.primary} />}>
        {summary.isLoading ? <Spinner /> : (
          <StatsCard title={t('stats:totalTime')} big={t('stats:totalTimeBig', { tv: fmtDuration(summary.data?.tvTime), movies: fmtDuration(summary.data?.movieTime) })} subtitle={t('stats:totalTimeSub', { episodes: summary.data?.episodesWatched ?? 0, movies: summary.data?.moviesWatched ?? 0 })} />
        )}
        {tab === 'shows' ? <ShowsStats data={shows.data} loading={shows.isLoading} /> : <MoviesStats data={movies.data} loading={movies.isLoading} />}

        {/* Leaderboard — type follows the main tab */}
        <View style={{ marginTop: spacing.lg }}>
          <SectionHeader title={t('stats:leaderboard')} />
          <Leaderboard tabs={[]} typeOverride={tab} />
        </View>

        <SectionHeader title={t('stats:badges')} />
        {badges.isLoading ? <Spinner /> : (
          <View>
            <StatsCard big={`${badges.data?.totalUnlocked ?? 0}`} subtitle={t('stats:badgesProgress', { count: badges.data?.totalBadges ?? 0 })} />
            <BadgeGrid badges={badges.data?.badges ?? []} />
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}

function fmtChartMinutes(m: number): string {
  const h = Math.floor(m / 60);
  const min = m % 60;
  if (h && min) return `${h}h ${min}m`;
  if (h) return `${h}h`;
  return `${min}m`;
}

function ShowsStats({ data, loading }: { data: any; loading: boolean }) {
  const { tokens } = useAppearance();
  const { t } = useTranslation(['stats', 'common']);
  if (loading) return <Spinner />;
  if (!data) return null;
  return (
    <View style={{ gap: spacing.md, marginTop: spacing.md }}>
      <StatsCard title={t('stats:timeWatchingEpisodes')} big={fmtDuration(data.tvTime)} subtitle={t('stats:last7Days')}>
        <BarChart data={data.tvTimeChart} formatValue={fmtChartMinutes} />
      </StatsCard>
      <StatsCard title={t('stats:totalEpisodesWatched')} big={`${data.episodesWatched}`}>
        <BarChart data={data.episodesWatchedChart} color={tokens.watched} />
      </StatsCard>
      <StatsCard title={t('stats:biggestMarathons')}>
        {data.biggestMarathons?.map((m: any, i: number) => (
          <View key={i} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 }}>
            <T variant="caption">{m.showTitle}</T>
            <T variant="caption" style={{ color: tokens.primary }}>{m.episodeCount} {t('stats:epsSuffix')}</T>
          </View>
        ))}
      </StatsCard>
      <StatsCard title={t('stats:addedShows')} big={`${data.addedShows}`} />
      <StatsCard title={t('stats:topShowGenres')}>
        {data.topGenres?.map((g: any, i: number) => (
          <View key={i} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 }}>
            <T variant="caption">{g.name}</T>
            <T variant="caption" muted>{g.count}</T>
          </View>
        ))}
      </StatsCard>
      <StatsCard title={t('stats:topNetworks')}>
        {data.topNetworks?.map((g: any, i: number) => (
          <View key={i} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 }}>
            <T variant="caption">{g.name}</T>
            <T variant="caption" muted>{g.count}</T>
          </View>
        ))}
      </StatsCard>
      <StatsCard title={t('stats:ratings')} big={`${data.votedRatings?.ratings}`} subtitle={t('stats:showsRated', { count: data.votedRatings?.showsRated })} />
      <StatsCard title={t('stats:commentsCard')} big={`${data.comments?.count}`} subtitle={t('stats:showsCommentsSub', { shows: data.comments?.shows, likes: data.earnedLikes })} />
      <StatsCard title={t('stats:catchUpSpeed')} big={t('stats:epsPerWeek', { count: data.catchUpSpeedEpisodesPerWeek })} />
      <StatsCard title={t('stats:remainingEpisodes')} big={`${data.remainingEpisodes}`} subtitle={t('stats:timeToWatch', { time: fmtDuration(data.timeToWatch) })} />
      <StatsCard title={t('stats:futureWatchTime')}>
        <BarChart data={data.futureWatchTimeChart} color={tokens.info} />
        {data.catchUpPredictionDate ? <T variant="caption" muted style={{ marginTop: 6 }}>{t('stats:predictedCatchUp', { date: new Date(data.catchUpPredictionDate).toLocaleDateString() })}</T> : null}
      </StatsCard>
    </View>
  );
}

function MoviesStats({ data, loading }: { data: any; loading: boolean }) {
  const { tokens } = useAppearance();
  const { t } = useTranslation(['stats', 'common']);
  if (loading) return <Spinner />;
  if (!data) return null;
  return (
    <View style={{ gap: spacing.md, marginTop: spacing.md }}>
      <StatsCard title={t('stats:timeWatchingMovies')} big={fmtDuration(data.movieTime)}>
        <BarChart data={data.movieTimeChart} color={tokens.purple} formatValue={fmtChartMinutes} />
      </StatsCard>
      <StatsCard title={t('stats:totalMoviesWatched')} big={`${data.moviesWatched}`}>
        <BarChart data={data.moviesWatchedChart} color={tokens.watched} />
      </StatsCard>
      <StatsCard title={t('stats:topMovieGenres')}>
        {data.topGenres?.map((g: any, i: number) => (
          <View key={i} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 }}>
            <T variant="caption">{g.name}</T>
            <T variant="caption" muted>{g.count}</T>
          </View>
        ))}
      </StatsCard>
      <StatsCard title={t('stats:ratings')} big={`${data.votedRatings?.ratings}`} subtitle={t('stats:moviesRated', { count: data.votedRatings?.moviesRated })} />
      <StatsCard title={t('stats:commentsCard')} big={`${data.comments?.count}`} subtitle={t('stats:likesCard', { count: data.earnedLikes })} />
      <StatsCard title={t('stats:remainingMovies')} big={`${data.remainingMovies}`} subtitle={t('stats:timeToWatch', { time: fmtDuration(data.timeToWatch) })} />
      <StatsCard title={t('stats:catchUpSpeed')} big={t('stats:moviesPerWeek', { count: data.catchUpSpeedMoviesPerWeek })} />
    </View>
  );
}

const styles = StyleSheet.create({
  tabs: { flexDirection: 'row', paddingBottom: spacing.sm },
});