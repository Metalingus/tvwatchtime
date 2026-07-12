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

export default function StatsScreen() {
  const { tokens } = useAppearance();
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
      <Header title="Stats" showBack />
      <View style={[styles.tabs, { paddingHorizontal: spacing.lg }]}>
        <Chip label="Shows" active={tab === 'shows'} onPress={() => setTab('shows')} />
        <Chip label="Movies" active={tab === 'movies'} onPress={() => setTab('movies')} />
      </View>
      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: 60 }} showsVerticalScrollIndicator={false} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[tokens.primary]} tintColor={tokens.primary} />}>
        {summary.isLoading ? <Spinner /> : (
          <StatsCard title="Total time" big={`${fmtDuration(summary.data?.tvTime)} TV · ${fmtDuration(summary.data?.movieTime)} movies`} subtitle={`${summary.data?.episodesWatched ?? 0} episodes · ${summary.data?.moviesWatched ?? 0} movies`} />
        )}
        {tab === 'shows' ? <ShowsStats data={shows.data} loading={shows.isLoading} /> : <MoviesStats data={movies.data} loading={movies.isLoading} />}

        {/* Leaderboard */}
        <View style={{ marginTop: spacing.lg }}>
          <SectionHeader title="Leaderboard" />
          <Leaderboard tabs={[{ key: 'shows', label: 'Shows' }, { key: 'movies', label: 'Movies' }]} />
        </View>

        <SectionHeader title="Badges" />
        {badges.isLoading ? <Spinner /> : (
          <View>
            <StatsCard big={`${badges.data?.totalUnlocked ?? 0}`} subtitle={`of ${badges.data?.totalBadges ?? 0} badges unlocked`} />
            <BadgeGrid badges={badges.data?.badges ?? []} />
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}

function ShowsStats({ data, loading }: { data: any; loading: boolean }) {
  const { tokens } = useAppearance();
  if (loading) return <Spinner />;
  if (!data) return null;
  return (
    <View style={{ gap: spacing.md, marginTop: spacing.md }}>
      <StatsCard title="Time spent watching episodes" big={fmtDuration(data.tvTime)} subtitle="Last 7 days included">
        <BarChart data={data.tvTimeChart} />
      </StatsCard>
      <StatsCard title="Total episodes watched" big={`${data.episodesWatched}`}>
        <BarChart data={data.episodesWatchedChart} color={tokens.watched} />
      </StatsCard>
      <StatsCard title="Biggest marathons">
        {data.biggestMarathons?.map((m: any, i: number) => (
          <View key={i} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 }}>
            <T variant="caption">{m.showTitle}</T>
            <T variant="caption" style={{ color: tokens.primary }}>{m.episodeCount} eps</T>
          </View>
        ))}
      </StatsCard>
      <StatsCard title="Added shows" big={`${data.addedShows}`} />
      <StatsCard title="Top show genres">
        {data.topGenres?.map((g: any, i: number) => (
          <View key={i} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 }}>
            <T variant="caption">{g.name}</T>
            <T variant="caption" muted>{g.count}</T>
          </View>
        ))}
      </StatsCard>
      <StatsCard title="Top networks">
        {data.topNetworks?.map((g: any, i: number) => (
          <View key={i} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 }}>
            <T variant="caption">{g.name}</T>
            <T variant="caption" muted>{g.count}</T>
          </View>
        ))}
      </StatsCard>
      <StatsCard title="Ratings" big={`${data.votedRatings?.ratings}`} subtitle={`${data.votedRatings?.showsRated} shows rated`} />
      <StatsCard title="Comments" big={`${data.comments?.count}`} subtitle={`${data.comments?.shows} shows · ${data.earnedLikes} likes`} />
      <StatsCard title="Catch-up speed" big={`${data.catchUpSpeedEpisodesPerWeek} eps/week`} />
      <StatsCard title="Remaining episodes" big={`${data.remainingEpisodes}`} subtitle={`${fmtDuration(data.timeToWatch)} to watch`} />
      <StatsCard title="Future watch time">
        <BarChart data={data.futureWatchTimeChart} color={tokens.info} />
        {data.catchUpPredictionDate ? <T variant="caption" muted style={{ marginTop: 6 }}>Predicted catch-up: {new Date(data.catchUpPredictionDate).toLocaleDateString()}</T> : null}
      </StatsCard>
    </View>
  );
}

function MoviesStats({ data, loading }: { data: any; loading: boolean }) {
  const { tokens } = useAppearance();
  if (loading) return <Spinner />;
  if (!data) return null;
  return (
    <View style={{ gap: spacing.md, marginTop: spacing.md }}>
      <StatsCard title="Time spent watching movies" big={fmtDuration(data.movieTime)}>
        <BarChart data={data.movieTimeChart} color={tokens.purple} />
      </StatsCard>
      <StatsCard title="Total movies watched" big={`${data.moviesWatched}`}>
        <BarChart data={data.moviesWatchedChart} color={tokens.watched} />
      </StatsCard>
      <StatsCard title="Top movie genres">
        {data.topGenres?.map((g: any, i: number) => (
          <View key={i} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4 }}>
            <T variant="caption">{g.name}</T>
            <T variant="caption" muted>{g.count}</T>
          </View>
        ))}
      </StatsCard>
      <StatsCard title="Ratings" big={`${data.votedRatings?.ratings}`} subtitle={`${data.votedRatings?.moviesRated} movies rated`} />
      <StatsCard title="Comments" big={`${data.comments?.count}`} subtitle={`${data.earnedLikes} likes`} />
      <StatsCard title="Remaining movies" big={`${data.remainingMovies}`} subtitle={`${fmtDuration(data.timeToWatch)} to watch`} />
      <StatsCard title="Catch-up speed" big={`${data.catchUpSpeedMoviesPerWeek} movies/week`} />
    </View>
  );
}

const styles = StyleSheet.create({
  tabs: { flexDirection: 'row', paddingBottom: spacing.sm },
});
