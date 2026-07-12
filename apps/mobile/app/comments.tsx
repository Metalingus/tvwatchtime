import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import * as WebBrowser from 'expo-web-browser';
import Constants from 'expo-constants';
import { useTranslation } from 'react-i18next';
import { Header } from '../components/Header';
import { CommentImage } from '../components/CommentImage';
import { EmptyState, PosterImage, Screen, Spinner, T } from '../components/primitives';
import { TextField } from '../components/TextField';
import { useComments } from '../api/hooks';
import { api, SITE_URL } from '../api/client';
import { useQueryClient } from '@tanstack/react-query';
import { useAppearance } from '../context/PreferencesProvider';
import { radius, spacing } from '../theme/theme';
import { showError, showSuccess, showDialog } from '../lib/dialog';

interface Participant { id: string; username: string; avatarUrl?: string | null }

type SortMode = 'MOST_LIKED' | 'LATEST';
const PAGE_SIZE = 20;

export default function CommentsScreen() {
  const { tokens } = useAppearance();
  const { t } = useTranslation(['comments', 'common']);
  const params = useLocalSearchParams<{ type: string; threadId: string }>();
  const threadType = params.type;
  const threadId = params.threadId;

  const REPORT_REASONS = [
    { value: 'SPAM', label: t('comments:reportSpam') },
    { value: 'ABUSE', label: t('comments:reportAbuse') },
    { value: 'INAPPROPRIATE', label: t('comments:reportInappropriate') },
    { value: 'OFF_TOPIC', label: t('comments:reportOffTopic') },
    { value: 'COPYRIGHT', label: t('comments:reportCopyright') },
    { value: 'OTHER', label: t('comments:reportOther') },
  ];

  const [sort, setSort] = useState<SortMode>('LATEST');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const { data, isLoading } = useComments({ threadType, threadId, sort, pageSize: visibleCount, polling: true });
  const qc = useQueryClient();

  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);
  const [replyTo, setReplyTo] = useState<{ id: string; username: string } | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [replies, setReplies] = useState<Record<string, any[]>>({});
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [imageCompressing, setImageCompressing] = useState(false);
  const [imageProcessing, setImageProcessing] = useState(false);

  const pickImage = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return;
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.8,
      allowsMultipleSelection: false,
    });
    if (result.canceled || !result.assets?.[0]) return;
    setImageCompressing(true);
    try {
      const asset = result.assets[0];
      const isGif = asset.mimeType === 'image/gif' || asset.uri?.toLowerCase().endsWith('.gif');
      if (isGif) {
        // GIFs: upload as-is — ImageManipulator would flatten animation to a single JPEG frame.
        setImageUri(asset.uri);
      } else {
        const manip = await ImageManipulator.manipulateAsync(
          asset.uri,
          [{ resize: { width: 1600 } }],
          { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG },
        );
        setImageUri(manip.uri);
      }
    } catch {
      setImageUri(result.assets[0].uri);
    } finally {
      setImageCompressing(false);
    }
  };

  useEffect(() => {
    if (!threadId) return;
    api.get<Participant[]>('/comments/participants', { threadType, threadId }).then(setParticipants).catch(() => {});
  }, [threadId, threadType]);

  // @mention suggestion: match an unfinished @token at the end of the input
  const mentionQuery = useMemo(() => {
    const m = body.match(/@([A-Za-z0-9_]+)$/);
    return m ? m[1].toLowerCase() : null;
  }, [body]);
  const suggestions = useMemo(
    () => (mentionQuery ? participants.filter((p) => p.username.toLowerCase().includes(mentionQuery)).slice(0, 5) : []),
    [mentionQuery, participants],
  );

  const send = async () => {
    if (!body.trim() && !imageUri) return;
    setSending(true);
    try {
      const comment: any = await api.post('/comments', { threadType, threadId, body, parentId: replyTo?.id });
      setBody('');
      setReplyTo(null);
      qc.invalidateQueries({ queryKey: ['comments'] });

      if (imageUri && comment?.id) {
        const fd = new FormData();
        try {
          const blob = await fetch(imageUri).then((r) => r.blob());
          fd.append('file', blob, 'image.jpg');
        } catch {
          fd.append('file', { uri: imageUri, name: 'image.jpg', type: 'image/jpeg' } as any);
        }
        setImageUri(null);
        setImageProcessing(true);
        try {
          const imgRes = await api.post<{ commentImageId: string }>(`/comments/${comment.id}/image`, fd);
          const imageId = imgRes.commentImageId;
          for (let i = 0; i < 15; i++) {
            await new Promise((r) => setTimeout(r, 2000));
            const st = await api.get<any>(`/comment-images/${imageId}/status`);
            if (['ready', 'rejected', 'failed'].includes(st.status)) break;
          }
          qc.invalidateQueries({ queryKey: ['comments'] });
        } catch (e: any) {
          showError({ title: t('comments:imageUploadFailed'), description: e?.message ?? t('common:pleaseTryAgain') });
        } finally {
          setImageProcessing(false);
        }
      }
      if (replyTo) await loadReplies(replyTo.id);
    } catch (e: any) {
      showError({ title: t('comments:failedToPost'), description: e?.message ?? t('common:pleaseTryAgain') });
    } finally {
      setSending(false);
    }
  };

  const loadReplies = async (commentId: string) => {
    const r = await api.get<any[]>(`/comments/${commentId}/replies`);
    setReplies((prev) => ({ ...prev, [commentId]: r }));
  };

  const insertMention = (p: Participant) => {
    setBody((b) => b.replace(/@([A-Za-z0-9_]+)$/, `@${p.username} `));
  };

  const like = (item: any) =>
    api.post(`/comments/${item.id}/like`, {}).then(() => qc.invalidateQueries({ queryKey: ['comments'] }));

  const showCommentActions = (item: any) => {
    showDialog({
      title: item.author?.username ?? 'Comment',
      buttons: [
        { label: t('comments:reportComment'), variant: 'secondary', onPress: () => showReportOptions('COMMENT', item.id) },
        { label: t('comments:blockUser', { username: item.author?.username }), variant: 'danger', onPress: () => confirmBlock(item.author?.id, item.author?.username) },
        { label: t('common:cancel'), variant: 'ghost' },
      ],
    });
  };

  const showReportOptions = (targetType: 'COMMENT' | 'IMAGE' | 'USER', targetId: string) => {
    showDialog({
      title: t('comments:reportTitle'),
      description: t('comments:reportSelectReason'),
      buttons: [
        ...REPORT_REASONS.map((r) => ({
          label: r.label,
          variant: 'secondary' as const,
          onPress: () => doReport(targetType, targetId, r.value),
        })),
        { label: t('common:cancel'), variant: 'ghost' },
      ],
    });
  };

  const doReport = async (targetType: string, targetId: string, reason: string) => {
    try {
      const endpoint =
        targetType === 'COMMENT' ? `/comments/${targetId}/report` :
        targetType === 'IMAGE' ? `/images/${targetId}/report` :
        `/users/${targetId}/report`;
      await api.post(endpoint, { reason });
      showSuccess({ title: t('comments:reported'), description: t('comments:reportedDesc') });
    } catch {
      showError({ title: t('comments:failedToReport'), description: t('common:pleaseTryAgain') });
    }
  };

  const confirmBlock = (userId?: string, username?: string) => {
    if (!userId) return;
    showDialog({
      title: t('comments:blockTitle', { username }),
      description: t('comments:blockDesc'),
      buttons: [
        { label: t('common:cancel'), variant: 'secondary' },
        {
          label: t('comments:blockButton'),
          variant: 'danger',
          onPress: () => api.post(`/users/${userId}/block`).then(() => qc.invalidateQueries({ queryKey: ['comments'] })),
        },
      ],
    });
  };

  const showImageActions = (imageId: string) => {
    showDialog({
      title: t('comments:imageTitle'),
      buttons: [
        { label: t('comments:reportImage'), variant: 'secondary', onPress: () => showReportOptions('IMAGE', imageId) },
        { label: t('common:cancel'), variant: 'ghost' },
      ],
    });
  };

  const switchSort = (mode: SortMode) => {
    setSort(mode);
    setVisibleCount(PAGE_SIZE);
  };

  const renderComment = (item: any, indent = false) => (
    <View style={[styles.comment, indent && { marginLeft: spacing.xl + 12 }]} key={item.id}>
      <PosterImage uri={item.author?.avatarUrl} style={styles.avatar} />
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <T variant="caption" style={{ fontWeight: '700' }}>{item.author?.username}</T>
          <T variant="micro" muted style={{ marginLeft: spacing.sm }}>{new Date(item.createdAt).toLocaleDateString()}</T>
        </View>
        <T variant="body" style={{ marginTop: 4 }}>{item.body}</T>
        {item.image?.status === 'ready' ? (
          <View style={{ marginTop: 8 }}>
            <Pressable onLongPress={() => showImageActions(item.image.id)}>
              <CommentImage imageId={item.image.id} width={200} height={130} blurhash={item.image.blurhash} />
            </Pressable>
          </View>
        ) : item.image && item.image.status !== 'rejected' && item.image.status !== 'deleted' ? (
          <View style={{ marginTop: 8, width: 200, height: 130, borderRadius: 8, backgroundColor: tokens.surfaceElevated, alignItems: 'center', justifyContent: 'center' }}>
            <ActivityIndicator color={tokens.primary} size="small" />
            <T variant="micro" style={{ color: tokens.textMuted, marginTop: 4 }}>{t('common:processing')}</T>
          </View>
        ) : null}
        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 6, gap: spacing.md }}>
          <Pressable hitSlop={8} onPress={() => like(item)}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Ionicons name={item.likedByMe ? 'heart' : 'heart-outline'} size={16} color={item.likedByMe ? tokens.favorite : tokens.textMuted} />
              <T variant="micro" muted style={{ marginLeft: 4 }}>{item.likesCount}</T>
            </View>
          </Pressable>
          {!indent && (
            <Pressable hitSlop={8} onPress={() => setReplyTo({ id: item.id, username: item.author?.username })}>
              <T variant="micro" style={{ color: tokens.primary }}>{t('common:reply')}</T>
            </Pressable>
          )}
          <Pressable hitSlop={8} onPress={() => showCommentActions(item)}>
            <Ionicons name="ellipsis-horizontal" size={16} color={tokens.textMuted} />
          </Pressable>
        </View>
      </View>
    </View>
  );

  const items = data?.items ?? [];
  const hasMore = (data?.total ?? 0) > visibleCount;

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: tokens.background }} behavior="padding">
      <Screen style={{ flex: 1 }}>
        <Header title={t('comments:title')} showBack />

        {/* Sort toggle */}
        <View style={[styles.sortBar, { borderBottomColor: tokens.border }]}>
          <Pressable
            onPress={() => switchSort('LATEST')}
            style={[styles.sortChip, { backgroundColor: tokens.surface }, sort === 'LATEST' && { backgroundColor: tokens.primary }]}
          >
            <Ionicons name="time-outline" size={14} color={sort === 'LATEST' ? tokens.primaryForeground : tokens.textMuted} />
            <T variant="micro" style={{ marginLeft: 4, color: sort === 'LATEST' ? tokens.primaryForeground : tokens.textMuted, fontWeight: '600' }}>{t('comments:sortRecent')}</T>
          </Pressable>
          <Pressable
            onPress={() => switchSort('MOST_LIKED')}
            style={[styles.sortChip, { backgroundColor: tokens.surface }, sort === 'MOST_LIKED' && { backgroundColor: tokens.primary }]}
          >
            <Ionicons name="heart-outline" size={14} color={sort === 'MOST_LIKED' ? tokens.primaryForeground : tokens.textMuted} />
            <T variant="micro" style={{ marginLeft: 4, color: sort === 'MOST_LIKED' ? tokens.primaryForeground : tokens.textMuted, fontWeight: '600' }}>{t('comments:sortTop')}</T>
          </Pressable>
          {data?.total != null && (
            <T variant="micro" muted style={{ marginLeft: 'auto' }}>{data.total} {t(data.total === 1 ? 'comments:commentSingular' : 'comments:commentPlural', { count: data.total })}</T>
          )}
        </View>

        {isLoading ? (
          <Spinner />
        ) : (
          <FlatList
            style={{ flex: 1 }}
            data={items}
            keyExtractor={(i) => i.id}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ padding: spacing.lg, paddingBottom: 20 }}
            ListEmptyComponent={<EmptyState title={t('comments:noComments')} subtitle={t('comments:beFirst')} icon="chatbubble-ellipses-outline" />}
            ListFooterComponent={
              hasMore ? (
                <Pressable style={styles.loadMore} onPress={() => setVisibleCount((c) => c + PAGE_SIZE)}>
                  <T variant="caption" style={{ color: tokens.primary, fontWeight: '600' }}>{t('comments:loadMore')}</T>
                </Pressable>
              ) : items.length > PAGE_SIZE ? (
                <T variant="micro" muted style={{ textAlign: 'center', marginTop: spacing.md }}>{t('comments:reachedEnd')}</T>
              ) : null
            }
            renderItem={({ item }) => (
              <View style={{ marginBottom: spacing.lg }}>
                {renderComment(item)}
                {item.repliesCount > 0 &&
                  (replies[item.id] ? (
                    replies[item.id].map((r: any) => renderComment(r, true))
                  ) : (
                    <Pressable onPress={() => loadReplies(item.id)} style={{ marginLeft: 48, marginTop: 4 }}>
                      <T variant="micro" style={{ color: tokens.primary }}>— {t('comments:viewReplies', { count: item.repliesCount, unit: item.repliesCount === 1 ? t('comments:replySingular') : t('comments:replyPlural') })}</T>
                    </Pressable>
                  ))}
              </View>
            )}
          />
        )}

        <View style={styles.bottomBar}>
          {suggestions.length > 0 && (
            <View style={[styles.suggestions, { backgroundColor: tokens.surface, borderTopColor: tokens.border }]}>
              {suggestions.map((p) => (
                <Pressable key={p.id} style={styles.suggestion} onPress={() => insertMention(p)}>
                  <PosterImage uri={p.avatarUrl} style={{ width: 22, height: 22, borderRadius: 11 }} />
                  <T variant="caption">@{p.username}</T>
                </Pressable>
              ))}
            </View>
          )}
          {replyTo ? (
            <View style={[styles.replyBanner, { backgroundColor: tokens.surfaceAlt }]}>
              <T variant="micro" muted>{t('common:replyingTo', { username: replyTo.username })}</T>
              <Pressable onPress={() => setReplyTo(null)} hitSlop={8}>
                <Ionicons name="close" size={16} color={tokens.textMuted} />
              </Pressable>
            </View>
          ) : null}
          {imageProcessing ? (
            <View style={[styles.imagePreviewBar, { backgroundColor: tokens.surfaceAlt }]}>
              <ActivityIndicator color={tokens.primary} size="small" />
              <T variant="micro" style={{ color: tokens.primary, marginLeft: spacing.sm }}>{t('common:processing')}</T>
            </View>
          ) : null}
          {imageUri ? (
            <View style={[styles.imagePreviewBar, { backgroundColor: tokens.surfaceAlt }]}>
              <PosterImage uri={imageUri} style={{ width: 50, height: 50, borderRadius: 8 }} />
              <T variant="micro" muted style={{ flex: 1, marginLeft: spacing.sm }}>{t('comments:imageAttached')}</T>
              <Pressable onPress={() => setImageUri(null)} hitSlop={8}>
                <Ionicons name="close-circle" size={20} color={tokens.danger} />
              </Pressable>
            </View>
          ) : null}
          <View style={[styles.composer, { backgroundColor: tokens.surface, borderTopColor: tokens.border }]}>
            <Pressable onPress={pickImage} disabled={imageCompressing || !!imageUri} hitSlop={8} style={{ marginRight: spacing.sm }}>
              <Ionicons name={imageCompressing ? 'hourglass-outline' : 'image-outline'} size={24} color={imageUri ? tokens.textDim : tokens.primary} />
            </Pressable>
            <TextField value={body} onChangeText={setBody} placeholder={replyTo ? t('common:replyTo', { username: replyTo.username }) : t('comments:addComment')} containerStyle={{ flex: 1, marginBottom: 0 }} />
            <Ionicons name="send" size={24} color={tokens.primary} onPress={send} style={{ marginLeft: spacing.sm, opacity: sending ? 0.5 : 1 }} />
          </View>
        </View>
      </Screen>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  comment: { flexDirection: 'row', marginBottom: spacing.lg },
  avatar: { width: 36, height: 36, borderRadius: 18, marginRight: spacing.md },
  sortBar: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, borderBottomWidth: 1 },
  sortChip: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.md, paddingVertical: 6, borderRadius: radius.pill },
  loadMore: { alignItems: 'center', paddingVertical: spacing.md },
  composer: { flexDirection: 'row', alignItems: 'center', padding: spacing.md, borderTopWidth: 1 },
  imagePreviewBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  bottomBar: {},
  suggestions: { borderTopWidth: 1, paddingHorizontal: spacing.md },
  suggestion: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, gap: spacing.sm },
  replyBanner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.md, paddingVertical: 6 },
});