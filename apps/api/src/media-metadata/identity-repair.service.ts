import { isProviderError } from './providers/shared/provider-errors';
import { IdentityTransferManifest } from './identity-transfer-manifest';
import { IdentityAuditStore, IDENTITY_EVIDENCE_VERSION } from './identity-audit.store';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { Prisma, MediaType } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { MediaReconciler, VerifiedIdentityResult } from './reconcile/media-reconciler.service';
import { MediaCanonicalizationService } from './media-canonicalization.service';
import { HydrationQueue } from './hydration/hydration.queue';
import { TmdbProvider, NormalizedShow, NormalizedMovie } from './providers/tmdb.provider';
import { TvdbProvider } from './providers/tvdb.provider';
import { WatchForgeProvider } from './providers/watchforge.client';
import { canonicalMediaId } from './util/canonical-media';
import { assertMediaIdentityWrite } from './util/identity-write-guard';

type Verified = Extract<VerifiedIdentityResult, { status: 'verified' }>;
type Input = { mediaId: string; anchorWfId?: string; splitWfId?: string };
const PROVIDERS: Record<string, WatchForgeProvider | undefined> = {
  TMDB: 'tmdb',
  THE_TVDB: 'tvdb',
  IMDB: 'imdb',
  TV_TIME: 'tvtime_uuid',
};
const hash = (value: unknown) =>
  createHash('sha256')
    .update(
      JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item)),
    )
    .digest('hex');
const normalize = (value: string) =>
  value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');

