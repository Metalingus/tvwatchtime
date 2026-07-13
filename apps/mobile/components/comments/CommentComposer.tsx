import React, { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';
import { useTranslation } from 'react-i18next';
import { TextField } from '../TextField';
import { GiphyPicker } from '../GiphyPicker';
import { PosterImage, T } from '../primitives';
import { useAppearance } from '../../context/PreferencesProvider';
import { api } from '../../api/client';
import { useCreateComment, useCommentParticipants } from '../../api/hooks';
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
  placeholder?: string;
  onSent?: (commentId: string) => void;
}

export function CommentComposer({ threadType, threadId, parentId = null, placeholder, onSent }: CommentComposerProps) {
  const { tokens, resolvedLocale } = useAppearance();
  const giphyLang = giphyLangFromLocale(resolvedLocale);
  const { t } = useTranslation(['comments', 'common']);

  const create = useCreateComment();
  const qc = useQueryClient();
  const { data: participants = [] } = useCommentParticipants(threadType, threadId);

  const [body, setBody] = useState('');
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [imageCompressing, setImageCompressing] = useState(false);
  const [imageProcessing, setImageProcessing] = useState(false);
  const [selectedGif, setSelectedGif] = useState<SelectedGif | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const sending = create.isPending;

  const mentionQuery = useMemo(() => {
    const m = body.match(/@([A-Za-z0-9_]+)$/);
    return m ? m[1].toLowerCase() : null;
  }, [body]);
  const suggestions = useMemo(
    () =>
      mentionQuery
        ? participants.filter((p: Participant) => p.username.toLowerCase().includes(mentionQuery)).slice(0, 5)
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
    if (!body.trim() && !imageUri && !selectedGif) return;
    const onsentUrl = selectedGif?.analyticsOnSentUrl;
    try {
      const comment: any = await create.mutateAsync({
        threadType,
        threadId,
        body,
        parentId: parentId ?? undefined,
        gifUrl: selectedGif?.gifUrl,
      });
      setBody('');
      setSelectedGif(null);
      fireAnalytics(onsentUrl);

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
        } catch (e: any) {
          showError({ title: t('comments:imageUploadFailed'), description: e?.message ?? t('common:pleaseTryAgain') });
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
      showError({ title: t('comments:failedToPost'), description: e?.message ?? t('common:pleaseTryAgain') });
    }
  };

  return (
    <View style={styles.bottomBar}>
      <View style={feedColumn.root}>
        {suggestions.length > 0 ? (
          <View style={[styles.suggestions, { backgroundColor: tokens.surface, borderTopColor: tokens.border }]}>
            {suggestions.map((p: Participant) => (
              <Pressable key={p.id} style={styles.suggestion} onPress={() => insertMention(p)}>
                <PosterImage uri={p.avatarUrl} style={{ width: 22, height: 22, borderRadius: 11 }} />
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
            <PosterImage uri={selectedGif.previewUrl} style={{ width: 50, height: 50, borderRadius: 8 }} />
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
      </View>
      <View style={[styles.composer, { backgroundColor: tokens.surface, borderTopColor: tokens.border }]}>
        <View style={[feedColumn.root, styles.composerRow]}>
          <Pressable
            onPress={pickImage}
            disabled={imageCompressing || !!imageUri || !!selectedGif}
            hitSlop={8}
            style={{ marginRight: spacing.sm }}
            accessibilityRole="button"
            accessibilityLabel={t('comments:imageAttached')}
          >
            <Ionicons
              name={imageCompressing ? 'hourglass-outline' : 'image-outline'}
              size={24}
              color={imageUri || selectedGif ? tokens.textDim : tokens.primary}
            />
          </Pressable>
          <Pressable
            onPress={openGifPicker}
            disabled={sending || imageCompressing || !!selectedGif || !!imageUri}
            hitSlop={8}
            style={[styles.gifButton, { borderColor: selectedGif || imageUri ? tokens.border : tokens.primary }, { marginRight: spacing.sm }]}
            accessibilityRole="button"
            accessibilityLabel={t('comments:addGif')}
          >
            <T variant="micro" style={{ color: selectedGif || imageUri ? tokens.textDim : tokens.primary, fontWeight: '700' }}>
              {t('comments:gif')}
            </T>
          </Pressable>
          <TextField
            value={body}
            onChangeText={setBody}
            placeholder={placeholder ?? t('comments:addComment')}
            containerStyle={{ flex: 1, marginBottom: 0 }}
          />
          <Ionicons
            name="send"
            size={24}
            color={tokens.primary}
            onPress={send}
            style={{ marginLeft: spacing.sm, opacity: sending ? 0.5 : 1 }}
          />
        </View>
      </View>
      <GiphyPicker visible={pickerOpen} lang={giphyLang} onClose={() => setPickerOpen(false)} onSelect={onSelectGif} />
    </View>
  );
}

const styles = StyleSheet.create({
  bottomBar: {},
  suggestions: { borderTopWidth: 1, paddingHorizontal: spacing.lg },
  suggestion: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, gap: spacing.sm },
  previewBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  composer: { borderTopWidth: 1 },
  composerRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  gifButton: {
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingHorizontal: 8,
    paddingVertical: 6,
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
