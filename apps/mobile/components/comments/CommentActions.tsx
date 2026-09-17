import { useCommsUniOperation } from '../../api/commsuni';
import {
  commsUniOperationMessage,
  commsUniDeliveryMessage,
  patchCommsUniCache,
} from '../../api/commsuni-operation';
import React, { useEffect, useRef, useState } from 'react';
import { Modal, Platform, Pressable, ScrollView, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { randomUUID } from 'expo-crypto';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { CommentView } from '../../api/commsuni-presentation';
import { sharedCommentPath } from '../../api/commsuni-presentation';
import { useDeleteComment } from '../../api/hooks';
import { api } from '../../api/client';
import { T } from '../primitives';
import { useAppearance } from '../../context/PreferencesProvider';
import { spacing, radius } from '../../theme/theme';

const reasons = [
  ['SPAM', 'reportSpam'],
  ['ABUSE', 'reportAbuse'],
  ['INAPPROPRIATE', 'reportInappropriate'],
  ['OFF_TOPIC', 'reportOffTopic'],
  ['COPYRIGHT', 'reportCopyright'],
  ['OTHER', 'reportOther'],
] as const;
const ownershipReasons = [
  ['mine_hide', 'commsuni.reportMineHide'],
  ['mine_claim', 'commsuni.reportMineClaim'],
] as const;
const sharedReasons = [
  ['spam', 'reportSpam'],
  ['abuse', 'reportAbuse'],
  ['sexual', 'reportInappropriate'],
  ['other', 'reportOther'],
] as const;

export function CommentActions({
  comment,
  isOwner,
  onClose,
  onEdit,
}: {
  comment: CommentView | null;
  isOwner: boolean;
  onClose: () => void;
  onEdit: (comment: CommentView) => void;
}) {
  const { tokens } = useAppearance();
  const { t } = useTranslation(['comments', 'common']);
  const qc = useQueryClient();
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  // Match AppDialog's 400-point cap and use concrete sizes to avoid Android Yoga overflow.
  const cardWidth = Math.max(1, Math.min(width - spacing.xl * 2, 400));
  const contentHeight = Math.max(
    100,
    height - insets.top - insets.bottom - spacing.xl * 2 - spacing.lg * 2 - 48,
  );
  const deletion = useDeleteComment();
  const [visible, setVisible] = useState(!!comment);
  const [step, setStep] = useState('menu');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const pendingEdit = useRef<CommentView | null>(null);
  const inFlight = useRef(false);
  const [delivery, setDelivery] = useState<{
    id: string;
    state: string;
    action: string;
    spoiler?: boolean;
  } | null>(null);
  const operation = useCommsUniOperation(delivery?.id ?? null);
  const commentId = comment?.id;
  const remote = comment?.shared?.comment;
  const remoteId = remote?.id;
  const ownsComment = remote ? !!(remote.localCommentId || remote.actions.delete) : isOwner;
  const localCommentId = remote?.localCommentId ?? (!remote ? comment?.id : undefined);
  useEffect(() => {
    setVisible(!!commentId);
    setStep('menu');
    setMessage(null);
    setDelivery(null);
  }, [commentId]);
  useEffect(() => {
    if (!delivery || operation.data?.id !== delivery.id) return;
    if (operation.data.state === 'SYNCED' && remoteId && delivery.action !== 'report') {
      const patch =
        delivery.action === 'authorSpoiler'
          ? { isSpoiler: delivery.spoiler }
          : delivery.action === 'spoiler'
            ? { viewerMarkedSpoiler: true }
            : delivery.action === 'delete'
              ? { deleted: true, text: null, media: null, mentions: [] }
              : {};
      for (const prefix of ['conversations', 'commsuniThread'])
        qc.setQueriesData({ queryKey: [prefix] }, (data: unknown) =>
          patchCommsUniCache(data, remoteId, patch),
        );
    }
  }, [delivery, operation.data, remoteId, qc, t]);
  const finishClose = () => {
    const edit = pendingEdit.current;
    pendingEdit.current = null;
    onClose();
    if (edit) onEdit(edit);
  };
  const close = () => {
    if (inFlight.current) return;
    setVisible(false);
    // iOS must finish dismissing this native Modal before opening the editor.
    if (Platform.OS !== 'ios') finishClose();
  };
  const execute = async (
    action: 'report' | 'reportImage' | 'spoiler' | 'authorSpoiler' | 'block' | 'delete',
    reason?: string,
  ) => {
    if (!comment || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setMessage(null);
    setDelivery(null);
    try {
      let state = 'LOCAL';
      if (action === 'delete' && ownsComment && localCommentId)
        await deletion.mutateAsync(localCommentId);
      else if (comment.shared) {
        const response = await api.post<{ state: string; operationId?: string }>(
          sharedCommentPath(comment.shared, '/actions'),
          {
            action,
            actionId: randomUUID(),
            ...(reason ? { reason } : {}),
            ...(action === 'authorSpoiler' ? { isSpoiler: !comment.isSpoiler } : {}),
          },
        );
        state = response.state;
        if (response.operationId)
          setDelivery({ id: response.operationId, state, action, spoiler: !comment.isSpoiler });
      } else if (action === 'delete') await deletion.mutateAsync(comment.id);
      else if (action === 'block')
        await api.post('/users/' + encodeURIComponent(comment.author.id) + '/block');
      else if (action === 'spoiler')
        await api.post('/comments/' + encodeURIComponent(comment.id) + '/spoiler-report', {});
      else if (action === 'reportImage' && comment.image)
        await api.post('/images/' + encodeURIComponent(comment.image.id) + '/report', { reason });
      else if (action === 'report')
        await api.post('/comments/' + encodeURIComponent(comment.id) + '/report', { reason });
      const refreshes = ['comments', 'commentReplies', 'comment', 'blockedUsers'].map((prefix) =>
        qc.invalidateQueries({ queryKey: [prefix] }),
      );
      if (!comment.shared || state === 'LOCAL' || action === 'delete') {
        refreshes.push(qc.resetQueries({ queryKey: ['conversations'] }));
        refreshes.push(qc.resetQueries({ queryKey: ['commsuniThread'] }));
      }
      // The save already succeeded. Background refreshes must not hold the dialog open.
      void Promise.allSettled(refreshes);
      setStep('done');
      const messageKey = comment.shared
        ? state === 'LOCAL'
          ? 'comments:commsuni.savedLocally'
          : commsUniOperationMessage({ state }, action)
        : action === 'report' || action === 'reportImage'
          ? 'comments:reported'
          : action === 'spoiler'
            ? 'comments:spoilerReported'
            : 'comments:commsuni.savedLocally';
      setMessage(messageKey ? t(messageKey) : null);
    } catch (error: any) {
      setMessage(
        t(
          ['actor_rate', 'actor_denied'].includes(error?.data?.reason)
            ? 'comments:commsuni.throttled'
            : action === 'report' || action === 'reportImage' || action === 'spoiler'
              ? 'comments:failedToReport'
              : action === 'delete'
                ? 'comments:failedToDelete'
                : 'comments:failedToPost',
        ),
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const edit = async () => {
    if (!comment || !ownsComment || !localCommentId || inFlight.current) return;
    if (!remote) {
      pendingEdit.current = comment;
      close();
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setMessage(null);
    try {
      pendingEdit.current = await api.get<CommentView>(
        '/comments/' + encodeURIComponent(localCommentId),
      );
    } catch {
      setMessage(t('comments:failedToLoad'));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
    if (pendingEdit.current) close();
  };
  const option = (label: string, action: () => void) => (
    <Pressable
      key={label}
      onPress={action}
      disabled={busy}
      style={{
        padding: spacing.md,
        marginTop: spacing.xs,
        backgroundColor: tokens.surfaceElevated,
        borderRadius: radius.sm,
      }}
      accessibilityRole="button"
    >
      <T>{label}</T>
    </Pressable>
  );
  const deliveryMessage = commsUniDeliveryMessage(delivery, operation.data);
  const visibleMessage = delivery ? (deliveryMessage ? t(deliveryMessage) : null) : message;
  const unavailable = !comment || comment.deletedByUser;
  return (
    <Modal
      transparent
      visible={visible}
      animationType="fade"
      onDismiss={Platform.OS === 'ios' ? finishClose : undefined}
      onRequestClose={() => {
        if (busy) return;
        if (step === 'menu' || step === 'done') close();
        else setStep('menu');
      }}
    >
      <View
        style={{
          flex: 1,
          justifyContent: 'center',
          padding: spacing.xl,
          backgroundColor: tokens.overlay,
        }}
      >
        <View
          style={{
            backgroundColor: tokens.cardBackground,
            width: cardWidth,
            alignSelf: 'center',
            padding: spacing.lg,
            borderRadius: radius.lg,
          }}
        >
          <T variant="h2">{comment?.author.username}</T>
          <ScrollView style={{ maxHeight: contentHeight }}>
            {step === 'menu' && !unavailable ? (
              <>
                {ownsComment && localCommentId
                  ? option(t('comments:editComment'), () => {
                      void edit();
                    })
                  : null}
                {!ownsComment ? (
                  <>
                    {option(t('comments:reportComment'), () => setStep('report'))}
                    {option(t('comments:blockUser', { username: comment.author.username }), () =>
                      setStep('block'),
                    )}
                    {(
                      remote
                        ? remote.actions.spoiler
                        : !comment.isSpoiler && !comment.spoilerReportedByMe
                    )
                      ? option(t('comments:reportSpoiler'), () => {
                          void execute('spoiler');
                        })
                      : null}
                    {!remote && comment.image?.status === 'ready'
                      ? option(t('comments:reportImage'), () => setStep('reportImage'))
                      : null}
                  </>
                ) : null}
                {remote?.actions.authorSpoiler
                  ? option(t('comments:markAsSpoiler'), () => {
                      void execute('authorSpoiler');
                    })
                  : null}
                {(localCommentId ? ownsComment : remote?.actions.delete)
                  ? option(t('comments:deleteComment'), () => setStep('delete'))
                  : null}
              </>
            ) : null}
            {step === 'report' || step === 'reportImage' ? (
              <>
                <T variant="caption" muted>
                  {t('comments:reportSelectReason')}
                </T>
                {remote?.origin.kind === 'tvtime' ? (
                  <T variant="caption" muted>
                    {t('comments:commsuni.ownershipReportHint')}
                  </T>
                ) : null}
                {(remote
                  ? [...sharedReasons, ...(remote.origin.kind === 'tvtime' ? ownershipReasons : [])]
                  : reasons
                ).map(([reason, key]) =>
                  option(t('comments:' + key), () => {
                    void execute(step === 'reportImage' ? 'reportImage' : 'report', reason);
                  }),
                )}
              </>
            ) : null}
            {step === 'block' ? (
              <>
                <T>{t('comments:blockDesc')}</T>
                {option(t('comments:blockButton'), () => {
                  void execute('block');
                })}
              </>
            ) : null}
            {step === 'delete' ? (
              <>
                <T>{t('comments:deleteCommentDesc')}</T>
                {option(t('comments:deleteComment'), () => {
                  void execute('delete');
                })}
              </>
            ) : null}
            {visibleMessage ? (
              <T variant="caption" style={{ marginTop: spacing.md }}>
                {visibleMessage}
              </T>
            ) : null}
            {delivery && operation.isError
              ? option(t('comments:retry'), () => {
                  void operation.refetch();
                })
              : null}
            {step !== 'menu' && step !== 'done'
              ? option(t('common:back'), () => setStep('menu'))
              : null}
            {option(t('common:close'), close)}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
