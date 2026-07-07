import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { Header } from '../components/Header';
import { CommentImage } from '../components/CommentImage';
import { EmptyState, PosterImage, Screen, Spinner, T } from '../components/primitives';
import { TextField } from '../components/TextField';
import { useComments } from '../api/hooks';
import { api } from '../api/client';
import { useQueryClient } from '@tanstack/react-query';
import { colors, radius, spacing } from '../theme/theme';

interface Participant { id: string; username: string; avatarUrl?: string | null }

export default function CommentsScreen() {
  const params = useLocalSearchParams<{ type: string; threadId: string }>();
  const threadType = params.type;
  const threadId = params.threadId;
  const { data, isLoading, refetch } = useComments({ threadType, threadId, sort: 'LATEST' });
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
      const manip = await ImageManipulator.manipulateAsync(
        result.assets[0].uri,
        [{ resize: { width: 1600 } }],
        { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG },
      );
      setImageUri(manip.uri);
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
        fd.append('file', { uri: imageUri, name: 'image.jpg', type: 'image/jpeg' } as any);
        setImageUri(null);
        setImageProcessing(true);
        try {
          const imgRes = await api.post<{ commentImageId: string }>(`/comments/${comment.id}/image`, fd);
          // Poll until ready
          const imageId = imgRes.commentImageId;
          for (let i = 0; i < 15; i++) {
            await new Promise((r) => setTimeout(r, 2000));
            const st = await api.get<any>(`/comment-images/${imageId}/status`);
            if (['ready', 'rejected', 'failed'].includes(st.status)) break;
          }
          qc.invalidateQueries({ queryKey: ['comments'] });
        } catch (e: any) {
          Alert.alert('Image upload failed', e?.message ?? 'Please try again');
        } finally {
          setImageProcessing(false);
        }
      }
      if (replyTo) await loadReplies(replyTo.id);
    } catch (e: any) {
      Alert.alert('Failed to post', e?.message ?? 'Please try again');
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
            <CommentImage imageId={item.image.id} width={200} height={130} blurhash={item.image.blurhash} />
          </View>
        ) : item.image && item.image.status !== 'rejected' && item.image.status !== 'deleted' ? (
          <View style={{ marginTop: 8, width: 200, height: 130, borderRadius: 8, backgroundColor: colors.surfaceElevated, alignItems: 'center', justifyContent: 'center' }}>
            <ActivityIndicator color={colors.primary} size="small" />
            <T variant="micro" style={{ color: colors.textMuted, marginTop: 4 }}>Processing image…</T>
          </View>
        ) : null}
        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 6, gap: spacing.md }}>
          <Pressable hitSlop={8} onPress={() => like(item)}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Ionicons name={item.likedByMe ? 'heart' : 'heart-outline'} size={16} color={item.likedByMe ? colors.favorite : colors.textMuted} />
              <T variant="micro" muted style={{ marginLeft: 4 }}>{item.likesCount}</T>
            </View>
          </Pressable>
          {/* Reply only allowed on top-level comments */}
          {!indent && (
            <Pressable hitSlop={8} onPress={() => setReplyTo({ id: item.id, username: item.author?.username })}>
              <T variant="micro" style={{ color: colors.primary }}>Reply</T>
            </Pressable>
          )}
          <Pressable hitSlop={8} onPress={() => api.post(`/comments/${item.id}/report`, { reason: 'OTHER' })}>
            <Ionicons name="flag-outline" size={14} color={colors.textMuted} />
          </Pressable>
        </View>
      </View>
    </View>
  );

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.background }} behavior="padding">
      <Screen style={{ flex: 1 }}>
        <Header title="Comments" showBack />
        {isLoading ? (
          <Spinner />
        ) : (
          <FlatList
            style={{ flex: 1 }}
            data={data?.items ?? []}
            keyExtractor={(i) => i.id}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ padding: spacing.lg, paddingBottom: 20 }}
            ListEmptyComponent={<EmptyState title="No comments yet" subtitle="Be the first to comment." icon="chatbubble-ellipses-outline" />}
            renderItem={({ item }) => (
            <View style={{ marginBottom: spacing.lg }}>
              {renderComment(item)}
              {item.repliesCount > 0 &&
                (replies[item.id] ? (
                  replies[item.id].map((r: any) => renderComment(r, true))
                ) : (
                  <Pressable onPress={() => loadReplies(item.id)} style={{ marginLeft: 48, marginTop: 4 }}>
                    <T variant="micro" style={{ color: colors.primary }}>— View {item.repliesCount} {item.repliesCount === 1 ? 'reply' : 'replies'}</T>
                  </Pressable>
                ))}
            </View>
          )}
        />
      )}

      <View style={styles.bottomBar}>
        {suggestions.length > 0 && (
          <View style={styles.suggestions}>
            {suggestions.map((p) => (
              <Pressable key={p.id} style={styles.suggestion} onPress={() => insertMention(p)}>
                <PosterImage uri={p.avatarUrl} style={{ width: 22, height: 22, borderRadius: 11 }} />
                <T variant="caption">@{p.username}</T>
              </Pressable>
            ))}
          </View>
        )}
        {replyTo ? (
          <View style={styles.replyBanner}>
            <T variant="micro" muted>Replying to @{replyTo.username}</T>
            <Pressable onPress={() => setReplyTo(null)} hitSlop={8}>
              <Ionicons name="close" size={16} color={colors.textMuted} />
            </Pressable>
          </View>
        ) : null}
        {imageProcessing ? (
          <View style={styles.imagePreviewBar}>
            <ActivityIndicator color={colors.primary} size="small" />
            <T variant="micro" style={{ color: colors.primary, marginLeft: spacing.sm }}>Processing image…</T>
          </View>
        ) : null}
        {imageUri ? (
          <View style={styles.imagePreviewBar}>
            <PosterImage uri={imageUri} style={{ width: 50, height: 50, borderRadius: 8 }} />
            <T variant="micro" muted style={{ flex: 1, marginLeft: spacing.sm }}>Image attached</T>
            <Pressable onPress={() => setImageUri(null)} hitSlop={8}>
              <Ionicons name="close-circle" size={20} color={colors.danger} />
            </Pressable>
          </View>
        ) : null}
        <View style={styles.composer}>
          <Pressable onPress={pickImage} disabled={imageCompressing || !!imageUri} hitSlop={8} style={{ marginRight: spacing.sm }}>
            <Ionicons name={imageCompressing ? 'hourglass-outline' : 'image-outline'} size={24} color={imageUri ? colors.textDim : colors.primary} />
          </Pressable>
          <TextField value={body} onChangeText={setBody} placeholder={replyTo ? `Reply to @${replyTo.username}` : 'Add a comment (use @ to mention)'} containerStyle={{ flex: 1, marginBottom: 0 }} />
          <Ionicons name="send" size={24} color={colors.primary} onPress={send} style={{ marginLeft: spacing.sm, opacity: sending ? 0.5 : 1 }} />
        </View>
      </View>
      </Screen>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  comment: { flexDirection: 'row', marginBottom: spacing.lg },
  avatar: { width: 36, height: 36, borderRadius: 18, marginRight: spacing.md },
  composer: { flexDirection: 'row', alignItems: 'center', padding: spacing.md, backgroundColor: colors.surface, borderTopColor: colors.border, borderTopWidth: 1 },
  imagePreviewBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.md, paddingVertical: spacing.sm, backgroundColor: colors.surfaceAlt },
  bottomBar: {},
  suggestions: { backgroundColor: colors.surface, borderTopColor: colors.border, borderTopWidth: 1, paddingHorizontal: spacing.md },
  suggestion: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, gap: spacing.sm },
  replyBanner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.md, paddingVertical: 6, backgroundColor: colors.surfaceAlt },
});
