import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { WatchForgeLane } from './watchforge-budget.service';

export type WatchForgeLedgerOutcome = 'found' | 'unmapped' | 'ambiguous' | 'invalid';

/**
 * How long an outcome stops us from paying for the same identifier again. `found` is kept for
 * accounting only: the identity payload lives in the 24h Redis cache and verified results are
 * persisted as external-id bindings, so a found record never replaces a lookup.
 */
export const WATCHFORGE_LEDGER_TTL_MS: Record<WatchForgeLedgerOutcome, number> = {
  found: 86_400_000,
  unmapped: 30 * 86_400_000,
  ambiguous: 7 * 86_400_000,
  invalid: 86_400_000,
};

export interface WatchForgeLedgerKey {
  provider: string;
  mediaType: string;
  id: string;
}

/** Durable per-identifier outcomes; failures here must never break a lookup. */
@Injectable()
export class WatchForgeLedger {
  private readonly logger = new Logger(WatchForgeLedger.name);

  constructor(private readonly prisma: PrismaService) {}

  async recall(
    key: WatchForgeLedgerKey,
    now = Date.now(),
  ): Promise<{ outcome: WatchForgeLedgerOutcome; expiresAt: Date; wfId: string | null } | null> {
    try {
      const row = await this.prisma.watchForgeLookup.findUnique({
        where: {
          provider_mediaType_externalId: {
            provider: key.provider,
            mediaType: key.mediaType,
            externalId: key.id,
          },
        },
        select: { outcome: true, expiresAt: true, wfId: true },
      });
      if (!row || row.expiresAt.getTime() <= now) return null;
      return {
        outcome: row.outcome as WatchForgeLedgerOutcome,
        expiresAt: row.expiresAt,
        wfId: row.wfId,
      };
    } catch (error) {
      this.logger.warn(`WatchForge ledger read failed: ${(error as Error).message}`);
      return null;
    }
  }

  async record(
    key: WatchForgeLedgerKey,
    outcome: WatchForgeLedgerOutcome,
    lane: WatchForgeLane,
    wfId: string | null = null,
    now = Date.now(),
  ): Promise<void> {
    const data = {
      outcome,
      wfId,
      lane,
      checkedAt: new Date(now),
      expiresAt: new Date(now + WATCHFORGE_LEDGER_TTL_MS[outcome]),
    };
    try {
      await this.prisma.watchForgeLookup.upsert({
        where: {
          provider_mediaType_externalId: {
            provider: key.provider,
            mediaType: key.mediaType,
            externalId: key.id,
          },
        },
        create: { provider: key.provider, mediaType: key.mediaType, externalId: key.id, ...data },
        update: data,
      });
    } catch (error) {
      this.logger.warn(`WatchForge ledger write failed: ${(error as Error).message}`);
    }
  }
}
