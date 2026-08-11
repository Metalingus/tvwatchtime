import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Queue, Worker } from 'bullmq';
import { RedisService } from '../common/redis/redis.service';

/** Monotonic global mutation generation used to protect cold leaderboard initialization. */
export const LB_VERSION_KEY = 'lb:v2:version';
/** A user's requested and successfully-computed generations. */
export const leaderboardUserVersionKey = (userId: string) => `lb:v2:user:${userId}:version`;
export const leaderboardUserComputedVersionKey = (userId: string) =>
  `lb:v2:user:${userId}:computed-version`;
/** Users whose sorted-set scores have not caught up with their latest mutation. */
export const LB_DIRTY_USERS_KEY = 'lb:v2:dirty-users';
/** BullMQ queue for debounced, user-scoped score refreshes. */
const LB_REFRESH_QUEUE = 'lb-user-refresh';
const LB_REFRESH_JOB_PREFIX = 'lb-user-refresh';

export type LeaderboardUserRefresh = { userId: string };

/**
 * Coalesces watch/import activity into user-scoped leaderboard refreshes.
 *
 * A mutation never deletes a global cache and never scans another user's history. Repeated
 * mutations for the same user move one delayed BullMQ job to the end of the debounce window. If a
 * mutation lands while that job is already active, one separate trailing job is retained.
 */
@Injectable()
export class LeaderboardBustProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LeaderboardBustProcessor.name);
  private queue!: Queue<LeaderboardUserRefresh>;
  private worker!: Worker<LeaderboardUserRefresh>;
  private readonly delayMs = Math.max(
    250,
    Number(process.env.LEADERBOARD_USER_REFRESH_DELAY_MS) || 2_000,
  );

  constructor(
    private readonly redis: RedisService,
    private readonly events: EventEmitter2,
  ) {}

  onModuleInit() {
    const connection = this.redis.client as any;
    this.queue = new Queue<LeaderboardUserRefresh>(LB_REFRESH_QUEUE, { connection });
    this.worker = new Worker<LeaderboardUserRefresh>(
      LB_REFRESH_QUEUE,
      async (job) => {
        await this.events.emitAsync('leaderboard.refresh-user', { userId: job.data.userId });
      },
      { connection, concurrency: 4 },
    );
    this.worker.on('failed', (job, error) =>
      this.logger.error(
        `leaderboard user refresh ${job?.data.userId ?? 'unknown'} failed: ${error.message}`,
      ),
    );
  }

  async onModuleDestroy() {
    await Promise.all([this.worker?.close(), this.queue?.close()]);
  }

  /** Mark one user dirty and debounce an authoritative score refresh. */
  async request(userId: string): Promise<void> {
    if (!userId) return;
    await this.redis.client
      .multi()
      .incr(LB_VERSION_KEY)
      .incr(leaderboardUserVersionKey(userId))
      .sadd(LB_DIRTY_USERS_KEY, userId)
      .exec();
    await this.schedule(userId, false);
  }

  /** Queue work without changing generations (used only to recover already-dirty users). */
  async scheduleExisting(userId: string): Promise<void> {
    if (!userId) return;
    await this.schedule(userId, false);
  }

  private async schedule(userId: string, trailing: boolean): Promise<void> {
    const baseId = `${LB_REFRESH_JOB_PREFIX}-${userId}`;
    const jobId = trailing ? `${baseId}-trailing` : baseId;
    const existing = await this.queue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state === 'delayed') {
        await existing.changeDelay(this.delayMs);
        return;
      }
      if (state === 'waiting' || state === 'waiting-children') return;
      if (state === 'active' && !trailing) {
        await this.schedule(userId, true);
        return;
      }
      if (state !== 'completed' && state !== 'failed') return;
      await existing.remove().catch(() => undefined);
    }
    await this.queue.add(
      'refresh-user',
      { userId },
      {
        jobId,
        delay: this.delayMs,
        removeOnComplete: true,
        removeOnFail: true,
        attempts: 3,
        backoff: { type: 'exponential', delay: 2_000 },
      },
    );
  }
}
