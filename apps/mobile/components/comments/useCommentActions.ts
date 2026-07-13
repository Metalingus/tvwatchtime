import { useTranslation } from 'react-i18next';
import type { CommentDto } from '@tvwatch/shared';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useDeleteComment } from '../../api/hooks';
import { showDialog, showConfirm, showSuccess, showError } from '../../lib/dialog';

const REPORT_REASONS = [
  { value: 'SPAM', key: 'reportSpam' },
  { value: 'ABUSE', key: 'reportAbuse' },
  { value: 'INAPPROPRIATE', key: 'reportInappropriate' },
  { value: 'OFF_TOPIC', key: 'reportOffTopic' },
  { value: 'COPYRIGHT', key: 'reportCopyright' },
  { value: 'OTHER', key: 'reportOther' },
] as const;

export function useCommentActions(opts: { onEdit: (c: CommentDto) => void }) {
  const { t } = useTranslation(['comments', 'common']);
  const qc = useQueryClient();
  const del = useDeleteComment();

  const doReport = async (targetType: 'COMMENT' | 'IMAGE' | 'USER', targetId: string, reason: string) => {
    try {
      const endpoint =
        targetType === 'COMMENT'
          ? `/comments/${targetId}/report`
          : targetType === 'IMAGE'
            ? `/images/${targetId}/report`
            : `/users/${targetId}/report`;
      await api.post(endpoint, { reason });
      showSuccess({ title: t('comments:reported'), description: t('comments:reportedDesc') });
    } catch {
      showError({ title: t('comments:failedToReport'), description: t('common:pleaseTryAgain') });
    }
  };

  const showReportOptions = (targetType: 'COMMENT' | 'IMAGE' | 'USER', targetId: string) => {
    showDialog({
      title: t('comments:reportTitle'),
      description: t('comments:reportSelectReason'),
      buttons: [
        ...REPORT_REASONS.map((r) => ({
          label: t(`comments:${r.key}`),
          variant: 'secondary' as const,
          onPress: () => doReport(targetType, targetId, r.value),
        })),
        { label: t('common:cancel'), variant: 'ghost' as const },
      ],
    });
  };

  const confirmBlock = (comment: CommentDto) => {
    const userId = comment.author?.id;
    const username = comment.author?.username;
    if (!userId) return;
    showConfirm({
      title: t('comments:blockTitle', { username }),
      description: t('comments:blockDesc'),
      confirmLabel: t('comments:blockButton'),
      destructive: true,
      onConfirm: async () => {
        await api.post(`/users/${userId}/block`);
        qc.invalidateQueries({ queryKey: ['comments'] });
        qc.invalidateQueries({ queryKey: ['commentReplies'] });
      },
    });
  };

  const confirmDelete = (comment: CommentDto) => {
    showConfirm({
      title: t('comments:deleteCommentTitle'),
      description: t('comments:deleteCommentDesc'),
      confirmLabel: t('comments:deleteComment'),
      destructive: true,
      onConfirm: async () => {
        try {
          await del.mutateAsync(comment.id);
        } catch (e: any) {
          showError({ title: t('comments:failedToDelete'), description: e?.message ?? t('common:pleaseTryAgain') });
        }
      },
    });
  };

  const openOverflow = (comment: CommentDto, isOwner: boolean) => {
    const buttons: { label: string; variant: 'primary' | 'secondary' | 'danger' | 'ghost'; onPress?: () => void }[] = [];
    if (comment.deletedByUser) {
      buttons.push({ label: t('common:cancel'), variant: 'ghost' });
      showDialog({ title: comment.author?.username ?? t('comments:deleted'), buttons });
      return;
    }
    if (isOwner) {
      buttons.push({ label: t('comments:editComment'), variant: 'secondary', onPress: () => opts.onEdit(comment) });
      buttons.push({ label: t('comments:deleteComment'), variant: 'danger', onPress: () => confirmDelete(comment) });
    } else {
      buttons.push({ label: t('comments:reportComment'), variant: 'secondary', onPress: () => showReportOptions('COMMENT', comment.id) });
      if (comment.image?.status === 'ready') {
        buttons.push({ label: t('comments:reportImage'), variant: 'secondary', onPress: () => showReportOptions('IMAGE', comment.image!.id) });
      }
      buttons.push({
        label: t('comments:blockUser', { username: comment.author?.username }),
        variant: 'danger',
        onPress: () => confirmBlock(comment),
      });
    }
    buttons.push({ label: t('common:cancel'), variant: 'ghost' });
    showDialog({ title: comment.author?.username ?? t('comments:title'), buttons });
  };

  return { openOverflow };
}
