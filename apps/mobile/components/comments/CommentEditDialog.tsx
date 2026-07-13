import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { useTranslation } from 'react-i18next';
import type { CommentDto } from '@tvwatch/shared';
import { TextField } from '../TextField';
import { GiphyPicker } from '../GiphyPicker';
import { CommentImage } from '../CommentImage';
import { CommentGif } from '../CommentGif';
import { PosterImage, T } from '../primitives';
import { useAppearance } from '../../context/PreferencesProvider';
import { api } from '../../api/client';
import { useUpdateComment } from '../../api/hooks';
import { useQueryClient } from '@tanstack/react-query';
import { radius, spacing } from '../../theme/theme';
import { showError, showSuccess } from '../../lib/dialog';
import { giphyLangFromLocale, selectGiphyApiKey, type GiphyGif, type SelectedGif } from '../../lib/giphy/client';

export function CommentEditDialog({
  comment,
  onClose,
}: {
  comment: CommentDto | null;
  onClose: () => void;
}) {
  const { tokens, resolvedLocale } = useAppearance();
  const giphyLang = giphyLangFromLocale(resolvedLocale);
  const { t } = useTranslation(['comments', 'common']);
  const update = useUpdateComment();
  const qc = useQueryClient();

  const [text, setText] = useState('');
  const [pendingImageUri, setPendingImageUri] = useState<string | null>(null);
  const [pendingGif, setPendingGif] = useState<SelectedGif | null>(null);
  const [removeImage, setRemoveImage] = useState(false);
  const [removeGif, setRemoveGif] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [uploading, setUploading] = useState(false);

  const visible = !!comment;

  useEffect(() => {
    if (comment) {
      setText(comment.body ?? '');
      setPendingImageUri(null);
      setPendingGif(null);
      setRemoveImage(false);
      setRemoveGif(false);
    }
  }, [comment]);

  if (!comment) return null;

  const hasImage = !!comment.image && comment.image.status === 'ready';
  const hasGif = !!comment.gifUrl;

  const pickImage = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) return;
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.8,
      allowsMultipleSelection: false,
    });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    const isGif = asset.mimeType === 'image/gif' || asset.uri?.toLowerCase().endsWith('.gif');
    try {
      if (isGif) {
        setPendingImageUri(asset.uri);
      } else {
        const manip = await ImageManipulator.manipulateAsync(
          asset.uri,
          [{ resize: { width: 1600 } }],
          { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG },
        );
        setPendingImageUri(manip.uri);
      }
    } catch {
      setPendingImageUri(asset.uri);
    }
  };

  const onSelectGif = (gif: GiphyGif) => {
    setPendingGif({
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

  const save = async () => {
    if (update.isPending || uploading) return;
    const dto: any = { body: text };
    if (pendingGif) dto.gifUrl = pendingGif.gifUrl;
    else if (removeGif) dto.gifUrl = null;
    if (pendingImageUri || removeImage) dto.detachImage = true;

    try {
      await update.mutateAsync({ commentId: comment.id, dto });
      if (pendingImageUri) {
        setUploading(true);
        try {
          const fd = new FormData();
          try {
            const blob = await fetch(pendingImageUri).then((r) => r.blob());
            fd.append('file', blob, 'image.jpg');
          } catch {
            fd.append('file', { uri: pendingImageUri, name: 'image.jpg', type: 'image/jpeg' } as any);
          }
          const imgRes = await api.post<{ commentImageId: string }>(`/comments/${comment.id}/image`, fd);
          const imageId = imgRes.commentImageId;
          for (let i = 0; i < 15; i++) {
            await new Promise((r) => setTimeout(r, 2000));
            const st = await api.get<any>(`/comment-images/${imageId}/status`);
            if (['ready', 'rejected', 'failed'].includes(st.status)) break;
          }
        } catch (e: any) {
          showError({ title: t('comments:imageUploadFailed'), description: e?.message ?? t('common:pleaseTryAgain') });
        } finally {
          setUploading(false);
          qc.invalidateQueries({ queryKey: ['comments'] });
          qc.invalidateQueries({ queryKey: ['commentReplies'] });
          qc.invalidateQueries({ queryKey: ['comment', comment.id] });
        }
      }
      showSuccess({ description: t('common:saved') });
      onClose();
    } catch (e: any) {
      showError({ title: t('comments:failedToUpdate'), description: e?.message ?? t('common:pleaseTryAgain') });
    }
  };

  const busy = update.isPending || uploading;

  return (
    <Modal transparent animationType="fade" visible={visible} onRequestClose={onClose}>
      <Pressable style={[styles.backdrop, { backgroundColor: tokens.overlayStrong }]} onPress={onClose}>
        <Pressable
          style={[styles.card, { backgroundColor: tokens.surface, borderColor: tokens.border }]}
          onPress={(e) => e.stopPropagation()}
        >
          <View style={styles.header}>
            <T variant="h1">{t('comments:editCommentTitle')}</T>
            <Pressable onPress={onClose} hitSlop={8}>
              <Ionicons name="close" size={20} color={tokens.textMuted} />
            </Pressable>
          </View>

          <TextField value={text} onChangeText={setText} placeholder={t('comments:addComment')} multiline />

          {/* Current / pending image */}
          {pendingImageUri ? (
            <View style={styles.attachmentRow}>
              <PosterImage uri={pendingImageUri} style={styles.thumb} />
              <Pressable onPress={() => setPendingImageUri(null)} hitSlop={8}>
                <Ionicons name="close-circle" size={20} color={tokens.danger} />
              </Pressable>
            </View>
          ) : hasImage ? (
            <View style={styles.attachmentRow}>
              <CommentImage imageId={comment.image!.id} width={80} height={60} blurhash={comment.image!.blurhash} />
              <Pressable
                onPress={() => setRemoveImage(true)}
                style={[styles.removeBtn, { borderColor: tokens.border }]}
              >
                <T variant="micro" style={{ color: tokens.danger }}>
                  {t('comments:deleteComment')}
                </T>
              </Pressable>
            </View>
          ) : null}

          {/* Current / pending GIF */}
          {pendingGif ? (
            <View style={styles.attachmentRow}>
              <PosterImage uri={pendingGif.previewUrl} style={styles.thumb} />
              <Pressable onPress={() => setPendingGif(null)} hitSlop={8}>
                <Ionicons name="close-circle" size={20} color={tokens.danger} />
              </Pressable>
            </View>
          ) : hasGif ? (
            <View style={styles.attachmentRow}>
              <CommentGif gifUrl={comment.gifUrl!} maxWidth={120} />
              <Pressable
                onPress={() => setRemoveGif(true)}
                style={[styles.removeBtn, { borderColor: tokens.border }]}
              >
                <T variant="micro" style={{ color: tokens.danger }}>
                  {t('comments:deleteComment')}
                </T>
              </Pressable>
            </View>
          ) : null}

          <View style={styles.actions}>
            <Pressable onPress={pickImage} style={[styles.actionChip, { borderColor: tokens.border }]}>
              <Ionicons name="image-outline" size={16} color={tokens.primary} />
              <T variant="micro" style={{ marginLeft: 4, color: tokens.primary }}>
                {t('comments:imageAttached')}
              </T>
            </Pressable>
            <Pressable
              onPress={() => (selectGiphyApiKey() ? setPickerOpen(true) : showError({ description: t('comments:giphyConfigError') }))}
              style={[styles.actionChip, { borderColor: tokens.border }]}
            >
              <T variant="micro" style={{ color: tokens.primary, fontWeight: '700' }}>
                {t('comments:gif')}
              </T>
            </Pressable>
          </View>

          <View style={styles.buttonRow}>
            <Pressable onPress={onClose} style={[styles.btn, styles.btnGhost, { borderColor: tokens.border }]}>
              <T variant="h2">{t('common:cancel')}</T>
            </Pressable>
            <Pressable onPress={save} disabled={busy} style={[styles.btn, { backgroundColor: tokens.primary, opacity: busy ? 0.6 : 1 }]}>
              {busy ? <ActivityIndicator color={tokens.primaryForeground} /> : <T variant="h2" style={{ color: tokens.primaryForeground }}>{t('comments:save')}</T>}
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
      <GiphyPicker visible={pickerOpen} lang={giphyLang} onClose={() => setPickerOpen(false)} onSelect={onSelectGif} />
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: spacing.lg },
  card: { width: '100%', maxWidth: 460, borderRadius: radius.xl, borderWidth: 1, padding: spacing.lg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.md },
  attachmentRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginTop: spacing.sm },
  thumb: { width: 60, height: 60, borderRadius: radius.sm },
  removeBtn: { borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: spacing.md, paddingVertical: 6 },
  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  actionChip: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderRadius: radius.sm, paddingHorizontal: spacing.md, paddingVertical: 8 },
  buttonRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm, marginTop: spacing.lg },
  btn: { paddingVertical: spacing.md, paddingHorizontal: spacing.lg, borderRadius: radius.pill, minWidth: 96, alignItems: 'center' },
  btnGhost: { backgroundColor: 'transparent', borderWidth: 1 },
});
