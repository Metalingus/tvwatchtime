import React, { useEffect, useMemo, useRef, useState } from 'react';
import { randomUUID } from 'expo-crypto';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { useTranslation } from 'react-i18next';
import type { CommentDto, ExternalReviewDto, CommsUniWriteMention } from '@tvwatch/shared';
import { TextField } from '../TextField';
import { commentModerationErrorKey } from './moderation-errors';
import { GiphyPicker } from '../GiphyPicker';
import { MediaPickerModal, type AttachedList, type AttachedMedia } from './MediaPickerModal';
import { PosterImage, T, APP_ICON } from '../primitives';
import { useAppearance } from '../../context/PreferencesProvider';
import { api } from '../../api/client';
import { useCreateComment, useCommentParticipants, useFeatureFlags } from '../../api/hooks';
import { replyMention, retainedMentions } from '../../api/commsuni-presentation';
import { supportsCommsUniProtocol } from '../../api/commsuni-capabilities';
import { useQueryClient } from '@tanstack/react-query';
import { feedColumn } from './layout';
import { radius, spacing } from '../../theme/theme';
import { showError, showDialog } from '../../lib/dialog';
import { fireAnalytics } from '../../lib/giphy/analytics';
import {
  giphyLangFromLocale,
  selectGiphyApiKey,
  type GiphyGif,
  type SelectedGif,
} from '../../lib/giphy/client';

interface Participant {
  id: string;
  username: string;
  avatarUrl?: string | null;
}

export interface CommentComposerProps {
  threadType: string;
  threadId: string;
  /** Parent comment id when composing a reply; omit/null for a top-level comment. */
  parentId?: string | null;
  commsUniParentId?: string;
  placeholder?: string;
  onSent?: (commentId: string) => void;
  onCreated?: (comment: CommentDto) => void;
  commsUniReplyAuthor?: { id: string; displayName: string };
  /** The comment being replied to inside a thread — shows a dismissible chip. */
  replyTarget?: CommentDto | null;
  /** Cancel replying to replyTarget (falls back to the thread root). */
  onCancelReply?: () => void;
  /** The TMDB review being replied to (review acts as the parent post). */
  reviewTarget?: ExternalReviewDto | null;
  /** Dismiss the review reply anchor. */
  onCancelReviewReply?: () => void;
}

