import { createHash } from 'crypto';
import type { CommsUniVoteReceipt, Prisma } from '@prisma/client';
import type { CommsUniEngagementKind, CommsUniOptionDto } from '@tvwatch/shared';
import type { ResolvedConversation } from './commsuni.resolver';

export const voteActorDigest = (actor: string) => createHash('sha256').update(actor).digest('hex');

export async function acknowledgeVotes(
  tx: Prisma.TransactionClient,
  scope: string,
  actor: string,
  target: ResolvedConversation,
  kind: string,
  keys: string[],
  sequence: bigint,
): Promise<void> {
  const identity = {
    scope,
    actorDigest: voteActorDigest(actor),
    entityType: target.entityType,
    reference: target.reference,
    kind,
  };
  const previous = await tx.commsUniVoteReceipt.findUnique({
    where: { scope_actorDigest_entityType_reference_kind: identity },
  });
  if (previous && previous.sequence > sequence) return;
  await tx.commsUniVoteReceipt.upsert({
    where: { scope_actorDigest_entityType_reference_kind: identity },
    create: { ...identity, entityId: target.entityId, selectedKeys: keys, sequence },
    update: { entityId: target.entityId, selectedKeys: keys, sequence },
  });
}

/** A reference may acquire a UUID or move to a verified alias. Count the latest receipt per actor. */
export function acknowledgedCounts(
  receipts: CommsUniVoteReceipt[],
  kind: CommsUniEngagementKind,
  viewerActor: string,
  options: CommsUniOptionDto[],
): Map<string, number> {
  const latest = new Map<string, CommsUniVoteReceipt>();
  for (const receipt of receipts) {
    if (receipt.kind !== kind) continue;
    const prior = latest.get(receipt.actorDigest);
    if (!prior || prior.sequence < receipt.sequence) latest.set(receipt.actorDigest, receipt);
  }
  // Use the viewer state from this same read snapshot to avoid double counting the viewer during
  // acknowledged-write rollup lag, including legacy deliveries that predate receipts.
  latest.delete(voteActorDigest(viewerActor));
  const result = new Map<string, number>();
  const add = (key: string) => result.set(key, (result.get(key) ?? 0) + 1);
  for (const receipt of latest.values()) {
    if (
      !Array.isArray(receipt.selectedKeys) ||
      receipt.selectedKeys.some((key) => typeof key !== 'string')
    )
      throw Error('Invalid vote receipt');
    for (const key of new Set(receipt.selectedKeys as string[])) add(key);
  }
  for (const option of options) if (option.selected) add(option.key);
  return result;
}
