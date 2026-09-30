import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../common/prisma/prisma.service';

export const IDENTITY_EVIDENCE_VERSION = 1;
export type IdentityPlanInput = { mediaId: string; anchorWfId?: string; splitWfId?: string };
export type IdentityOperation = {
  version: number;
  status: 'ready' | 'queued' | 'running' | 'applied' | 'blocked' | 'failed' | 'deferred';
  input: IdentityPlanInput;
  fingerprint: string;
  expiresAt: string;
  evidence: Record<string, unknown>;
  receipt?: Record<string, any>;
  error?: string;
};
const json = (value: unknown) =>
  JSON.parse(
    JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item)),
  ) as Prisma.InputJsonValue;

/** Existing AdminAuditLog supplies durable plans, receipts and versioned observations. */
export class IdentityAuditStore {
  constructor(private readonly prisma: PrismaService) {}

  async savePlan(
    token: string,
    actorId: string,
    input: IdentityPlanInput,
    plan: Record<string, any>,
  ) {
    const metadata: IdentityOperation = {
      version: IDENTITY_EVIDENCE_VERSION,
      status:
        plan.status === 'ready' ? 'ready' : plan.status === 'deferred' ? 'deferred' : 'blocked',
      input,
      fingerprint: plan.fingerprint,
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      evidence: {
        title: plan.title,
        sourceMediaId: plan.mediaId,
        splitType: plan.splitOptions?.type,
        reason: plan.reason,
        localFingerprint: plan.localFingerprint,
        action: plan.action,
        rootWfId: plan.rootWfId,
        targetMediaId: plan.targetMediaId,
        members: plan.members,
        verifiedIds: plan.verifiedIds,
        observations: plan.observations,
        impact: plan.impact,
        manifest: plan.manifest,
        details: plan.details,
      },
    };
    await this.prisma.adminAuditLog.create({
      data: {
        id: token,
        adminId: actorId,
        action: 'identity_plan',
        targetType: 'media',
        targetId: input.mediaId,
        metadata: json(metadata),
      },
    });
  }

  async operation(token: string, actorId?: string) {
    const row = await this.prisma.adminAuditLog.findUnique({ where: { id: token } });
    if (!row || row.action !== 'identity_plan' || (actorId && row.adminId !== actorId))
      throw new NotFoundException('Identity operation not found');
    return { id: row.id, actorId: row.adminId, ...(row.metadata as unknown as IdentityOperation) };
  }

  async requirePlan(token: string, actorId: string) {
    const op = await this.operation(token, actorId);
    if (op.status === 'applied') return op;
    if (['blocked', 'deferred'].includes(op.status))
      throw new ConflictException('This preview is not executable. Review its blocking evidence.');
    if (Date.parse(op.expiresAt) < Date.now())
      throw new ConflictException('Preview expired. Preview again.');
    return op;
  }

  async state(
    token: string,
    status: IdentityOperation['status'],
    extra: Record<string, unknown> = {},
  ) {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM admin_audit_logs WHERE id=${token} FOR UPDATE`;
      const row = await tx.adminAuditLog.findUniqueOrThrow({ where: { id: token } });
      const previous = row.metadata as unknown as IdentityOperation;
      if (previous.status === 'applied' && status !== 'applied') return;
      if (extra.receipt && previous.receipt)
        extra = {
          ...extra,
          receipt: {
            ...previous.receipt,
            ...(extra.receipt as any),
            results: previous.receipt.results ?? (extra.receipt as any).results,
            ...(previous.receipt.followUp === 'completed' ? { followUp: 'completed' } : {}),
          },
        };
      await tx.adminAuditLog.update({
        where: { id: token },
        data: {
          metadata: json({ ...previous, ...extra, status, updatedAt: new Date().toISOString() }),
        },
      });
    });
  }

  /** Runs inside the same transaction that accepts aliases or activates recovery links. */
  async committed(tx: Prisma.TransactionClient, token: string, receipt: Record<string, unknown>) {
    const row = await tx.adminAuditLog.findUniqueOrThrow({ where: { id: token } });
    const previous = row.metadata as unknown as IdentityOperation;
    if (previous.status === 'applied')
      throw new ConflictException('This identity operation is already applied');
    await tx.adminAuditLog.update({
      where: { id: token },
      data: {
        metadata: json({
          ...previous,
          status: 'applied',
          receipt,
          committedAt: new Date().toISOString(),
        }),
      },
    });
  }

  private get summaryProjection() {
    // Keep full proof durably stored; polling must not transport thousands of episode mappings.
    return Prisma.sql`metadata || jsonb_build_object('evidence',
      (metadata->'evidence') - 'details' - 'observations')`;
  }

  async publicOperation(id: string) {
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; actorId: string; metadata: Prisma.JsonValue }>
    >(
      Prisma.sql`SELECT id,admin_id AS "actorId",${this.summaryProjection} AS metadata
      FROM admin_audit_logs WHERE id=${id} AND action='identity_plan'`,
    );
    if (!rows.length) throw new NotFoundException('Identity operation not found');
    return {
      id: rows[0].id,
      actorId: rows[0].actorId,
      ...(rows[0].metadata as unknown as IdentityOperation),
    };
  }

  async followUp(token: string, mediaId: string, result: Record<string, unknown>) {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM admin_audit_logs WHERE id=${token} FOR UPDATE`;
      const row = await tx.adminAuditLog.findUnique({ where: { id: token } });
      if (!row) return;
      const op = row.metadata as unknown as IdentityOperation;
      const receipt = op.receipt ?? {};
      const work = {
        ...(receipt.results ?? {}),
        [mediaId]: { ...result, at: new Date().toISOString() },
      };
      const targets = (receipt.mediaIds as string[]) ?? [];
      const complete =
        targets.length > 0 && targets.every((id) => work[id]?.status === 'completed');
      await tx.adminAuditLog.update({
        where: { id: token },
        data: {
          metadata: json({
            ...op,
            receipt: { ...receipt, results: work, followUp: complete ? 'completed' : 'pending' },
          }),
        },
      });
    });
  }
}
