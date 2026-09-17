import { request } from './client';
import type { ConversationType } from '@tvwatch/shared';

type Context = { scope: string; threadType: ConversationType; threadId: string };
type Grant = { commentId: string; url: string | null };
type Waiter = {
  resolve: (value: { url: string | null }) => void;
  reject: (error: unknown) => void;
  signal: AbortSignal;
  cleanup: () => void;
};
type Group = { context: Context; entries: Map<string, Set<Waiter>>; controller: AbortController };

/** One-shot grants for the visible window. URLs never enter a shared query/disk cache. */
export class CommsUniMediaBatcher {
  private pending = new Map<string, Group>();
  constructor(
    private readonly load: (
      context: Context,
      ids: string[],
      signal: AbortSignal,
    ) => Promise<{ grants: Grant[] }>,
  ) {}
  get(context: Context, id: string, signal: AbortSignal): Promise<{ url: string | null }> {
    if (signal.aborted) return Promise.reject(new Error('Media request canceled'));
    const key = JSON.stringify(context);
    let group = this.pending.get(key);
    if (!group || (group.entries.size >= 16 && !group.entries.has(id))) {
      group = { context, entries: new Map(), controller: new AbortController() };
      this.pending.set(key, group);
      const batch = group;
      setTimeout(() => {
        void this.flush(key, batch);
      }, 10);
    }
    const batch = group;
    return new Promise((resolve, reject) => {
      const entry: Waiter = {
        resolve,
        reject,
        signal,
        cleanup: () => signal.removeEventListener('abort', cancel),
      };
      const cancel = () => {
        batch.entries.get(id)?.delete(entry);
        if (!batch.entries.get(id)?.size) batch.entries.delete(id);
        entry.cleanup();
        reject(new Error('Media request canceled'));
        if (!batch.entries.size) {
          batch.controller.abort();
          if (this.pending.get(key) === batch) this.pending.delete(key);
        }
      };
      const entries = batch.entries.get(id) ?? new Set<Waiter>();
      entries.add(entry);
      batch.entries.set(id, entries);
      signal.addEventListener('abort', cancel, { once: true });
    });
  }
  private async flush(key: string, batch: Group) {
    if (this.pending.get(key) === batch) this.pending.delete(key);
    if (!batch.entries.size) return;
    try {
      const response = await this.load(
        batch.context,
        [...batch.entries.keys()],
        batch.controller.signal,
      );
      const grants = new Map(response.grants.map((grant) => [grant.commentId, grant.url]));
      for (const [id, waiters] of batch.entries)
        for (const waiter of waiters) {
          waiter.cleanup();
          if (!waiter.signal.aborted) waiter.resolve({ url: grants.get(id) ?? null });
        }
    } catch (error) {
      for (const waiters of batch.entries.values())
        for (const waiter of waiters) {
          waiter.cleanup();
          if (!waiter.signal.aborted) waiter.reject(error);
        }
    }
  }
}

const batches = new CommsUniMediaBatcher((context, commentIds, signal) =>
  request<{ grants: Grant[] }>('/conversations/media-grants', {
    method: 'POST',
    body: { commentIds },
    query: { threadType: context.threadType, threadId: context.threadId },
    signal,
  }),
);
export const requestCommsUniMedia = (context: Context, id: string, signal: AbortSignal) =>
  batches.get(context, id, signal);