export function CommentComposer({
  threadType,
  threadId,
  parentId = null,
  commsUniParentId,
  placeholder,
  onSent,
  onCreated,
  commsUniReplyAuthor,
  replyTarget = null,
  onCancelReply,
  reviewTarget = null,
  onCancelReviewReply,
}: CommentComposerProps) {
  const { tokens, resolvedLocale } = useAppearance();
  const giphyLang = giphyLangFromLocale(resolvedLocale);
  const { t } = useTranslation(['comments', 'lists', 'common']);

  const create = useCreateComment();
  const { data: featureFlags } = useFeatureFlags();
  const submission = useRef<{ signature: string; id: string; createdAt: string } | null>(null);
  const imageDraft = useRef<{ id: string; commsUniState?: string } | null>(null);
  useEffect(() => {
    imageDraft.current = null;
    submission.current = null;
  }, [threadType, threadId, parentId, commsUniParentId]);
  const qc = useQueryClient();
  const { data: participants = [] } = useCommentParticipants(threadType, threadId);

  const [body, setBody] = useState('');
  const [sharedMentions, setSharedMentions] = useState<CommsUniWriteMention[]>([]);
  const replyAuthorId = commsUniReplyAuthor?.id;
  const replyAuthorName = commsUniReplyAuthor?.displayName;
  useEffect(() => {
    if (!replyAuthorId || !replyAuthorName) {
      const previous = sharedMentions[0];
      if (previous)
        setBody((current) =>
          current.startsWith(previous.text + ' ')
            ? current.slice(previous.text.length + 1)
            : current,
        );
      setSharedMentions([]);
      return;
    }
    const mention = replyMention({ id: replyAuthorId, displayName: replyAuthorName });
    setBody((current) => {
      const previous = sharedMentions[0];
      const text =
        previous && current.startsWith(previous.text + ' ')
          ? current.slice(previous.text.length + 1)
          : current;
      return mention.text + ' ' + text;
    });
    setSharedMentions([mention]);
    // Re-anchor only when the reply target changes, not while the user edits the span.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replyAuthorId, replyAuthorName, commsUniParentId]);
  // Auto-growing input: measured content height, clamped between one row and ~5 rows.
  const [inputH, setInputH] = useState<number | null>(null);
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [imageCompressing, setImageCompressing] = useState(false);
  const [imageProcessing, setImageProcessing] = useState(false);
  const [selectedGif, setSelectedGif] = useState<SelectedGif | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [attachedMedia, setAttachedMedia] = useState<AttachedMedia | null>(null);
  const [attachedList, setAttachedList] = useState<AttachedList | null>(null);
  const [mediaPickerOpen, setMediaPickerOpen] = useState(false);
  const [spoiler, setSpoiler] = useState(false);
  const hasCardAttachment = !!attachedMedia || !!attachedList;

  const sending = create.isPending || imageProcessing;

  const mentionQuery = useMemo(() => {
    const m = body.match(/@([A-Za-z0-9_]+)$/);
    return m ? m[1].toLowerCase() : null;
  }, [body]);
  const suggestions = useMemo(
    () =>
      mentionQuery
        ? participants
            .filter((p: Participant) => p.username.toLowerCase().includes(mentionQuery))
            .slice(0, 5)
        : [],
    [mentionQuery, participants],
  );

  const openGifPicker = () => {
    if (imageUri) {
      showDialog({
        title: t('comments:replaceImageWithGif'),
        buttons: [
          {
            label: t('comments:replaceAttachment'),
            variant: 'danger',
            onPress: () => {
              setImageUri(null);
              setPickerOpen(true);
            },
          },
          { label: t('common:cancel'), variant: 'ghost' },
        ],
      });
      return;
    }
    if (!selectGiphyApiKey()) {
      showError({ description: t('comments:giphyConfigError') });
      return;
    }
    setPickerOpen(true);
  };

  const onSelectGif = (gif: GiphyGif) => {
    setSelectedGif({
      id: gif.id,
      title: gif.title,
      previewUrl: gif.previewUrl,
      gifUrl: gif.gifUrl,
      width: gif.width,
      height: gif.height,
      analyticsOnSentUrl: gif.analytics?.onsent,
    });
    setPickerOpen(false);
  };

  const pickImage = async () => {
    if (selectedGif) {
      showDialog({
        title: t('comments:replaceGifWithImage'),
        buttons: [
          {
            label: t('comments:replaceAttachment'),
            variant: 'danger',
            onPress: () => {
              setSelectedGif(null);
              void pickImage();
            },
          },
          { label: t('common:cancel'), variant: 'ghost' },
        ],
      });
      return;
    }
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

  const insertMention = (p: Participant) => {
    setBody((b) => b.replace(/@([A-Za-z0-9_]+)$/, `@${p.username} `));
  };

  const send = async () => {
    if (sending) return;
    if (!body.trim() && !imageUri && !selectedGif && !attachedMedia && !attachedList) return;
    const onsentUrl = selectedGif?.analyticsOnSentUrl;
    const signature = JSON.stringify({
      body,
      parentId,
      commsUniParentId,
      imageUri,
      selectedGif,
      attachedMedia,
      attachedList,
      spoiler,
    });
    if (submission.current?.signature !== signature)
      submission.current = { signature, id: randomUUID(), createdAt: new Date().toISOString() };
    const retryingImage = !!(imageDraft.current && imageUri);
    try {
      const comment: any = retryingImage
        ? imageDraft.current
        : await create.mutateAsync({
            threadType,
            threadId,
            ...(supportsCommsUniProtocol(featureFlags)
              ? {
                  clientActionId: submission.current.id,
                  createdAt: submission.current.createdAt,
                  attachmentPending: !!imageUri,
                  commsUniParentId,
                  ...(sharedMentions.length
                    ? { commsUniMentions: retainedMentions(body, sharedMentions) }
                    : {}),
                }
              : {}),
            body,
            parentId: parentId ?? undefined,
            gifUrl: selectedGif?.gifUrl,
            mediaType: attachedMedia?.mediaType,
            mediaId: attachedMedia?.mediaId,
            listId: attachedList?.id,
            isSpoiler: spoiler || undefined,
            externalReviewId: reviewTarget?.id,
          });
      if (!retryingImage) {
        onCreated?.(comment);
        submission.current = null;
        setBody(commsUniReplyAuthor ? replyMention(commsUniReplyAuthor).text + ' ' : '');
        setInputH(null);
        setSelectedGif(null);
        setAttachedMedia(null);
        setAttachedList(null);
        setSpoiler(false);
        fireAnalytics(onsentUrl);
      }

      if (imageUri && comment?.id) {
        imageDraft.current = comment;
        const fd = new FormData();
        try {
          const blob = await fetch(imageUri).then((r) => r.blob());
          fd.append('file', blob, 'image.jpg');
        } catch {
          fd.append('file', { uri: imageUri, name: 'image.jpg', type: 'image/jpeg' } as any);
        }
        setImageProcessing(true);
        try {
          const imgRes = await api.post<{ commentImageId: string }>(
            `/comments/${comment.id}/image`,
            fd,
          );
          const imageId = imgRes.commentImageId;
          setImageUri(null);
          imageDraft.current = null;
          for (let i = 0; i < 15; i++) {
            await new Promise((r) => setTimeout(r, 2000));
            const st = await api.get<any>(`/comment-images/${imageId}/status`);
            if (st.status === 'ready') {
              if (comment.commsUniState === 'WAITING_ATTACHMENT')
                await api.post(`/conversations/comments/${comment.id}/finalize`, {});
              break;
            }
            if (['rejected', 'failed'].includes(st.status)) break;
          }
        } catch (e: any) {
          showError({
            title: t('comments:imageUploadFailed'),
            description: e?.message ?? t('common:pleaseTryAgain'),
          });
        } finally {
          setImageProcessing(false);
          qc.invalidateQueries({ queryKey: ['comments'] });
          if (parentId) {
            qc.invalidateQueries({ queryKey: ['commentReplies', parentId] });
            qc.invalidateQueries({ queryKey: ['comment', parentId] });
          } else {
            qc.invalidateQueries({ queryKey: ['commentReplies'] });
          }
        }
      }
      onSent?.(comment?.id);
    } catch (e: any) {
      const moderationKey = commentModerationErrorKey(e);
      showError({
        title: t('comments:failedToPost'),
        description: moderationKey ? t(moderationKey) : (e?.message ?? t('common:pleaseTryAgain')),
      });
    }
  };

  return (
    <View style={styles.bottomBar}>
      <View style={feedColumn.root}>
        {featureFlags?.commsuni_read &&
        featureFlags.commsuni_write &&
        !attachedMedia &&
        !attachedList &&
        !reviewTarget &&
        threadType !== 'GROUP' &&
        (body.trim() || imageUri || selectedGif || attachedMedia || attachedList) ? (
          <T
            variant="micro"
            muted
            style={{ paddingHorizontal: spacing.md, paddingBottom: spacing.xs }}
          >
            {t('comments:commsuni.sharedComposer')}
          </T>
        ) : null}
        {replyTarget ? (
          <View style={[styles.previewBar, { backgroundColor: tokens.surfaceAlt }]}>
            <Ionicons name="return-down-forward-outline" size={18} color={tokens.primary} />
            <T
              variant="micro"
              style={{ color: tokens.primary, flex: 1, marginLeft: spacing.sm }}
              numberOfLines={1}
            >
              {t('comments:replyingTo', { username: replyTarget.author?.username })}
            </T>
            <Pressable
              onPress={onCancelReply}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t('comments:cancelReply')}
            >
              <Ionicons name="close-circle" size={20} color={tokens.textMuted} />
            </Pressable>
          </View>
        ) : null}
        {reviewTarget ? (
          <View style={[styles.previewBar, { backgroundColor: tokens.surfaceAlt }]}>
            <Ionicons name="return-down-forward-outline" size={18} color={tokens.primary} />
            <T
              variant="micro"
              style={{ color: tokens.primary, flex: 1, marginLeft: spacing.sm }}
              numberOfLines={1}
            >
              {t('comments:replyingToReview', { author: reviewTarget.author })}
            </T>
            <Pressable
              onPress={onCancelReviewReply}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t('comments:cancelReply')}
            >
              <Ionicons name="close-circle" size={20} color={tokens.textMuted} />
            </Pressable>
          </View>
        ) : null}
        {suggestions.length > 0 ? (
          <View
            style={[
              styles.suggestions,
              { backgroundColor: tokens.surface, borderTopColor: tokens.border },
            ]}
          >
            {suggestions.map((p: Participant) => (
              <Pressable key={p.id} style={styles.suggestion} onPress={() => insertMention(p)}>
                <PosterImage
                  uri={p.avatarUrl}
                  fallback={APP_ICON}
                  style={{ width: 22, height: 22, borderRadius: 11 }}
                />
                <T variant="caption">@{p.username}</T>
              </Pressable>
            ))}
          </View>
        ) : null}
        {imageProcessing ? (
          <View style={[styles.previewBar, { backgroundColor: tokens.surfaceAlt }]}>
            <ActivityIndicator color={tokens.primary} size="small" />
            <T variant="micro" style={{ color: tokens.primary, marginLeft: spacing.sm }}>
              {t('common:processing')}
            </T>
          </View>
        ) : null}
        {imageUri ? (
          <View style={[styles.previewBar, { backgroundColor: tokens.surfaceAlt }]}>
            <PosterImage uri={imageUri} style={{ width: 50, height: 50, borderRadius: 8 }} />
            <T variant="micro" muted style={{ flex: 1, marginLeft: spacing.sm }}>
              {t('comments:imageAttached')}
            </T>
            <Pressable onPress={() => setImageUri(null)} hitSlop={8}>
              <Ionicons name="close-circle" size={20} color={tokens.danger} />
            </Pressable>
          </View>
        ) : null}
        {selectedGif ? (
          <View style={[styles.previewBar, { backgroundColor: tokens.surfaceAlt }]}>
            <PosterImage
              uri={selectedGif.previewUrl}
              style={{ width: 50, height: 50, borderRadius: 8 }}
            />
            <T variant="micro" muted style={{ flex: 1, marginLeft: spacing.sm }}>
              {t('comments:gif')}
            </T>
            <Pressable
              onPress={() => setSelectedGif(null)}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t('comments:removeGif')}
            >
              <Ionicons name="close-circle" size={20} color={tokens.danger} />
            </Pressable>
          </View>
        ) : null}
        {attachedMedia ? (
          <View style={[styles.previewBar, { backgroundColor: tokens.surfaceAlt }]}>
            <PosterImage
              uri={attachedMedia.posterUrl}
              style={{ width: 34, height: 50, borderRadius: 6 }}
            />
            <View style={{ flex: 1, marginLeft: spacing.sm }}>
              <T variant="caption" numberOfLines={1}>
                {attachedMedia.title}
              </T>
              {attachedMedia.year ? (
                <T variant="micro" muted>
                  {attachedMedia.year}
                </T>
              ) : null}
            </View>
            <Pressable
              onPress={() => setAttachedMedia(null)}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t('common:remove')}
            >
              <Ionicons name="close-circle" size={20} color={tokens.danger} />
            </Pressable>
          </View>
        ) : null}
        {attachedList ? (
          <View style={[styles.previewBar, { backgroundColor: tokens.surfaceAlt }]}>
            {attachedList.coverUrl ? (
              <PosterImage
                uri={attachedList.coverUrl}
                style={{ width: 50, height: 34, borderRadius: 6 }}
              />
            ) : (
              <Ionicons name="list-outline" size={24} color={tokens.primary} />
            )}
            <View style={{ flex: 1, marginLeft: spacing.sm }}>
              <T variant="caption" numberOfLines={1}>
                {attachedList.title}
              </T>
              <T variant="micro" muted>
                {attachedList.movieCount > 0 ? `🎬 ${attachedList.movieCount}` : ''}
                {attachedList.movieCount > 0 && attachedList.showCount > 0 ? '  ' : ''}
                {attachedList.showCount > 0 ? `📺 ${attachedList.showCount}` : ''}
                {!attachedList.movieCount && !attachedList.showCount ? t('lists:emptyLabel') : ''}
              </T>
            </View>
            <Pressable
              onPress={() => setAttachedList(null)}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t('common:remove')}
            >
              <Ionicons name="close-circle" size={20} color={tokens.danger} />
            </Pressable>
          </View>
        ) : null}
      </View>
      <View
        style={[
          styles.composer,
          { backgroundColor: tokens.surface, borderTopColor: tokens.border },
        ]}
      >
        <View style={[feedColumn.root, styles.composerRow]}>
          {/* Attachment actions stacked 2×2 so the input gets the horizontal space. */}
          <View style={styles.iconGrid}>
            <View style={styles.iconGridRow}>
              <Pressable
                onPress={pickImage}
                disabled={imageCompressing || !!imageUri || !!selectedGif || hasCardAttachment}
                hitSlop={8}
                style={styles.gridBtn}
                accessibilityRole="button"
                accessibilityLabel={t('comments:imageAttached')}
              >
                <Ionicons
                  name={imageCompressing ? 'hourglass-outline' : 'image-outline'}
                  size={22}
                  color={
                    imageUri || selectedGif || hasCardAttachment ? tokens.textDim : tokens.primary
                  }
                />
              </Pressable>
              <Pressable
                onPress={openGifPicker}
                disabled={
                  sending || imageCompressing || !!selectedGif || !!imageUri || hasCardAttachment
                }
                hitSlop={8}
                style={[
                  styles.gifButton,
                  {
                    borderColor:
                      selectedGif || imageUri || hasCardAttachment ? tokens.border : tokens.primary,
                  },
                ]}
                accessibilityRole="button"
                accessibilityLabel={t('comments:addGif')}
              >
                <T
                  variant="micro"
                  style={{
                    color:
                      selectedGif || imageUri || hasCardAttachment
                        ? tokens.textDim
                        : tokens.primary,
                    fontWeight: '700',
                  }}
                >
                  {t('comments:gif')}
                </T>
              </Pressable>
            </View>
            <View style={styles.iconGridRow}>
              <Pressable
                onPress={() => setMediaPickerOpen(true)}
                disabled={
                  sending || imageCompressing || !!selectedGif || !!imageUri || hasCardAttachment
                }
                hitSlop={8}
                style={styles.gridBtn}
                accessibilityRole="button"
                accessibilityLabel={t('comments:attachMedia')}
              >
                <Ionicons
                  name="film-outline"
                  size={22}
                  color={
                    selectedGif || imageUri || hasCardAttachment ? tokens.textDim : tokens.primary
                  }
                />
              </Pressable>
              <Pressable
                onPress={() => setSpoiler((v) => !v)}
                hitSlop={8}
                style={styles.gridBtn}
                accessibilityRole="button"
                accessibilityLabel={t('comments:markAsSpoiler')}
                accessibilityState={{ selected: spoiler }}
              >
                <Ionicons
                  name={spoiler ? 'eye-off' : 'eye-off-outline'}
                  size={22}
                  color={spoiler ? tokens.orange : tokens.primary}
                />
              </Pressable>
            </View>
          </View>
          <TextField
            value={body}
            editable={!sending && !(imageDraft.current && imageUri)}
            onChangeText={setBody}
            placeholder={placeholder ?? t('comments:addComment')}
            containerStyle={{ flex: 1, marginBottom: 0 }}
            multiline
            onContentSizeChange={(e: any) => setInputH(e?.nativeEvent?.contentSize?.height ?? null)}
            style={[
              styles.composerInput,
              inputH != null
                ? { height: Math.min(INPUT_MAX_H, Math.max(INPUT_MIN_H, Math.ceil(inputH))) }
                : null,
            ]}
          />
          <Pressable
            onPress={send}
            disabled={sending}
            hitSlop={8}
            style={[styles.actionBtn, { marginLeft: spacing.sm, opacity: sending ? 0.5 : 1 }]}
            accessibilityRole="button"
          >
            <Ionicons
              name={imageDraft.current && imageUri ? 'refresh' : 'send'}
              size={24}
              color={tokens.primary}
            />
          </Pressable>
        </View>
      </View>
      <GiphyPicker
        visible={pickerOpen}
        lang={giphyLang}
        onClose={() => setPickerOpen(false)}
        onSelect={onSelectGif}
      />
      <MediaPickerModal
        visible={mediaPickerOpen}
        onClose={() => setMediaPickerOpen(false)}
        onSelect={(media) => {
          setAttachedMedia(media);
          setAttachedList(null);
          setMediaPickerOpen(false);
        }}
        onSelectList={(list) => {
          setAttachedList(list);
          setAttachedMedia(null);
          setMediaPickerOpen(false);
        }}
      />
    </View>
  );
}

const INPUT_MIN_H = 64; // two rows by default (padding 12×2 + 2×~20px text lines)
const INPUT_MAX_H = 132; // ~5 rows, then the input scrolls internally

const styles = StyleSheet.create({
  bottomBar: {},
  suggestions: { borderTopWidth: 1, paddingHorizontal: spacing.lg },
  suggestion: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, gap: spacing.sm },
  previewBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  composer: { borderTopWidth: 1 },
  composerRow: {
    flexDirection: 'row',
    alignItems: 'flex-end', // buttons stay pinned to the bottom as the input grows
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  actionBtn: { height: INPUT_MIN_H, alignItems: 'center', justifyContent: 'center' },
  composerInput: { minHeight: INPUT_MIN_H, maxHeight: INPUT_MAX_H },
  iconGrid: {
    flexDirection: 'column',
    justifyContent: 'center',
    marginRight: spacing.sm,
    gap: 2,
  },
  iconGridRow: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  gridBtn: {
    width: 32,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
  },
  gifButton: {
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: 6,
    paddingVertical: 2,
    minWidth: 40,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
