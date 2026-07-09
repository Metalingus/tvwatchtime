import React from 'react';
import { ImageBackground, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { Header } from '../../components/Header';
import { Button, Card, PosterImage, Screen, Spinner, T } from '../../components/primitives';
import { usePublicProfile, useFollowUser, useUnfollowUser } from '../../api/hooks';
import { colors, radius, spacing } from '../../theme/theme';

export default function UserProfileScreen() {
  const { username } = useLocalSearchParams<{ username: string }>();
  const { data: profile, isLoading } = usePublicProfile(username);
  const followMut = useFollowUser();
  const unfollowMut = useUnfollowUser();

  if (isLoading || !profile) return <Screen><Header showBack /><Spinner /></Screen>;

  const toggleFollow = () => {
    if (profile.isFollowing) unfollowMut.mutate(profile.id);
    else followMut.mutate(profile.id);
  };

  return (
    <Screen>
      <Header showBack />
      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={{ position: 'relative', height: 180 }}>
          <ImageBackground source={profile.coverUrl ? { uri: profile.coverUrl } : undefined} style={StyleSheet.absoluteFill}>
            <LinearGradient colors={['transparent', colors.background]} style={StyleSheet.absoluteFill} />
          </ImageBackground>
          <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0, flexDirection: 'row', alignItems: 'flex-end', padding: spacing.lg }}>
            <PosterImage uri={profile.avatarUrl} style={styles.avatar} />
            <View style={{ flex: 1, marginLeft: spacing.md, paddingBottom: 4 }}>
              <T variant="h1">@{profile.username}</T>
              {profile.displayName ? <T variant="body" muted>{profile.displayName}</T> : null}
            </View>
          </View>
        </View>

        <View style={{ paddingHorizontal: spacing.lg, gap: spacing.md, paddingBottom: 60 }}>
          {profile.bio ? (
            <Card>
              <T variant="body">{profile.bio}</T>
            </Card>
          ) : null}

          <View style={{ flexDirection: 'row', gap: spacing.lg }}>
            <Pressable onPress={() => router.push(`/follows?u=${profile.username}&t=followers`)}>
              <T variant="h2">{profile.followersCount}</T>
              <T variant="caption" muted>Followers</T>
            </Pressable>
            <Pressable onPress={() => router.push(`/follows?u=${profile.username}&t=following`)}>
              <T variant="h2">{profile.followingCount}</T>
              <T variant="caption" muted>Following</T>
            </Pressable>
          </View>

          {!profile.isMe ? (
            <Button
              title={profile.isFollowing ? 'Following' : 'Follow'}
              onPress={toggleFollow}
              loading={followMut.isPending || unfollowMut.isPending}
              icon={profile.isFollowing ? 'checkmark-circle-outline' : 'person-add-outline'}
              variant={profile.isFollowing ? 'ghost' : 'default'}
            />
          ) : null}
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  avatar: { width: 80, height: 80, borderRadius: 40, borderWidth: 3, borderColor: colors.background },
});
