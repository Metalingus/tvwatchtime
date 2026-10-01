import { Injectable, Logger } from '@nestjs/common';
import { HydrationJobType } from '@prisma/client';
import { STREAMING_TOP_SERVICES, type StreamingTopService } from '@tvwatch/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  MotnClient,
  MOTN_CHART_COUNTRIES,
  type MotnQuota,
} from '../media-metadata/providers/motn.client';
import {
  StreamingChartsService,
  streamingTopRailKey,
} from '../media-metadata/streaming-charts/streaming-charts.service';
import { AdminService } from './admin.service';
import { projectedMonthlyCalls, type StreamingChartsConfig } from './streaming-charts.config';

function daysInUtcMonth(now: Date): number {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
}

/**
 * Daily streaming top charts: one paid Movie of the Night call per (service, country), each
 * stored as a ranked `streaming_top` rail snapshot through the shared hydration processor.
 */
@Injectable()
export class StreamingChartsRunner {
  private readonly logger = new Logger(StreamingChartsRunner.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly admin: AdminService,
    private readonly charts: StreamingChartsService,
    private readonly motn: MotnClient,
  ) {}

  /** True while a run is in progress in this process ("Run Now" and the schedule share it). */
  get running(): boolean {
    return this.active;
  }
  private active = false;

  async run(config: StreamingChartsConfig, previous: Record<string, unknown> | null = null) {
    if (this.active) return { skipped: 1, alreadyRunning: 1 };
    this.active = true;
    try {
      return await this.runOnce(config, previous);
    } finally {
      this.active = false;
    }
  }

  private async runOnce(config: StreamingChartsConfig, previous: Record<string, unknown> | null) {
    if (!(await this.motn.configured())) return { skipped: 1, notConfigured: 1 };
    const now = new Date();
    const countries = config.countries.filter((c) =>
      (MOTN_CHART_COUNTRIES as readonly string[]).includes(c),
    );
    const services = config.services.filter((s): s is StreamingTopService =>
      (STREAMING_TOP_SERVICES as readonly string[]).includes(s),
    );
    const projected = projectedMonthlyCalls({ countries, services }, daysInUtcMonth(now));
    const usable = config.monthlyBudget - config.reserve;
    if (projected > usable) {
      throw new Error(
        `Projected ${projected} calls this month exceed the ${usable}-call budget; reduce countries or services`,
      );
    }
    const warning =
      projected > usable * 0.8 ? `projected ${projected}/${usable} calls this month` : '';

    const rails = countries.flatMap((country) =>
      services.map((service) => ({
        country,
        service,
        railKey: streamingTopRailKey(service, country),
      })),
    );
    const todayStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const doneToday = new Set(
      (
        await this.prisma.hydrationJob.findMany({
          where: {
            type: HydrationJobType.streaming_top,
            railKey: { in: rails.map((rail) => rail.railKey) },
            status: 'completed',
            createdAt: { gte: todayStart },
          },
          select: { railKey: true },
        })
      ).map((job) => job.railKey),
    );

    const counters = {
      railsFetched: 0,
      railsAlreadyToday: 0,
      railsFailed: 0,
      railsQuotaStopped: 0,
      itemsExisting: 0,
      itemsNew: 0,
      itemsSkipped: 0,
      itemsConflict: 0,
      itemsDuplicateRows: 0,
      itemsHydrated: 0,
      itemsDropped: 0,
      itemsNotSubscription: 0,
    };
    const failures: string[] = [];
    let lastJobId: string | null = null;
    for (const rail of rails) {
      if (doneToday.has(rail.railKey)) {
        counters.railsAlreadyToday++;
        continue;
      }
      const quota = await this.knownQuota(previous, now);
      if (quota && quota.granted - quota.used - config.reserve <= 0) {
        counters.railsQuotaStopped++;
        continue;
      }
      try {
        const collected = await this.charts.collect(rail.country, rail.service, {
          watchforge: config.watchforge,
        });
        counters.railsFetched++;
        counters.itemsExisting += collected.existing;
        counters.itemsNew += collected.created;
        counters.itemsSkipped += collected.skipped;
        counters.itemsConflict += collected.conflicts;
        counters.itemsDuplicateRows += collected.duplicates;
        counters.itemsDropped += collected.dropped;
        counters.itemsNotSubscription += collected.filtered;
        const outcome = await this.admin.runRankedSnapshot({
          type: 'streaming_top',
          railKey: rail.railKey,
          triggeredBy: 'system',
          provider: 'MOTN',
          items: collected.items,
        });
        lastJobId = outcome.jobId;
        counters.itemsHydrated += outcome.hydrated;
        if (outcome.status !== 'completed') {
          counters.railsFailed++;
          failures.push(`${rail.railKey}: snapshot ${outcome.status}`);
        }
      } catch (error) {
        counters.railsFailed++;
        failures.push(`${rail.railKey}: ${(error as Error).message}`.slice(0, 200));
        this.logger.warn(`Streaming chart ${rail.railKey} failed: ${(error as Error).message}`);
      }
    }

    const pruned = await this.prune(config.retentionDays, now);
    await this.charts.invalidateAvailability();
    const quota = await this.knownQuota(previous, now);
    return {
      ...counters,
      lastJobId,
      pruned,
      projectedMonthlyCalls: projected,
      quotaUsed: quota?.used ?? null,
      quotaGranted: quota?.granted ?? null,
      quotaRemaining: quota ? Math.max(0, quota.granted - quota.used) : null,
      quotaResetAt: quota?.resetAt ?? null,
      warning,
      ...(failures.length ? { failedSteps: failures.join('; ').slice(0, 900) } : {}),
    };
  }

  /** Observed quota (Redis), else the last run's report while its reset is still ahead. */
  private async knownQuota(
    previous: Record<string, unknown> | null,
    now: Date,
  ): Promise<Pick<MotnQuota, 'used' | 'granted' | 'resetAt'> | null> {
    const live = await this.motn.quota();
    if (live) return live;
    const used = Number(previous?.quotaUsed);
    const granted = Number(previous?.quotaGranted);
    const resetAt = typeof previous?.quotaResetAt === 'string' ? previous.quotaResetAt : null;
    if (!Number.isFinite(used) || !Number.isFinite(granted) || !resetAt) return null;
    return Date.parse(resetAt) > now.getTime() ? { used, granted, resetAt } : null;
  }

  /** Drop old chart snapshots, always keeping the newest completed one per rail. */
  private async prune(retentionDays: number, now: Date): Promise<number> {
    const latest = await this.prisma.hydrationJob.findMany({
      where: { type: HydrationJobType.streaming_top, status: 'completed' },
      orderBy: { completedAt: 'desc' },
      distinct: ['railKey'],
      select: { id: true },
    });
    const { count } = await this.prisma.hydrationJob.deleteMany({
      where: {
        type: HydrationJobType.streaming_top,
        createdAt: { lt: new Date(now.getTime() - retentionDays * 86400 * 1000) },
        id: { notIn: latest.map((job) => job.id) },
        status: { notIn: ['running', 'queued'] },
      },
    });
    return count;
  }
}
