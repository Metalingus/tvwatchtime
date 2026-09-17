import {
  isCommsUniPending,
  type CommsUniOperationDto,
  type CommsUniCommentDto,
} from '@tvwatch/shared';

export function commsUniOperationMessage(
  operation: Pick<CommsUniOperationDto, 'state' | 'reason'>,
  action?: string,
): string | null {
  if (operation.state === 'SYNCED')
    return action === 'report' ? 'comments:commsuni.reportSubmitted' : 'comments:commsuni.synced';
  if (operation.state === 'DUPLICATE_REPORT') return 'comments:commsuni.duplicateReport';
  if (
    ['actor_rate', 'actor_denied', 'unknown_actor_rate', 'unknown_actor_denied'].includes(
      operation.reason ?? '',
    )
  )
    return 'comments:commsuni.throttled';
  if (operation.state === 'WAITING_REVIEW') return 'comments:commsuni.awaitingReview';
  return isCommsUniPending(operation.state) ? null : 'comments:commsuni.failed';
}

/** Update confirmed viewer actions without reloading a provider snapshot that can lag writes. */
export function patchCommsUniCache(data: any, id: string, patch: Partial<CommsUniCommentDto>): any {
  if (!data) return data;
  if (Array.isArray(data.pages))
    return { ...data, pages: data.pages.map((page: any) => patchCommsUniCache(page, id, patch)) };
  if (Array.isArray(data.items))
    return {
      ...data,
      items: data.items.flatMap((item: any) => {
        if (item.kind !== 'commsuni' || item.comment.id !== id) return [item];
        const comment = { ...item.comment, ...patch };
        return comment.deleted && !comment.replyCount ? [] : [{ ...item, comment }];
      }),
    };
  if (data.comment?.id === id) return { ...data, comment: { ...data.comment, ...patch } };
  return data;
}

/** Render from the latest matching operation; an older POST response cannot overwrite it. */
export function commsUniDeliveryMessage(
  delivery: { id: string; state: string; action: string } | null,
  operation?: CommsUniOperationDto,
): string | null {
  if (!delivery) return null;
  return commsUniOperationMessage(
    operation?.id === delivery.id ? operation : { state: delivery.state },
    delivery.action,
  );
}
