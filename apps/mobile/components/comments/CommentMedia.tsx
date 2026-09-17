import React, { useEffect, useMemo, useReducer, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import type { CommentImageDto, CommsUniCommentDto, ConversationType } from '@tvwatch/shared';
import { requestCommsUniMedia } from '../../api/commsuni-media';
import { useCommsUniScope } from '../../api/commsuni';
import type { CommentView } from '../../api/commsuni-presentation';
import { useAppearance } from '../../context/PreferencesProvider';
import { radius, spacing } from '../../theme/theme';
import { T } from '../primitives';
import { MediaViewer } from './MediaViewer';
import { mediaAspectRatio, commentMediaLayouts } from './media-layout';
import {
  COMMENT_MEDIA_TIMEOUT_MS,
  initialMediaLoadState,
  mediaLoadReducer,
  mediaRequestRetry,
} from './media-load-state';

/** Only real pending/loaded attachments reserve their media proportions. */
export function CommentMediaFrame({
  aspectRatio,
  failed,
  loading,
  ready,
  onOpen,
  onRetry,
  children,
}: {
  aspectRatio: number;
  failed: boolean;
  loading: boolean;
  ready: boolean;
  onOpen: () => void;
  onRetry: () => void;
  children?: React.ReactNode;
}) {
  const { tokens } = useAppearance();
  const { t } = useTranslation('comments');
  if (failed)
    return (
      <View
        testID="comment-media-unavailable"
        style={{
          marginTop: spacing.sm,
          padding: spacing.sm,
          borderRadius: radius.md,
          backgroundColor: tokens.surfaceElevated,
          flexDirection: 'row',
          alignItems: 'center',
        }}
      >
        <Ionicons name="image-outline" size={spacing.lg} color={tokens.textMuted} />
        <T variant="micro" muted style={{ flex: 1, marginHorizontal: spacing.sm }}>
          {t('comments:imageUnavailable')}
        </T>
        <Pressable
          onPress={(event) => {
            event.stopPropagation();
            onRetry();
          }}
          accessibilityRole="button"
          accessibilityLabel={t('comments:retry')}
          hitSlop={spacing.xs}
          style={{ padding: spacing.xs }}
        >
          <T variant="micro" style={{ color: tokens.info }}>
            {t('comments:retry')}
          </T>
        </Pressable>
      </View>
    );
  return (
    <Pressable
      testID="comment-media-frame"
      onPress={(event) => {
        event.stopPropagation();
        onOpen();
      }}
      disabled={!ready}
      accessibilityRole="button"
      accessibilityLabel={t('comments:imageAttached')}
      style={{
        width: '100%',
        aspectRatio,
        marginTop: spacing.sm,
        borderRadius: radius.md,
        overflow: 'hidden',
        backgroundColor: tokens.surfaceElevated,
      }}
    >
      {children}
      {loading ? (
        <View
          style={[
            StyleSheet.absoluteFill,
            {
              pointerEvents: 'none',
              alignItems: 'center',
              justifyContent: 'center',
            },
          ]}
        >
          <ActivityIndicator color={tokens.primary} />
        </View>
      ) : null}
    </Pressable>
  );
}

/** Parent keys this component by backend/user/thread/comment/media identity. */
export function CommentMediaAsset({
  media,
  mediaKey,
  threadType,
  threadId,
  commentId,
  visible,
  scopeReady,
  grantScope,
}: {
  media: NonNullable<CommsUniCommentDto['media']>;
  mediaKey: string;
  threadType: ConversationType;
  threadId: string;
  commentId: string;
  visible: boolean;
  scopeReady: boolean;
  grantScope?: string;
}) {
  const [state, dispatch] = useReducer(mediaLoadReducer, initialMediaLoadState);
  const [fullImage, setFullImage] = useState(false);
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const archive = media.kind === 'archive';
  // Signed links belong to this mounted attempt only, never the shared query cache.
  const [grant, setGrant] = useState<{ attempt: number; url: string } | null>(null);
  const imageUrl = archive ? (grant?.attempt === state.attempt ? grant.url : undefined) : media.url;
  const imageSource = useMemo(
    () => (imageUrl ? { uri: imageUrl, cacheKey: mediaKey } : undefined),
    [imageUrl, mediaKey],
  );
  useEffect(() => {
    if (visible && scopeReady) dispatch({ type: 'start', archive });
  }, [visible, scopeReady, archive]);
  useEffect(() => {
    if (state.phase !== 'refreshing' || !archive || !scopeReady) return;
    const controller = new AbortController();
    let current = true;
    const attempt = state.attempt;
    void requestCommsUniMedia(
      { scope: grantScope ?? '', threadType, threadId },
      commentId,
      controller.signal,
    ).then(
      (result) => {
        if (!current) return;
        if (!result.url) {
          dispatch({ type: 'failed', attempt });
          return;
        }
        setGrant({ attempt, url: result.url });
        dispatch({ type: 'refresh-ready', attempt });
      },
      (error: unknown) => {
        if (current) dispatch({ type: 'request-error', attempt, ...mediaRequestRetry(error) });
      },
    );
    return () => {
      current = false;
      controller.abort();
    };
  }, [
    state.phase,
    state.attempt,
    archive,
    scopeReady,
    commentId,
    threadType,
    threadId,
    grantScope,
  ]);
  useEffect(() => {
    if (state.phase !== 'retrying') return;
    // Bounded recovery after a user-triggered load; no periodic polling.
    const timer = setTimeout(
      () => dispatch({ type: 'retry-ready', archive, attempt: state.attempt }),
      state.retryDelayMs + Math.floor(Math.random() * 250),
    );
    return () => clearTimeout(timer);
  }, [state.phase, state.attempt, state.retryDelayMs, archive]);
  useEffect(() => {
    if (state.phase === 'loading' && !archive && !imageUrl)
      dispatch({ type: 'failed', attempt: state.attempt });
  }, [state.phase, state.attempt, archive, imageUrl]);
  useEffect(() => {
    if (state.phase !== 'loading' && state.phase !== 'refreshing') return;
    const timer = setTimeout(
      () => dispatch({ type: 'timeout', attempt: state.attempt }),
      COMMENT_MEDIA_TIMEOUT_MS,
    );
    return () => clearTimeout(timer);
  }, [state.phase, state.attempt]);

  const size = naturalSize ?? commentMediaLayouts.get(mediaKey);
  const aspectRatio =
    mediaAspectRatio(size?.width, size?.height) ??
    mediaAspectRatio(media.width, media.height) ??
    16 / 9;
  const ready = state.phase === 'loaded';
  const renderKey = mediaKey + ':' + state.attempt;
  return (
    <>
      <CommentMediaFrame
        aspectRatio={aspectRatio}
        failed={state.phase === 'failed'}
        loading={
          state.phase === 'loading' || state.phase === 'refreshing' || state.phase === 'retrying'
        }
        ready={ready}
        onOpen={() => setFullImage(true)}
        onRetry={() => dispatch({ type: 'retry', archive })}
      >
        {(state.phase === 'loading' || ready) && imageSource ? (
          <Image
            key={renderKey}
            source={imageSource}
            // Once measured, the frame has this exact aspect ratio: fill its rounded bounds
            // instead of leaving a square-edged image inset inside the rounded frame.
            contentFit={size ? 'cover' : 'contain'}
            cachePolicy="memory-disk"
            recyclingKey={renderKey}
            loading="eager"
            transition={0}
            style={{ width: '100%', height: '100%', borderRadius: radius.md, overflow: 'hidden' }}
            onLoad={(event) => {
              const { width, height } = event.source;
              if (mediaAspectRatio(width, height) === undefined) {
                setFullImage(false);
                dispatch({ type: 'image-error', attempt: state.attempt });
                return;
              }
              commentMediaLayouts.set(mediaKey, width, height);
              setNaturalSize((previous) =>
                previous?.width === width && previous.height === height
                  ? previous
                  : { width, height },
              );
              dispatch({ type: 'loaded', attempt: state.attempt });
            }}
            onError={() => {
              setFullImage(false);
              dispatch({ type: 'image-error', attempt: state.attempt });
            }}
          />
        ) : null}
      </CommentMediaFrame>
      {ready && imageUrl ? (
        <MediaViewer visible={fullImage} source={imageSource} onClose={() => setFullImage(false)} />
      ) : null}
    </>
  );
}

/** Shared renderer; only archive media needs a provider grant. */
export function CommentMedia({
  image,
  gifUrl,
  shared,
  visible = true,
}: {
  image?: CommentImageDto | null;
  gifUrl?: string | null;
  shared?: CommentView['shared'];
  visible?: boolean;
}) {
  const scope = useCommsUniScope();
  const { tokens } = useAppearance();
  const { t } = useTranslation('common');
  if (!shared && image && !['ready', 'rejected', 'deleted'].includes(image.status))
    return (
      <View
        style={{
          padding: spacing.xl,
          marginTop: spacing.sm,
          alignItems: 'center',
          borderRadius: radius.md,
          backgroundColor: tokens.surfaceElevated,
        }}
      >
        <ActivityIndicator color={tokens.primary} />
        <T variant="micro" muted>
          {t('common:processing')}
        </T>
      </View>
    );
  const media: CommsUniCommentDto['media'] = shared
    ? shared.comment.media
    : image?.status === 'ready'
      ? {
          kind: 'external',
          url: scope.key[0]
            ? scope.key[0].replace(/\/+$/, '') + '/comment-images/' + encodeURIComponent(image.id)
            : undefined,
          width: image.width ?? undefined,
          height: image.height ?? undefined,
        }
      : gifUrl
        ? { kind: 'external', url: gifUrl, contentType: 'image/gif' }
        : null;
  if (!media) return null;
  const mediaKey = JSON.stringify([
    ...scope.key,
    shared?.threadType,
    shared?.threadId,
    shared?.comment.id ?? image?.id,
    media.kind,
    media.kind === 'external' ? media.url : null,
  ]);
  return (
    <CommentMediaAsset
      key={mediaKey}
      media={media}
      mediaKey={mediaKey}
      threadType={shared?.threadType ?? 'MOVIE'}
      threadId={shared?.threadId ?? ''}
      commentId={shared?.comment.id ?? ''}
      visible={visible}
      scopeReady={shared ? scope.ready : !!scope.key[0]}
      grantScope={JSON.stringify(scope.key)}
    />
  );
}
