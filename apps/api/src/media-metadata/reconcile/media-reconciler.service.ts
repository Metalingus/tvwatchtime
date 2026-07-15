import { Injectable, Logger } from '@nestjs/common';
import { ExternalProvider, ProviderEntityKind } from '@tvwatch/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ProviderRateLimiter } from '../../media-metadata/providers/shared/rate-limiter';
import { createHash } from 'crypto';

export interface IdentityRef {
  provider: ExternalProvider;
  providerEntityKind: ProviderEntityKind;
  value: string;
}

export interface ReconcileOutcome {
  mediaId: string | null;
  created: boolean;
  /** When cross-provider evidence is insufficient, no merge happens and this is set. */
  needsReview?: boolean;
  attached?: IdentityRef[];
}

/**
 * Single shared identity-resolution + reconciliation path used by import, search
 * background hydration, promotion, admin rehydration and provider refresh.
 *
 * - `findByExternals` / `getOrCreateByIdentity` guarantee exactly-one local record per
 *   namespace-aware identity (deterministic lock + in-transaction recheck).
 * - `getOrCreateByIdentity` guarantees uniqueness FOR THE SAME identity only; cross-provider
 *   duplicates (e.g. a TMDB id and a TVDB id of the same work whose relationship is unknown)
 *   require explicit `crossProviderReconcile` with sufficient evidence.
 */
@Injectable()
export class MediaReconciler {
  private readonly logger = new Logger(MediaReconciler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly rateLimiter: ProviderRateLimiter,
  ) {}

  /** Find an existing media row by any verified namespace-aware external id. */
  async findByExternals(externals: IdentityRef[]): Promise<{ id: string; title: string; type: string } | null> {
    for (const e of externals) {
      const ext = await this.prisma.externalId.findFirst({
        where: { provider: e.provider, providerEntityKind: e.providerEntityKind, value: e.value },
        include: { media: { select: { id: true, title: true, type: true } } },
      });
      if (ext?.media) return ext.media;
    }
    return null;
  }

  /** Deterministic lock key for one namespace-aware identity. */
  static identityLockKey(identity: IdentityRef): string {
    return `identity:${identity.provider}:${identity.providerEntityKind}:${identity.value}`;
  }

  /**
   * Get-or-create a local media row for one identity. `creator` performs the provider fetch
   * + lightUpsert (which attaches the external id) and returns the mediaId. Concurrent
   * promoters for the SAME identity collapse to one creation via a distinct lock + recheck.
   */
  async getOrCreateByIdentity(identity: IdentityRef, creator: () => Promise<string>): Promise<string | null> {
    const existing = await this.findByExternals([identity]);
    if (existing) return existing.id;

    const res = await this.rateLimiter.distinctLock(MediaReconciler.identityLockKey(identity), 30_000, async () => {
      const again = await this.findByExternals([identity]);
      if (again) return again.id;
      return creator();
    });
    if (res) return res;
    // Lost the single-flight race — re-read what the winner created.
    const after = await this.findByExternals([identity]);
    return after?.id ?? null;
  }

  /** Attach a newly-discovered verified identity to an existing record (no new row). */
  async attachExternalId(mediaId: string, identity: IdentityRef): Promise<void> {
    await this.prisma.externalId.upsert({
      where: { provider_providerEntityKind_value: { provider: identity.provider, providerEntityKind: identity.providerEntityKind, value: identity.value } },
      create: { mediaId, provider: identity.provider, providerEntityKind: identity.providerEntityKind, value: identity.value },
      update: {},
    });
  }

  /**
   * Deterministic cross-provider reconciliation lock derived from the sorted candidate
   * identities, so two concurrent requests comparing the same identity pair use the same key.
   */
  static reconcileLockKey(identities: IdentityRef[]): string {
    const sorted = identities
      .map((i) => `${i.provider}:${i.providerEntityKind}:${i.value}`)
      .sort()
      .join('|');
    return `RECONCILE:${createHash('sha1').update(sorted).digest('hex')}`;
  }

  /**
   * Reconcile several identities that may represent the same work. If any already maps to a
   * local record, that record wins and the remaining identities are attached to it. If none
   * maps and confidence is high enough, the caller's `creator` builds one record and all
   * identities attach to it. If confidence is insufficient, no automatic merge happens and
   * the outcome is flagged for review (identities stay separate).
   */
  async crossProviderReconcile(
    identities: IdentityRef[],
    opts: { confidence: number; threshold?: number; creator?: () => Promise<string | null> },
  ): Promise<ReconcileOutcome> {
    const threshold = opts.threshold ?? 0.7;
    const lockKey = MediaReconciler.reconcileLockKey(identities);
    return this.rateLimiter.distinctLock(lockKey, 30_000, async () => {
      return this.prisma
        .$transaction(async (tx) => {
          // Resolve any existing record among the identities.
          let winner: { id: string } | null = null;
          const attached: IdentityRef[] = [];
          for (const e of identities) {
            const ext = await tx.externalId.findFirst({
              where: { provider: e.provider, providerEntityKind: e.providerEntityKind, value: e.value },
              include: { media: { select: { id: true } } },
            });
            if (ext?.media) {
              winner = { id: ext.media.id };
              break;
            }
          }
          if (winner) {
            // Attach any missing identities to the winning record.
            for (const e of identities) {
              const has = await tx.externalId.findFirst({
                where: { provider: e.provider, providerEntityKind: e.providerEntityKind, value: e.value },
              });
              if (!has) {
                await tx.externalId.create({
                  data: { mediaId: winner.id, provider: e.provider, providerEntityKind: e.providerEntityKind, value: e.value },
                });
                attached.push(e);
              }
            }
            return { mediaId: winner.id, created: false, attached } satisfies ReconcileOutcome;
          }
          // No existing record. Only create one when evidence is sufficient.
          if (opts.confidence >= threshold && opts.creator) {
            const created = await opts.creator();
            if (created) {
              for (const e of identities) {
                await tx.externalId.upsert({
                  where: { provider_providerEntityKind_value: { provider: e.provider, providerEntityKind: e.providerEntityKind, value: e.value } },
                  create: { mediaId: created, provider: e.provider, providerEntityKind: e.providerEntityKind, value: e.value },
                  update: {},
                });
              }
              return { mediaId: created, created: true, attached: identities } satisfies ReconcileOutcome;
            }
          }
          // Insufficient evidence → review; keep identities separate (no merge).
          return { mediaId: null, created: false, needsReview: true } satisfies ReconcileOutcome;
        })
        .catch((err) => {
          this.logger.warn(`crossProviderReconcile failed: ${(err as Error).message}`);
          return { mediaId: null, created: false, needsReview: true } satisfies ReconcileOutcome;
        });
    }) as Promise<ReconcileOutcome>;
  }
}
