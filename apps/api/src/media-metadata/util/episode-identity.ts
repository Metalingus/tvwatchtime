import { ConflictException } from '@nestjs/common';
import { createHash } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';

type Reader = Pick<PrismaClient | Prisma.TransactionClient, 'mediaCanonicalCopy'>;
const activeCopy = {
  OR: [{ link: { status: 'ACTIVE' as const } }, { linkId: null, mappingKey: { not: null } }],
};
export const episodeAliasKey = (provider: string, value: string) => provider + ':EPISODE:' + value;

/** Fetch a bounded graph in batches; imports must not issue one query per episode. */
export async function canonicalEpisodeTargetMap(
  db: Reader,
  sourceIds: string[],
): Promise<Map<string, string[]>> {
  const graph = new Map<string, string[]>();
  let pending = [...new Set(sourceIds)];
  for (let depth = 0; pending.length && depth <= 8; depth++) {
    const next = new Set<string>();
    for (let offset = 0; offset < pending.length; offset += 5000) {
      const page = pending.slice(offset, offset + 5000);
      const rows = await db.mediaCanonicalCopy.findMany({
        where: {
          sourceId: { in: page },
          AND: [
            activeCopy,
            {
              OR: [
                { entityType: 'EPISODE' },
                { entityType: { startsWith: 'EPISODE:split:' } },
                { entityType: 'EPISODE_ALIAS' },
              ],
            },
          ],
        },
        select: { sourceId: true, targetId: true },
      });
      for (const id of page) graph.set(id, []);
      for (const row of rows) {
        graph.get(row.sourceId)!.push(row.targetId);
        if (!graph.has(row.targetId)) next.add(row.targetId);
      }
    }
    pending = [...next].filter((id) => !graph.has(id));
  }
  const walk = (id: string, path: Set<string>): string[] => {
    if (path.has(id) || path.size > 8)
      throw new ConflictException('Cyclic or excessive episode identity mapping');
    const edges = graph.get(id);
    if (!edges?.length) return id.includes(':EPISODE:') ? [] : [id];
    const seen = new Set(path);
    seen.add(id);
    const result = [...new Set(edges.flatMap((next) => walk(next, seen)))];
    if (result.length > 32) throw new ConflictException('Episode mapping requires review');
    return result;
  };
  return new Map(sourceIds.map((id) => [id, walk(id, new Set())]));
}

export async function canonicalEpisodeTargets(db: Reader, sourceId: string): Promise<string[]> {
  return (await canonicalEpisodeTargetMap(db, [sourceId])).get(sourceId)!;
}
export async function canonicalEpisodeAliasTargets(
  db: Reader & Pick<PrismaClient | Prisma.TransactionClient, 'episodeExternalId'>,
  provider: string,
  value: string,
): Promise<string[]> {
  const recorded = await canonicalEpisodeTargets(db, episodeAliasKey(provider, value));
  if (recorded.length) return recorded;
  const alias = await db.episodeExternalId.findFirst({
    where: { provider: provider as any, providerEntityKind: 'EPISODE', value },
    select: { episodeId: true },
  });
  return alias ? canonicalEpisodeTargets(db, alias.episodeId) : [];
}

export function importEpisodeAliasKeys(item: any): string[] {
  const normalized = item.normalizedData ?? {},
    raw = item.rawData ?? {};
  const tvdb =
    normalized.externalEpisodeId ??
    normalized.episodeIds?.tvdb ??
    raw.externalEpisodeId ??
    raw.rawTvdbEpisodeId ??
    raw.tvdbEpisodeId ??
    raw.episodeIds?.tvdb;
  const tmdb = normalized.episodeIds?.tmdb ?? raw.episodeIds?.tmdb;
  return [
    ...(tvdb != null && /^\d+$/.test(String(tvdb))
      ? [episodeAliasKey('THE_TVDB', String(tvdb))]
      : []),
    ...(tmdb != null && /^\d+$/.test(String(tmdb)) ? [episodeAliasKey('TMDB', String(tmdb))] : []),
  ];
}

/** Durable alias anchors and local edges are committed with the actual protected-data transfer. */
export async function recordEpisodeRemap(
  tx: Prisma.TransactionClient,
  sourceId: string,
  targetIds: string[],
  aliases: Array<{ provider: string; value: string }>,
  version: number,
  localEdges = true,
) {
  const targets = [...new Set(targetIds)].filter((id) => id !== sourceId);
  if (!targets.length && localEdges) return;
  const evidence = {
    kind: 'verified-episode-remap',
    version,
    sourceEpisodeId: sourceId,
    targetEpisodeIds: targets.length ? targets : [sourceId],
    aliases,
    at: new Date().toISOString(),
  };
  const entries: Array<{ kind: string; id: string; targets: string[] }> = [
    ...(localEdges ? [{ kind: 'EPISODE', id: sourceId, targets }] : []),
    ...aliases.map((alias) => ({
      kind: 'EPISODE_ALIAS',
      id: episodeAliasKey(alias.provider, alias.value),
      targets: [sourceId],
    })),
  ];
  for (const entry of entries) {
    const primaryKey = createHash('sha256')
      .update(entry.kind + ':' + entry.id)
      .digest('hex');
    if (await tx.mediaCanonicalCopy.findUnique({ where: { mappingKey: primaryKey } })) continue;
    for (const [index, targetId] of entry.targets.entries()) {
      const entityType = entry.kind + (index ? ':split:' + targetId : '');
      const mappingKey = index
        ? createHash('sha256')
            .update(entityType + ':' + entry.id)
            .digest('hex')
        : primaryKey;
      await tx.mediaCanonicalCopy.upsert({
        where: { mappingKey },
        create: { mappingKey, entityType, sourceId: entry.id, targetId, evidence },
        update: {},
      });
    }
  }
}
