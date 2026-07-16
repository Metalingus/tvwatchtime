import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { randomUUID } from 'crypto';
import { RedisService } from '../common/redis/redis.service';

/** Redis key for the leading-edge floor gate; value = the floor generation (a randomUUID). */
const LB_BUST_FLOOR_KEY = 'lb:bust-floor';
/** BullMQ queue name for coalesced trailing leaderboard busts. */
const LB_BUST_QUEUE = 'lb-bust';
/** Prefix for trailing-bust BullMQ job IDs (must not contain ':'); suffixed with the generation. */
const LB_TRAILING_JOB_PREFIX = 'lb-trailing-bust';
/** Leaderboard cache keys that get deleted on a bust. */
const LB_TYPES = ['combined', 'shows', 'movies'] as const;

/**
 * Coalesced leaderboard cache invalidation after watch activity.
 *
 * Per burst of watch/unwatch/rewatch events:
 *  - at most ONE immediate cache deletion (leading edge), and
 *  - at most ONE trailing cache deletion, scoped to the floor generation that owns the gate.
 *
 * The trailing job is delayed by the REMAINING TTL of the current floor (not a fresh full floor),
 * and a stale trailing job whose generation no longer owns the gate is skipped. This makes
 * inside-the-floor activity visible shortly after the floor ends without hammering the DB.
 *
 * NOTE: this bounds cache DELETIONS, not leaderboard COMPUTATIONS. `getRankedLeaderboard` has no
 * single-flight guard, so concurrent cache misses may each recompute (accepted risk).
 */
@Injectable()
export class LeaderboardBustProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LeaderboardBustProcessor.name);
  private queue!: Queue;
  private worker!: Worker;
  private readonly floorSec = Number(process.env.LEADERBOARD_BUST_FLOOR_SEC) || 45;

  constructor(private readonly redis: RedisService) {}

  onModuleInit() {
    // Reuse the shared ioredis client (built with maxRetriesPerRequest:null — BullMQ-compatible),
    // the same pattern used by import.processor.ts / comment-image.processor.ts.
    const connection = this.redis.client as any;
    this.queue = new Queue(LB_BUST_QUEUE, { connection });
    this.worker = new Worker(
      LB_BUST_QUEUE,
      async (job) => {
        const gen = (job.data as any)?.gen as string | undefined;
        const cur = await this.redis.client.get(LB_BUST_FLOOR_KEY);
        // A newer generation owns the gate → this stale trailing job is a no-op.
        if (cur && gen && cur !== gen) return;
        await this.bust();
      },
      { connection, concurrency: 1 },
    );
    this.worker.on('failed', (_j, e) => this.logger.error(`lb-bust job failed: ${e.message}`));
  }

  async onModuleDestroy() {
    // Close only BullMQ-owned resources; never the shared redis.client (owned by RedisService).
    await Promise.all([this.worker?.close(), this.queue?.close()]);
  }

  /** Called on each watch/unwatch/rewatch event. */
  async request(): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const generation = randomUUID();
      const got = await this.redis.client.set(LB_BUST_FLOOR_KEY, generation, 'EX', this.floorSec, 'NX');
      if (got === 'OK') {
        // First watch of the burst → immediate bust.
        await this.bust();
        return;
      }
      const [ownerGeneration, ttlMs] = await Promise.all([
        this.redis.client.get(LB_BUST_FLOOR_KEY),
        this.redis.client.pttl(LB_BUST_FLOOR_KEY),
      ]);
      if (ownerGeneration && ttlMs > 0) {
        // A valid floor still owns the gate → one coalesced trailing bust at its end.
        await this.scheduleTrailing(ownerGeneration, ttlMs);
        return;
      }
      // The floor expired between the failed acquisition and inspection → retry acquisition once.
    }
    // After 2 attempts the gate keeps eliding (extreme contention/expiry). The floor is gone, so
    // there is no owner to defer to: bust now rather than scheduling an arbitrary full-floor delay
    // that could outlive the activity and still miss the window.
    await this.bust();
  }

  private async scheduleTrailing(ownerGeneration: string, ttlMs: number): Promise<void> {
    await this.queue.add(
      'trailing',
      { gen: ownerGeneration },
      {
        // Valid BullMQ job ID (no ':'); dedupes per generation while delayed/active.
        jobId: `${LB_TRAILING_JOB_PREFIX}-${ownerGeneration}`,
        delay: ttlMs,
        removeOnComplete: true,
        removeOnFail: true,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      },
    );
  }

  private async bust(): Promise<void> {
    await Promise.all(LB_TYPES.map((t) => this.redis.del(`lb:${t}`)));
  }
}
