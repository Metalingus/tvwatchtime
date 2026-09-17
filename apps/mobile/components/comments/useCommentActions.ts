import { useState } from 'react';
import type { CommentView } from '../../api/commsuni-presentation';

/** One selection/controller for local, imported and provider comment actions. */
export function useCommentActions(opts: { onEdit: (comment: CommentView) => void }) {
  const [selected, setSelected] = useState<{ comment: CommentView; isOwner: boolean } | null>(null);
  return {
    openOverflow: (comment: CommentView, isOwner: boolean) => setSelected({ comment, isOwner }),
    dialog: {
      comment: selected?.comment ?? null,
      isOwner: selected?.isOwner ?? false,
      onClose: () => setSelected(null),
      onEdit: opts.onEdit,
    },
  };
}