@Injectable()
export class IdentityRepairService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly reconciler: MediaReconciler,
    private readonly canonical: MediaCanonicalizationService,
    private readonly hydration: HydrationQueue,
    private readonly tmdb: TmdbProvider,
    private readonly tvdb: TvdbProvider,
  ) {}

  async preview(input: Input, actorId: string) {
    const planned = await this.plan(input);
    const manifest = await new IdentityTransferManifest(this.prisma).summary(planned);
    const ready = planned.status === 'ready' && !manifest.blocked;
    const plan = {
      ...planned,
      manifest,
      ...(manifest.blocked ? { status: 'blocked', reason: 'protected-data-needs-review' } : {}),
    };
    const reviewId = randomUUID();
    await this.auditStore.savePlan(reviewId, actorId, input, plan);
    const { familyOptions: _family, splitOptions: _split, ...review } = plan;
    const { episodeMappings: _mappings, ...details } = (plan.details ?? {}) as Record<string, any>;
    return {
      ...review,
      details: { ...details, episodeMappingCount: _mappings?.length ?? 0 },
      reviewId,
      token: ready ? reviewId : null,
      expiresInSeconds: ready ? 600 : null,
    };
  }

  /** Production job entry: verify and repair the current catalog, never require a local script. */
  async repairAutomatically(mediaId: string): Promise<{
    repaired: boolean;
    reason?: string;
    mediaIds: string[];
    followUps: Array<{ mediaId: string; operationId: string }>;
  }> {
    const mediaIds = new Set<string>(),
      followUps: Array<{ mediaId: string; operationId: string }> = [];
    // Receipts are the durable recovery source if a worker stopped after the database commit.
    const prior = await this.prisma.adminAuditLog.findMany({
      where: {
        action: 'identity_plan',
        targetId: mediaId,
        metadata: { path: ['status'], equals: 'applied' },
      },
      orderBy: { createdAt: 'desc' },
      take: 4,
      select: { id: true, metadata: true },
    });
    for (const operation of prior) {
      const receipt = (operation.metadata as any)?.receipt;
      for (const id of receipt?.mediaIds ?? []) {
        if (
          typeof id !== 'string' ||
          ['completed', 'blocked'].includes(receipt.results?.[id]?.status)
        )
          continue;
        mediaIds.add(id);
        followUps.push({ mediaId: id, operationId: operation.id });
      }
    }
    for (let step = 0; step < 4; step++) {
      const current = await canonicalMediaId(this.prisma, mediaId);
      mediaIds.add(current);
      const review = await this.preview({ mediaId: current }, 'automatic-identity-repair');
      if (review.status === 'deferred') {
        if (review.reason === 'disabled')
          return { repaired: false, reason: review.reason, mediaIds: [...mediaIds], followUps };
        throw new Error('Identity verification is temporarily unavailable');
      }
      if (review.status === 'ready' && review.action === 'refresh') {
        if (review.targetMediaId) mediaIds.add(review.targetMediaId);
        return { repaired: true, mediaIds: [...mediaIds], followUps };
      }
      if (
        step === 3 ||
        !review.token ||
        !['split', 'partition', 'attach', 'consolidate'].includes(review.action)
      )
        return {
          repaired: false,
          reason: review.reason || 'Identity still needs verification',
          mediaIds: [...mediaIds],
          followUps,
        };
      const receipt = await this.apply(review.token, 'automatic-identity-repair', {
        deferFollowUp: true,
      });
      if (!receipt) throw new Error('Identity repair receipt is missing');
      for (const id of receipt.mediaIds as string[]) {
        mediaIds.add(id);
        followUps.push({ mediaId: id, operationId: review.token });
      }
    }
    return {
      repaired: false,
      reason: 'Identity repair needs further verification',
      mediaIds: [...mediaIds],
      followUps,
    };
  }

  /** Rebuild provider proof before applying; clients never supply aliases or transfer maps. */
  async apply(token: string, actorId: string, options: { deferFollowUp?: boolean } = {}) {
    if (!/^[0-9a-f-]{36}$/i.test(token)) throw new BadRequestException('Invalid preview token');
    const stored = await this.auditStore.requirePlan(token, actorId);
    if (stored.status === 'applied') return stored.receipt;
    const key = 'identity:plan:' + token + ':lock';
    const locked = await this.redis.client.set(key, token, 'EX', 900, 'NX');
    if (!locked) throw new ConflictException('This repair is already running');
    try {
      await this.auditStore.state(token, 'running');
      const plan = await this.plan(stored.input, true);
      if (plan.status !== 'ready' || plan.fingerprint !== stored.fingerprint) {
        throw new ConflictException(
          plan.status === 'deferred'
            ? 'Provider verification deferred: ' + plan.reason
            : 'Identity or structure changed. Preview again.',
        );
      }
      const mediaIds = [
        ...new Set(
          (plan.action === 'split'
            ? [plan.mediaId, plan.targetMediaId]
            : [plan.targetMediaId ?? plan.mediaId]
          ).filter((id): id is string => !!id),
        ),
      ];
      const manifest = await new IdentityTransferManifest(this.prisma).summary(plan);
      if (manifest.blocked)
        throw new ConflictException(
          'Protected data requires additional review or an image is still processing',
        );
      const receipt: Record<string, any> = {
        operationId: token,
        actorId,
        status: 'applied',
        manifest,
        result: {
          status: 'applied',
          action: plan.action,
          mediaId: plan.mediaId,
          targetMediaId: plan.targetMediaId,
        },
        fingerprint: plan.fingerprint,
        followUp: 'pending',
        mediaIds,
        results: {},
        nextStep:
          plan.action === 'partition' && plan.members.length > 1
            ? 'Preview the corrected identity to consolidate its existing owners.'
            : plan.reason === 'target-graph-is-stale'
              ? 'Preview again after structure refresh to consolidate the family.'
              : null,
      };
      const commit = (tx: Prisma.TransactionClient) =>
        this.auditStore.committed(tx, token, receipt);
      let result: any;
      if (plan.action === 'consolidate') {
        result = await this.canonical.identityFamily(plan.members, plan.targetMediaId!, {
          ...plan.familyOptions!,
          mode: 'repair',
          fingerprint: plan.transferFingerprint,
          commit,
          evidence: { ...plan.familyOptions?.evidence, operationId: token },
        });
      } else if (plan.action === 'split') {
        result = await this.canonical.splitIdentity(plan.mediaId, {
          ...plan.splitOptions!,
          mode: 'repair',
          fingerprint: plan.transferFingerprint,
          commit,
          evidence: { ...plan.splitOptions?.evidence, operationId: token },
        });
      } else {
        await this.prisma.$transaction(
          async (tx) => {
            const ids = [...new Set([plan.mediaId, ...plan.members])].sort();
            await tx.$queryRaw(
              Prisma.sql`SELECT id FROM media_items WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`,
            );
            const current = await this.readState(plan.mediaId, tx);
            if (this.stateFingerprint(current) !== plan.localFingerprint)
              throw new ConflictException('Local identity changed');
            if (plan.action === 'partition')
              await tx.externalId.deleteMany({
                where: { id: { in: plan.removeAliasIds }, mediaId: plan.mediaId },
              });
            await assertMediaIdentityWrite(tx, plan.mediaId, current.type, plan.verifiedIds);
            for (const identity of ['attach', 'partition'].includes(plan.action)
              ? plan.verifiedIds
              : []) {
              const existing = await tx.externalId.findUnique({
                where: { provider_providerEntityKind_value: identity as any },
              });
              if (existing && existing.mediaId !== plan.mediaId) {
                if (plan.action === 'partition') continue;
                throw new ConflictException('Identity acquired by another owner');
              }
              if (!existing)
                await tx.externalId.create({ data: { ...identity, mediaId: plan.mediaId } as any });
            }
            const next = { ...((current.metadataProvenance as Record<string, any>) ?? {}) };
            const previous = Array.isArray(next.identityQuarantinedAliases)
              ? next.identityQuarantinedAliases
              : Array.isArray(next.identityRepair?.quarantinedAliases)
                ? next.identityRepair.quarantinedAliases
                : [];
            const claims = current.externalIds.filter((id) => plan.removeAliasIds.includes(id.id));
            if (previous.length || claims.length)
              next.identityQuarantinedAliases = [
                ...new Map(
                  [...previous, ...claims].map((id: any) => [
                    id.provider + ':' + id.providerEntityKind + ':' + id.value,
                    id,
                  ]),
                ).values(),
              ];
            const identityVersion = hash(plan.verifiedIds);
            if (
              next.identityRepair?.identityVersion !== identityVersion &&
              ['attach', 'partition'].includes(plan.action)
            ) {
              for (const field of [
                'animeTvdbNoId',
                'tvdbIdentityCollision',
                'recsCheckedAt',
                'charIdsCheckedAt',
                'countryCheckedAt',
                'bannerCheckedAt',
                'hydrateNotFoundAt',
                'ratingCheckedAt',
                'enContentRepairFailedAt',
                'enContentRepairFailedReason',
              ])
                delete next[field];
            }
            await tx.mediaItem.update({
              where: { id: plan.mediaId },
              data: {
                ...(plan.action === 'partition'
                  ? {
                      metadataRefreshedAt: null,
                      titles: Prisma.DbNull,
                      overviews: Prisma.DbNull,
                      posterUrls: Prisma.DbNull,
                      backdropUrls: Prisma.DbNull,
                      galleryState: Prisma.DbNull,
                    }
                  : {}),
                metadataProvenance: {
                  ...next,
                  identityRepair: {
                    identityVersion,
                    operationId: token,
                    fingerprint: plan.fingerprint,
                    wfId: plan.rootWfId,
                    at: new Date().toISOString(),
                    action: plan.action,
                  },
                } as Prisma.InputJsonValue,
              },
            });
            await commit(tx);
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
        result = receipt.result;
      }
      if (result?.status !== 'applied')
        throw new ConflictException(result?.reason ?? 'Repair blocked');
      receipt.result = result;
      if (options.deferFollowUp) {
        await this.auditStore.state(token, 'applied', { receipt });
        return receipt;
      }
      const followUps = await Promise.allSettled(
        mediaIds.map((id) =>
          this.hydration.enqueueIdentityRefresh(id, plan.fingerprint.slice(0, 20), token),
        ),
      );
      receipt.followUp = followUps.every((r) => r.status === 'fulfilled')
        ? 'queued'
        : 'retry-required';
      await this.auditStore.state(token, 'applied', { receipt });
      return receipt;
    } catch (error) {
      const persisted = await this.auditStore.operation(token, actorId).catch(() => null);
      if (persisted?.status === 'applied') return persisted.receipt;
      const message =
        error instanceof ConflictException
          ? error.message
          : 'Repair failed without a committed cutover. Inspect the operation and preview again.';
      await this.auditStore.state(
        token,
        error instanceof ConflictException ? 'blocked' : 'failed',
        { error: message },
      );
      throw error;
    } finally {
      await this.redis.client
        .eval(
          "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0",
          1,
          key,
          token,
        )
        .catch(() => undefined);
    }
  }

  private get auditStore() {
    return new IdentityAuditStore(this.prisma);
  }

  async operation(id: string) {
    return this.auditStore.publicOperation(id);
  }

  async resumeFollowUps(operationId?: string) {
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; metadata: Prisma.JsonValue }>
    >(Prisma.sql`
      SELECT id,metadata FROM admin_audit_logs a WHERE action='identity_plan'
        AND metadata->>'status'='applied'
        AND (${!operationId} OR id=${operationId ?? ''})
        AND COALESCE(metadata->'receipt'->>'followUp','pending')<>'completed'
        AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(COALESCE(metadata->'receipt'->'mediaIds','[]')) t(media_id)
          WHERE COALESCE(metadata->'receipt'->'results'->t.media_id->>'status','pending') NOT IN ('completed','blocked')
          AND (${!!operationId} OR COALESCE(metadata->'receipt'->'results'->t.media_id->>'at','')<${new Date(Date.now() - 3600000).toISOString()}))
      ORDER BY COALESCE((metadata->'evidence'->'impact'->>'history')::bigint,0) DESC,created_at ASC
      LIMIT ${operationId ? 1 : 10}
    `);
    let queued = 0;
    for (const row of rows) {
      const op = row.metadata as any,
        receipt = op?.receipt;
      if (!receipt || receipt.followUp === 'completed') continue;
      for (const mediaId of (receipt.mediaIds ?? []) as string[]) {
        const prior = receipt.results?.[mediaId];
        if (prior?.status === 'completed' || prior?.status === 'blocked') continue;
        if (!operationId && prior?.at && Date.parse(prior.at) > Date.now() - 3600000) continue;
        try {
          await this.hydration.enqueueIdentityRefresh(
            mediaId,
            String(receipt.fingerprint ?? op.fingerprint).slice(0, 20),
            row.id,
          );
          queued++;
        } catch {
          return { queued, deferred: true };
        }
      }
    }
    return { queued, deferred: false };
  }

  async enqueueApply(token: string, actorId: string) {
    const operation = await this.auditStore.requirePlan(token, actorId);
    if (operation.status === 'applied') return operation.receipt;
    if (operation.status === 'running') return { operationId: token, status: 'running' };
    await this.auditStore.state(token, 'queued');
    try {
      await this.hydration.enqueueIdentityApply(token, actorId);
    } catch (error) {
      await this.auditStore.state(token, 'failed', {
        error: 'Could not enqueue repair. Retry while the preview is valid.',
      });
      throw error;
    }
    return { operationId: token, status: 'queued' };
  }

  async repairEligible(
    mediaId: string,
    action: 'split' | 'consolidate' | 'partition' | 'attach',
    targetMediaId?: string,
  ) {
    const actor = 'metadata-repair';
    const preview = await this.preview({ mediaId }, actor);
    if (
      preview.status !== 'ready' ||
      preview.action !== action ||
      !preview.token ||
      (targetMediaId && preview.targetMediaId !== targetMediaId)
    ) {
      throw new ConflictException(preview.reason || 'Verified preview required');
    }
    return this.apply(preview.token, actor);
  }

  private stateFingerprint(media: Record<string, any>) {
    return hash({
      id: media.id,
      type: media.type,
      title: media.title,
      classification: media.contentClassification,
      manualClassification: media.manualClassification,
      aliases: (media.externalIds ?? [])
        .map((id: any) => ({ provider: id.provider, kind: id.providerEntityKind, value: id.value }))
        .sort((a: any, b: any) =>
          (a.provider + ':' + a.kind + ':' + a.value).localeCompare(
            b.provider + ':' + b.kind + ':' + b.value,
          ),
        ),
      show: media.show
        ? {
            id: media.show.id,
            year: media.show.yearStart,
            provider: media.show.structureProvider,
            reason: media.show.structureReason,
            ruleVersion: media.show.structureRuleVersion,
          }
        : null,
      movie: media.movie ? { id: media.movie.id, year: media.movie.releaseYear } : null,
      split: media.metadataProvenance?.identitySplit?.targets ?? null,
    });
  }

  private readState(id: string, db: Prisma.TransactionClient = this.prisma) {
    return db.mediaItem.findUniqueOrThrow({
      where: { id },
      include: {
        externalIds: {
          orderBy: [{ provider: 'asc' }, { providerEntityKind: 'asc' }, { value: 'asc' }],
        },
        show: true,
        movie: true,
      },
    });
  }

  private async snapshot(root: Verified, type: MediaType, provider: 'tmdb' | 'tvdb') {
    const value = root.externals.find(
      (id) => id.provider === (provider === 'tvdb' ? 'THE_TVDB' : 'TMDB'),
    )?.value;
    if (!value) throw new ConflictException('Canonical provider has no verified identity');
    return type === 'SHOW'
      ? provider === 'tvdb'
        ? this.tvdb.getShow(Number(value), 'en', { seasonType: 'official', bypassCache: true })
        : this.tmdb.getShow(Number(value), 'en-US', { bypassCache: true })
      : provider === 'tvdb'
        ? this.tvdb.getMovie(Number(value), 'en', { bypassCache: true })
        : this.tmdb.getMovie(Number(value), 'en-US', { bypassCache: true });
  }

  private async plan(input: Input, fresh = false) {
    if (!input.mediaId || input.mediaId.length > 100)
      throw new BadRequestException('Media ID required');
    const mediaId = await canonicalMediaId(this.prisma, input.mediaId);
    const media = await this.readState(mediaId).catch(() => null);
    if (!media) throw new NotFoundException('Media not found');
    const localFingerprint = this.stateFingerprint(media);
    const kind = media.type === 'SHOW' ? 'SERIES' : 'MOVIE';
    const type = media.type;
    const aliases = media.externalIds.filter((id) => PROVIDERS[id.provider]);
    const roots = new Map<string, Verified>();
    const alternate = new Map<string, Verified>();
    const observations: Array<{
      aliasId: string;
      type: MediaType;
      result: VerifiedIdentityResult;
    }> = [];
    const opposite: MediaType = type === 'MOVIE' ? 'SHOW' : 'MOVIE';
    const hasStray = type === 'MOVIE' ? !!media.show : !!media.movie;
    const base = {
      mediaId,
      title: media.title,
      status: 'blocked',
      action: 'none',
      reason: '',
      retryAfterMs: undefined as number | undefined,
      fingerprint: '',
      localFingerprint,
      targetMediaId: null as string | null,
      rootWfId: null as string | null,
      members: [mediaId],
      verifiedIds: [] as Verified['externals'],
      transferFingerprint: undefined as string | undefined,
      familyOptions: undefined as
        Parameters<MediaCanonicalizationService['identityFamily']>[2] | undefined,
      splitOptions: undefined as
        Parameters<MediaCanonicalizationService['splitIdentity']>[1] | undefined,
      choices: [] as Array<{ wfId: string; type: MediaType; title: string; year: number | null }>,
      observations,
      removeAliasIds: [] as string[],
      impact: {} as Record<string, number>,
      details: undefined as unknown,
    };
    const finish = (values: Partial<typeof base>) => {
      const result = { ...base, ...values };
      // Supplier timestamps and cache state are deliberately not plan identity.
      result.fingerprint = hash({
        localFingerprint,
        action: result.action,
        target: result.targetMediaId,
        roots: [...roots.values(), ...alternate.values()].map((r) => ({
          wfId: r.evidence.wfId,
          externals: r.externals,
        })),
        transfer: result.transferFingerprint,
        version: IDENTITY_EVIDENCE_VERSION,
        options: fingerprintOptions(result.splitOptions),
        removeAliasIds: result.removeAliasIds,
        family: fingerprintOptions(result.familyOptions),
      });
      return result;
    };
    if (!aliases.length || aliases.length > 16)
      return finish({ reason: 'missing-or-excessive-aliases' });
    for (const alias of aliases) {
      const declared: MediaType | null =
        alias.providerEntityKind === 'SERIES'
          ? 'SHOW'
          : alias.providerEntityKind === 'MOVIE'
            ? 'MOVIE'
            : null;
      for (const queryType of [...new Set([declared, ...(hasStray ? [opposite] : [])])]) {
        if (!queryType) continue;
        const result = await this.reconciler.resolveProviderIdentity(
          {
            provider: PROVIDERS[alias.provider]!,
            id: alias.value,
            mediaType: queryType === 'SHOW' ? 'tv' : 'movie',
          },
          { fresh, primaryOnly: queryType === 'MOVIE' && alias.provider !== 'THE_TVDB' },
        );
        observations.push({ aliasId: alias.id, type: queryType, result });
        if (result.status === 'deferred')
          return finish({
            status: 'deferred',
            reason: result.reason,
            retryAfterMs: result.retryAfterMs,
          });
        if (result.status === 'verified' && result.anchorVerified) {
          const group = queryType === type ? roots : alternate;
          const previous = group.get(result.evidence.wfId);
          if (previous) {
            const externals = [
              ...new Map(
                [...previous.externals, ...result.externals].map((id) => [
                  id.provider + ':' + id.providerEntityKind + ':' + id.value,
                  id,
                ]),
              ).values(),
            ];
            if (
              new Set(
                externals
                  .filter((id) => queryType !== 'MOVIE' || id.provider !== 'THE_TVDB')
                  .map((id) => id.provider),
              ).size !==
              externals.filter((id) => queryType !== 'MOVIE' || id.provider !== 'THE_TVDB').length
            ) {
              return finish({ reason: 'inconsistent-verified-primary-ids' });
            }
            group.set(result.evidence.wfId, {
              ...result,
              externals,
              ownerMediaIds: [...new Set([...previous.ownerMediaIds, ...result.ownerMediaIds])],
              wrongTypeOwnerIds: [
                ...new Set([
                  ...(previous.wrongTypeOwnerIds ?? []),
                  ...(result.wrongTypeOwnerIds ?? []),
                ]),
              ],
            });
          } else group.set(result.evidence.wfId, result);
        }
      }
    }
    // A movie's main TMDB path deliberately tolerates stale optional TVDB claims.
    // Probe only asserted TVDB IDs that actually have another local owner, so those
    // duplicate families cannot be hidden by primaryOnly.
    if (type === 'MOVIE') {
      for (const root of [...roots.values()]) {
        const values = root.evidence.ids.tvdb;
        if (!values.length || values.length > 16) continue;
        const owners = await this.prisma.externalId.findMany({
          where: {
            provider: 'THE_TVDB',
            providerEntityKind: 'MOVIE',
            value: { in: values },
            mediaId: { not: mediaId },
          },
          select: { value: true },
        });
        for (const { value } of owners) {
          const proof = await this.reconciler.resolveProviderIdentity(
            { provider: 'tvdb', id: value, mediaType: 'movie' },
            { fresh },
          );
          observations.push({ aliasId: 'occupied-tvdb:' + value, type: 'MOVIE', result: proof });
          if (proof.status === 'deferred')
            return finish({
              status: 'deferred',
              reason: proof.reason,
              retryAfterMs: proof.retryAfterMs,
            });
          if (
            proof.status !== 'verified' ||
            !proof.anchorVerified ||
            proof.evidence.wfId !== root.evidence.wfId
          )
            return finish({ reason: 'occupied-tvdb-identity-unproven' });
          const merged = roots.get(root.evidence.wfId)!;
          roots.set(root.evidence.wfId, {
            ...merged,
            externals: [
              ...new Map(
                [...merged.externals, ...proof.externals].map((id) => [
                  id.provider + ':' + id.value,
                  id,
                ]),
              ).values(),
            ],
            ownerMediaIds: [...new Set([...merged.ownerMediaIds, ...proof.ownerMediaIds])],
            wrongTypeOwnerIds: [
              ...new Set([...(merged.wrongTypeOwnerIds ?? []), ...(proof.wrongTypeOwnerIds ?? [])]),
            ],
          });
        }
      }
    }
    base.choices = [...roots.values()]
      .map((r) => ({ wfId: r.evidence.wfId, type, title: r.title, year: r.year }))
      .concat(
        [...alternate.values()].map((r) => ({
          wfId: r.evidence.wfId,
          type: opposite,
          title: r.title,
          year: r.year,
        })),
      );
    const currentYear = type === 'SHOW' ? media.show?.yearStart : media.movie?.releaseYear;
    const matching = [...roots.values()].filter(
      (r) =>
        normalize(r.title) === normalize(media.title) &&
        (!currentYear || !r.year || currentYear === r.year),
    );
    const root = input.anchorWfId
      ? roots.get(input.anchorWfId)
      : roots.size === 1
        ? [...roots.values()][0]
        : matching.length === 1
          ? matching[0]
          : undefined;
    if (!root)
      return finish({
        reason: roots.size ? 'choose-current-identity' : 'current-identity-unproven',
      });
    // A reverse catalog lookup can be absent even when the native provider corroborates
    // an already-stored secondary ID. Keep that correct link instead of contesting it.
    if (type === 'MOVIE' && !root.externals.some((id) => id.provider === 'THE_TVDB')) {
      const tmdb = root.externals.find((id) => id.provider === 'TMDB')?.value;
      const imdb = root.externals.find((id) => id.provider === 'IMDB')?.value;
      for (const alias of aliases.filter(
        (id) => id.provider === 'THE_TVDB' && id.providerEntityKind === 'MOVIE',
      )) {
        try {
          const remote = await this.tvdb.getMovieIdentity(Number(alias.value), {
            bypassCache: fresh,
          });
          if (
            (remote.tmdbId && tmdb && String(remote.tmdbId) !== tmdb) ||
            (remote.imdbId && imdb && remote.imdbId !== imdb)
          )
            continue;
          if (
            (remote.tmdbId && String(remote.tmdbId) === tmdb) ||
            (remote.imdbId && remote.imdbId === imdb)
          ) {
            root.externals.push({
              provider: 'THE_TVDB' as any,
              providerEntityKind: 'MOVIE' as any,
              value: alias.value,
            });
            break;
          }
        } catch {
          /* unverified aliases stay contested */
        }
      }
    }
    base.rootWfId = root.evidence.wfId;
    base.members = [...new Set([mediaId, ...root.ownerMediaIds])].sort();
    base.verifiedIds = root.externals;
    const [statuses, history, ratings, votes, favorites, lists] = await Promise.all([
      type === 'SHOW'
        ? this.prisma.userShowStatus.count({ where: { mediaId } })
        : this.prisma.userMovieStatus.count({ where: { mediaId } }),
      this.prisma.watchHistory.count({ where: { mediaId } }),
      this.prisma.rating.count({ where: { mediaId } }),
      this.prisma.characterVote.count({
        where: { OR: [{ mediaId }, { episode: { season: { show: { mediaId } } } }] },
      }),
      this.prisma.favorite.count({ where: { mediaId } }),
      this.prisma.customListItem.count({ where: { mediaId } }),
    ]);
    base.impact = { statuses, history, ratings, votes, favorites, lists };
    if (hasStray) {
      const candidates = input.splitWfId
        ? [alternate.get(input.splitWfId)].filter((r): r is Verified => !!r)
        : [...alternate.values()];
      if (!candidates.length) return finish({ reason: 'stray-identity-unproven' });
      const viable: Array<{
        root: Verified;
        options: NonNullable<typeof base.splitOptions>;
        preview: any;
      }> = [];
      for (const other of candidates.slice(0, 8)) {
        const existing = other.ownerMediaIds.filter(
          (id) => id !== mediaId && !other.wrongTypeOwnerIds?.includes(id),
        );
        if (existing.length > 1) continue;
        const targetState = existing[0] ? await this.readState(existing[0]) : null;
        const canonical: 'tmdb' | 'tvdb' =
          opposite === 'SHOW' &&
          ((targetState?.show ?? media.show)?.structureProvider === 'TVDB' ||
            !other.externals.some((id) => id.provider === 'TMDB'))
            ? 'tvdb'
            : 'tmdb';
        let snapshot: NormalizedShow | NormalizedMovie;
        try {
          snapshot = await this.snapshot(other, opposite, canonical);
        } catch {
          return finish({ status: 'deferred', reason: 'split-provider-snapshot-unavailable' });
        }
        if (
          opposite === 'MOVIE' &&
          !aliases.some(
            (id) =>
              id.providerEntityKind === 'MOVIE' &&
              other.externals.some((e) => e.provider === id.provider && e.value === id.value),
          )
        )
          continue;
        let foreignSnapshot: NormalizedShow | undefined;
        if (
          opposite === 'SHOW' &&
          other.externals.some((e) => e.provider === (canonical === 'tmdb' ? 'THE_TVDB' : 'TMDB'))
        ) {
          try {
            foreignSnapshot = (await this.snapshot(
              other,
              opposite,
              canonical === 'tmdb' ? 'tvdb' : 'tmdb',
            )) as NormalizedShow;
          } catch {
            return finish({ status: 'deferred', reason: 'foreign-snapshot-unavailable' });
          }
        }
        const typedVotes = await this.prisma.characterVote.findMany({
          where:
            opposite === 'SHOW'
              ? { episode: { season: { show: { mediaId } } } }
              : { mediaId, episodeId: null },
          include: { cast: { include: { castMember: true } } },
        });
        const allowedCastIds = typedVotes
          .filter(
            (v) =>
              (v.cast.characterExternalId &&
                [
                  ...(snapshot.characterIds ?? []),
                  ...(foreignSnapshot?.characterIds ?? []),
                ].includes(String(v.cast.characterExternalId))) ||
              snapshot.cast.some(
                (c) =>
                  c.personExternalId?.startsWith('TMDB_') &&
                  v.cast.castMember.tmdbId === c.tmdbPersonId &&
                  !!v.cast.character &&
                  normalize(v.cast.character) === normalize(c.character ?? ''),
              ),
          )
          .map((v) => v.castId)
          .sort();
        if (typedVotes.some((v) => !allowedCastIds.includes(v.castId))) continue;
        const removeAliasIds = aliases
          .filter(
            (id) =>
              id.providerEntityKind === kind &&
              !root.externals.some((e) => e.provider === id.provider && e.value === id.value) &&
              other.externals.some((e) => e.provider === id.provider && e.value === id.value) &&
              !observations.some(
                (o) => o.aliasId === id.id && o.type === type && o.result.status === 'verified',
              ),
          )
          .map((id) => id.id);
        const options: NonNullable<typeof base.splitOptions> = {
          mode: 'dry-run',
          type: opposite,
          title: other.title,
          targetId: existing[0],
          verifiedIds: other.externals,
          removeAliasIds,
          allowedCastIds,
          independentParentAnchor: aliases.some(
            (id) =>
              (id.provider === 'IMDB' ||
                id.providerEntityKind === (opposite === 'SHOW' ? 'SERIES' : 'MOVIE')) &&
              other.externals.some((e) => e.provider === id.provider && e.value === id.value) &&
              !root.externals.some((e) => e.provider === id.provider && e.value === id.value),
          ),
          canonical,
          snapshot: 'seasons' in snapshot ? snapshot.seasons : undefined,
          foreignSnapshot: foreignSnapshot?.seasons,
          evidence: { wfId: other.evidence.wfId, rootWfId: root.evidence.wfId },
        };
        const preview = await this.canonical.splitIdentity(mediaId, options);
        if (preview.status === 'ready') viable.push({ root: other, options, preview });
        else base.details = preview;
      }
      if (viable.length !== 1)
        return finish({
          reason: viable.length > 1 ? 'choose-stray-identity' : 'split-needs-more-evidence',
        });
      const selected = viable[0];
      return finish({
        status: 'ready',
        action: 'split',
        reason: 'verified-typed-split',
        targetMediaId: selected.preview.targetMediaId,
        splitOptions: selected.options,
        transferFingerprint: selected.preview.fingerprint,
        details: selected.preview,
      });
    }
    // Refuse alias partition by guesswork: every local core alias must be proved.
    const valid = new Set(
      root.externals.map((id) => id.provider + ':' + id.providerEntityKind + ':' + id.value),
    );
    const contested = aliases.filter(
      (id) =>
        id.provider !== 'TV_TIME' &&
        !valid.has(id.provider + ':' + id.providerEntityKind + ':' + id.value),
    );
    if (contested.length) {
      const proof = await Promise.all(
        contested.map(async (id) => {
          if (
            observations.some(
              (o) =>
                o.aliasId === id.id &&
                o.result.status === 'verified' &&
                o.result.anchorVerified &&
                o.result.evidence.wfId !== root.evidence.wfId,
            )
          )
            return true;
          // The live primary provider already proved the current IMDb identity. A second,
          // different IMDb claim is contradictory even if WatchForge has no entry for it.
          const imdb = root.externals.find((link) => link.provider === 'IMDB')?.value;
          const tmdb = root.externals.find((link) => link.provider === 'TMDB')?.value;
          if (id.provider === 'IMDB' && imdb && id.value !== imdb) return true;
          if (id.providerEntityKind !== (type === 'SHOW' ? 'SERIES' : 'MOVIE')) return true;
          if (id.provider === 'THE_TVDB') {
            try {
              const remote =
                type === 'SHOW'
                  ? await this.tvdb.getShowIdentity(Number(id.value), { bypassCache: fresh })
                  : await this.tvdb.getMovieIdentity(Number(id.value), { bypassCache: fresh });
              return Boolean(
                (imdb && remote.imdbId && imdb !== remote.imdbId) ||
                (tmdb && remote.tmdbId && tmdb !== String(remote.tmdbId)),
              );
            } catch (error) {
              return isProviderError(error) && error.notFound;
            }
          }
          return false;
        }),
      );
      const proved = proof.every(Boolean);
      if (!proved) return finish({ reason: 'conflicting-alias-partition-unproven' });
      // Retain the work already identified by the record's title/year and provider anchors.
      // Multiple TMDB claims are repairable only with a second corroborated local anchor;
      // unknown-year or ambiguous work selection still requires review.
      const primary = aliases.filter(
        (id) =>
          id.provider === 'TMDB' &&
          id.providerEntityKind === (type === 'SHOW' ? 'SERIES' : 'MOVIE'),
      );
      const primaryProvesCurrent =
        matching.length === 1 &&
        matching[0] === root &&
        primary.some((alias) =>
          root.externals.some((id) => id.provider === 'TMDB' && id.value === alias.value),
        ) &&
        (primary.length === 1 ||
          (currentYear != null &&
            root.year === currentYear &&
            aliases.some(
              (alias) =>
                ['IMDB', 'THE_TVDB'].includes(alias.provider) &&
                root.externals.some(
                  (id) =>
                    id.provider === alias.provider &&
                    id.providerEntityKind === alias.providerEntityKind &&
                    id.value === alias.value,
                ),
            )));
      if (!input.anchorWfId && !primaryProvesCurrent)
        return finish({ reason: 'choose-current-identity-before-partition' });
      if (type === 'SHOW') {
        const provider = media.show?.structureProvider === 'TVDB' ? 'tvdb' : 'tmdb';
        let snapshot: NormalizedShow;
        try {
          snapshot = (await this.snapshot(root, type, provider)) as NormalizedShow;
        } catch {
          return finish({ status: 'deferred', reason: 'provider-snapshot-unavailable' });
        }
        const episodes = await this.prisma.episode.findMany({
          where: { season: { show: { mediaId } } },
          select: { externalIds: true },
        });
        const ids = new Set(
          snapshot.seasons.flatMap((s) => s.episodes.map((e) => String(e.tmdbId))),
        );
        const name = provider === 'tvdb' ? 'THE_TVDB' : 'TMDB';
        if (
          !episodes.length ||
          episodes.some(
            (e) => !e.externalIds.some((id) => id.provider === name && ids.has(id.value)),
          )
        ) {
          return finish({ reason: 'mixed-episode-structure-needs-partition' });
        }
      }
      return finish({
        status: 'ready',
        action: 'partition',
        reason: 'quarantine-proven-conflicting-aliases',
        removeAliasIds: contested.map((id) => id.id),
        details: {
          aliases: contested,
          retained:
            'All existing user data stays on the selected identity. Removed alias claims are retained in provenance; no user choices are redistributed.',
        },
      });
    }
    if (root.wrongTypeOwnerIds?.length) return finish({ reason: 'other-owner-needs-typed-split' });
    const members = [...new Set([mediaId, ...root.ownerMediaIds])].sort();
    base.members = members;
    if (members.length > 1) {
      const rows = await this.prisma.mediaItem.findMany({
        where: { id: { in: members } },
        include: { show: true, movie: true, externalIds: true },
      });
      const anime = type === 'SHOW' && rows.some((r) => r.contentClassification === 'ANIME');
      const preferred = anime ? 'THE_TVDB' : 'TMDB';
      const overrides = rows.filter((r) => r.show?.structureReason === 'MANUAL_OVERRIDE');
      if (overrides.length > 1) return finish({ reason: 'conflicting-manual-authority' });
      const target =
        overrides[0] ??
        rows.find((r) =>
          r.externalIds.some(
            (id) =>
              id.provider === preferred &&
              root.externals.some((e) => e.provider === id.provider && e.value === id.value),
          ),
        ) ??
        rows[0];
      if (!target) return finish({ reason: 'owner-disappeared' });
      const canonical: 'tmdb' | 'tvdb' =
        target.show?.structureReason === 'MANUAL_OVERRIDE'
          ? target.show.structureProvider === 'TVDB'
            ? 'tvdb'
            : 'tmdb'
          : target.show?.structureProvider === 'TVDB' || anime
            ? 'tvdb'
            : 'tmdb';
      let snapshot: NormalizedShow | NormalizedMovie;
      try {
        snapshot = await this.snapshot(root, type, canonical);
      } catch {
        return finish({ status: 'deferred', reason: 'provider-snapshot-unavailable' });
      }
      let foreignSnapshot: NormalizedShow | undefined;
      if (
        type === 'SHOW' &&
        root.externals.some((e) => e.provider === (canonical === 'tmdb' ? 'THE_TVDB' : 'TMDB'))
      ) {
        try {
          foreignSnapshot = (await this.snapshot(
            root,
            type,
            canonical === 'tmdb' ? 'tvdb' : 'tmdb',
          )) as NormalizedShow;
        } catch {
          return finish({ status: 'deferred', reason: 'foreign-snapshot-unavailable' });
        }
      }
      if (type === 'MOVIE') {
        const movie = snapshot as NormalizedMovie;
        const cut = (title: string) =>
          /director.?s cut|extended|unrated|redux|final cut/i.test(title);
        if (
          rows.some(
            (row) =>
              cut(row.title) !== cut(movie.title) ||
              (row.movie?.runtimeMinutes &&
                movie.runtimeMinutes &&
                Math.abs(row.movie.runtimeMinutes - movie.runtimeMinutes) > 10) ||
              (row.movie?.releaseYear &&
                movie.releaseYear &&
                Math.abs(row.movie.releaseYear - movie.releaseYear) > 1),
          )
        )
          return finish({ reason: 'movie-edition-or-runtime-disagreement' });
      }
      const options = {
        mode: 'dry-run' as const,
        verifiedIds: root.externals,
        canonical,
        snapshot: 'seasons' in snapshot ? snapshot.seasons : undefined,
        foreignSnapshot: foreignSnapshot?.seasons,
        evidence: { wfId: root.evidence.wfId },
      };
      const preview = await this.canonical.identityFamily(members, target.id, options);
      if (preview.status === 'structure-required')
        return finish({
          status: 'ready',
          action: 'refresh',
          targetMediaId: target.id,
          reason: preview.reason,
          details: preview,
          // Only refresh a clean existing target; aliases remain on their current owners.
          members: [mediaId],
        });
      return finish({
        status: preview.status,
        action: 'consolidate',
        targetMediaId: target.id,
        reason: preview.reason,
        transferFingerprint: preview.fingerprint,
        familyOptions: options,
        details: preview,
      });
    }
    const missing = root.externals.some(
      (e) =>
        !media.externalIds.some(
          (id) =>
            id.provider === e.provider &&
            id.providerEntityKind === e.providerEntityKind &&
            id.value === e.value,
        ),
    );
    return finish({
      status: 'ready',
      action: missing ? 'attach' : 'refresh',
      targetMediaId: mediaId,
      reason: missing ? 'verified-missing-aliases' : 'verified-owner-refresh',
    });
  }
}

/** Only fields consumed by identity/episode proof invalidate a reviewed plan. */
function fingerprintOptions(options: any) {
  if (!options) return null;
  const seasons = (rows: any[] | undefined) =>
    rows?.map((s) => ({
      number: s.number,
      isSpecial: s.isSpecial,
      episodes: s.episodes.map((e: any) => ({
        tmdbId: e.tmdbId,
        number: e.number,
        absoluteNumber: e.absoluteNumber,
        title: e.title,
        airDate: e.airDate,
        runtimeMinutes: e.runtimeMinutes,
      })),
    }));
  return {
    type: options.type,
    title: options.title,
    targetId: options.targetId,
    verifiedIds: options.verifiedIds,
    removeAliasIds: options.removeAliasIds,
    allowedCastIds: options.allowedCastIds,
    independentParentAnchor: options.independentParentAnchor,
    canonical: options.canonical,
    snapshot: seasons(options.snapshot),
    foreignSnapshot: seasons(options.foreignSnapshot),
  };
}
