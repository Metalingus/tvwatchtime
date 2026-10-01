import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';

/**
 * Read-only identity health snapshot. Every later identity milestone measures its exit
 * criteria against these counts, so each metric is a flat integer and the whole result
 * fits the CronJobRun.result budget (the daily `identity_audit` job persists it there).
 *
 * "live" media = not the source of an ACTIVE canonical link (redirected rows are resolved).
 * "_users" variants count only rows that carry user data.
 */
/** v2: type-contamination counts exclude merged-away (redirected) rows. */
export const IDENTITY_AUDIT_RULES_VERSION = 2;

const STATEMENT_TIMEOUT_MS = 120_000;

const LIVE = `NOT EXISTS (SELECT 1 FROM media_canonical_links l
  WHERE l.source_media_id = m.id AND l.status = 'ACTIVE')`;

const QUERIES: Prisma.Sql[] = [
  // Missing provider ids.
  Prisma.raw(`
    WITH ids AS (
      SELECT m.type, m.content_classification cc,
        EXISTS (SELECT 1 FROM external_ids e WHERE e.media_id = m.id AND e.provider = 'TMDB') tmdb,
        EXISTS (SELECT 1 FROM external_ids e WHERE e.media_id = m.id AND e.provider = 'THE_TVDB') tvdb,
        CASE WHEN m.type = 'SHOW'
          THEN EXISTS (SELECT 1 FROM user_show_status u WHERE u.media_id = m.id)
          ELSE EXISTS (SELECT 1 FROM user_movie_status u WHERE u.media_id = m.id)
            OR EXISTS (SELECT 1 FROM watch_history w WHERE w.media_id = m.id)
        END users
      FROM media_items m WHERE ${LIVE}
    )
    SELECT
      count(*) FILTER (WHERE type = 'SHOW') shows,
      count(*) FILTER (WHERE type = 'MOVIE') movies,
      count(*) FILTER (WHERE type = 'SHOW' AND NOT tmdb) shows_missing_tmdb,
      count(*) FILTER (WHERE type = 'SHOW' AND NOT tvdb) shows_missing_tvdb,
      count(*) FILTER (WHERE type = 'SHOW' AND NOT tmdb AND NOT tvdb) shows_without_provider_ids,
      count(*) FILTER (WHERE type = 'SHOW' AND cc = 'ANIME' AND NOT tvdb) anime_missing_tvdb,
      count(*) FILTER (WHERE type = 'SHOW' AND cc = 'ANIME' AND NOT tvdb AND users) anime_missing_tvdb_users,
      count(*) FILTER (WHERE type = 'MOVIE' AND NOT tmdb) movies_missing_tmdb,
      count(*) FILTER (WHERE type = 'MOVIE' AND NOT tmdb AND users) movies_missing_tmdb_users
    FROM ids`),
  // Several aliases for the same provider + kind on one live row.
  Prisma.raw(`
    SELECT count(*) multi_alias_media,
      count(*) FILTER (WHERE
        EXISTS (SELECT 1 FROM user_show_status u WHERE u.media_id = x.media_id)
        OR EXISTS (SELECT 1 FROM user_movie_status u WHERE u.media_id = x.media_id)
        OR EXISTS (SELECT 1 FROM watch_history w WHERE w.media_id = x.media_id)) multi_alias_media_users
    FROM (
      SELECT DISTINCT e.media_id FROM external_ids e
      WHERE e.provider_entity_kind IN ('SERIES', 'MOVIE')
        AND NOT EXISTS (SELECT 1 FROM media_canonical_links l
          WHERE l.source_media_id = e.media_id AND l.status = 'ACTIVE')
      GROUP BY e.media_id, e.provider, e.provider_entity_kind HAVING count(*) > 1
    ) x`),
  // Structural type contamination.
  Prisma.raw(`
    SELECT
      (SELECT count(*) FROM media_items m JOIN shows s ON s.media_id = m.id
        WHERE m.type = 'MOVIE' AND ${LIVE}) movie_rows_with_show_structure,
      (SELECT count(*) FROM media_items m JOIN movies v ON v.media_id = m.id
        WHERE m.type = 'SHOW' AND ${LIVE}) show_rows_with_movie_structure,
      (SELECT count(DISTINCT m.id) FROM media_items m JOIN external_ids e ON e.media_id = m.id
        WHERE ((m.type = 'MOVIE' AND e.provider_entity_kind = 'SERIES')
           OR (m.type = 'SHOW' AND e.provider_entity_kind = 'MOVIE')) AND ${LIVE}) wrong_kind_alias_media`),
  // Suspected cross-provider duplicates: a TVDB-only and a TMDB-only show with the same
  // normalized title within one year. A prioritization signal, never merge evidence.
  Prisma.raw(`
    WITH live AS (
      SELECT m.id, m.normalized_title nt, s.year_start y, m.content_classification cc,
        EXISTS (SELECT 1 FROM external_ids e WHERE e.media_id = m.id AND e.provider = 'TMDB') tmdb,
        EXISTS (SELECT 1 FROM external_ids e WHERE e.media_id = m.id AND e.provider = 'THE_TVDB') tvdb,
        EXISTS (SELECT 1 FROM user_show_status u WHERE u.media_id = m.id) users
      FROM media_items m JOIN shows s ON s.media_id = m.id
      WHERE m.type = 'SHOW' AND length(m.normalized_title) >= 3 AND ${LIVE}
    ), pairs AS (
      SELECT a.cc, a.users au, b.users bu FROM live a JOIN live b
        ON a.nt = b.nt AND a.id <> b.id AND abs(coalesce(a.y, 0) - coalesce(b.y, 0)) <= 1
      WHERE a.tvdb AND NOT a.tmdb AND b.tmdb AND NOT b.tvdb
    )
    SELECT
      count(*) FILTER (WHERE cc <> 'ANIME') dup_pairs_general,
      count(*) FILTER (WHERE cc <> 'ANIME' AND (au OR bu)) dup_pairs_general_users,
      count(*) FILTER (WHERE cc <> 'ANIME' AND au AND bu) dup_pairs_general_both_users,
      count(*) FILTER (WHERE cc = 'ANIME') dup_pairs_anime,
      count(*) FILTER (WHERE cc = 'ANIME' AND (au OR bu)) dup_pairs_anime_users,
      count(*) FILTER (WHERE cc = 'ANIME' AND au AND bu) dup_pairs_anime_both_users
    FROM pairs`),
  // Episode-structure authority.
  Prisma.raw(`
    SELECT
      count(*) FILTER (WHERE s.structure_provider IS NULL) shows_without_structure_authority,
      count(*) FILTER (WHERE s.structure_provider IS NULL AND EXISTS (
        SELECT 1 FROM user_show_status u WHERE u.media_id = s.media_id)) shows_without_structure_authority_users,
      count(*) FILTER (WHERE m.content_classification = 'ANIME'
        AND s.structure_reason IS DISTINCT FROM 'ANIME_TVDB') anime_not_anime_tvdb
    FROM shows s JOIN media_items m ON m.id = s.media_id
    WHERE ${LIVE}`),
  // Episode identity.
  Prisma.raw(`
    SELECT
      (SELECT count(*) FROM episodes WHERE structure_state = 'LEGACY_UNMAPPED') legacy_unmapped_episodes,
      (SELECT count(*) FROM episodes e WHERE e.structure_state = 'LEGACY_UNMAPPED'
        AND EXISTS (SELECT 1 FROM user_episode_status u WHERE u.episode_id = e.id)) legacy_unmapped_episodes_users,
      (SELECT count(*) FROM (SELECT episode_id FROM episode_external_ids WHERE provider = 'THE_TVDB'
        GROUP BY episode_id HAVING count(*) > 1) x) episodes_multi_tvdb_alias,
      (SELECT count(*) FROM media_canonical_links WHERE status = 'ACTIVE') canonical_links_active`),
];

export type IdentityAuditSnapshot = Record<string, number>;

/** Titles behind each audit metric, users first, so admins can see and check real rows. */
export const IDENTITY_SAMPLE_KINDS = [
  'duplicate-pairs',
  'multi-alias',
  'type-mismatch',
  'wrong-kind',
  'anime-missing-tvdb',
  'no-structure-authority',
  'legacy-unmapped',
] as const;
export type IdentitySampleKind = (typeof IDENTITY_SAMPLE_KINDS)[number];

export interface IdentitySampleRow {
  mediaId: string;
  title: string;
  type: string;
  users: number;
  detail: string | null;
  otherMediaId?: string | null;
  otherTitle?: string | null;
}

const USERS = (alias: string) => `(
  (SELECT count(*) FROM user_show_status u WHERE u.media_id = ${alias}.id)
  + (SELECT count(*) FROM user_movie_status u WHERE u.media_id = ${alias}.id))::int`;
const IDS = (
  alias: string,
) => `(SELECT string_agg(e.provider || ':' || e.provider_entity_kind || ':' || e.value, ', ' ORDER BY e.provider, e.value)
  FROM external_ids e WHERE e.media_id = ${alias}.id)`;

const SAMPLE_SQL: Record<IdentitySampleKind, string> = {
  'duplicate-pairs': `
    WITH live AS (
      SELECT m.id, m.title, m.normalized_title nt, s.year_start y, ${USERS('m')} users,
        EXISTS (SELECT 1 FROM external_ids e WHERE e.media_id = m.id AND e.provider = 'TMDB') tmdb,
        EXISTS (SELECT 1 FROM external_ids e WHERE e.media_id = m.id AND e.provider = 'THE_TVDB') tvdb
      FROM media_items m JOIN shows s ON s.media_id = m.id
      WHERE m.type = 'SHOW' AND length(m.normalized_title) >= 3 AND ${LIVE}
    )
    SELECT a.id "mediaId", a.title, 'SHOW' type, a.users + b.users users,
      'TVDB-only row vs TMDB-only row, year ' || coalesce(a.y::text, '?') || '/' || coalesce(b.y::text, '?') detail,
      b.id "otherMediaId", b.title "otherTitle"
    FROM live a JOIN live b ON a.nt = b.nt AND a.id <> b.id AND abs(coalesce(a.y, 0) - coalesce(b.y, 0)) <= 1
    WHERE a.tvdb AND NOT a.tmdb AND b.tmdb AND NOT b.tvdb
    ORDER BY (a.users > 0 AND b.users > 0) DESC, a.users + b.users DESC, a.title
    LIMIT $1`,
  'multi-alias': `
    SELECT m.id "mediaId", m.title, m.type::text type, ${USERS('m')} users, ${IDS('m')} detail
    FROM media_items m
    WHERE ${LIVE} AND EXISTS (SELECT 1 FROM external_ids e WHERE e.media_id = m.id
      AND e.provider_entity_kind IN ('SERIES', 'MOVIE')
      GROUP BY e.provider, e.provider_entity_kind HAVING count(*) > 1)
    ORDER BY users DESC, m.title LIMIT $1`,
  'type-mismatch': `
    SELECT m.id "mediaId", m.title, m.type::text type,
      ((SELECT count(*) FROM user_movie_status u WHERE u.media_id = m.id)
        + (SELECT count(*) FROM user_show_status u WHERE u.media_id = m.id))::int users,
      'MOVIE row also carries a show graph; ids: ' || coalesce(${IDS('m')}, '-') detail
    FROM media_items m JOIN shows s ON s.media_id = m.id
    WHERE m.type = 'MOVIE' AND ${LIVE}
    ORDER BY users DESC, m.title LIMIT $1`,
  'wrong-kind': `
    SELECT m.id "mediaId", m.title, m.type::text type, ${USERS('m')} users, ${IDS('m')} detail
    FROM media_items m
    WHERE EXISTS (SELECT 1 FROM external_ids e WHERE e.media_id = m.id AND (
      (m.type = 'MOVIE' AND e.provider_entity_kind = 'SERIES') OR (m.type = 'SHOW' AND e.provider_entity_kind = 'MOVIE')))
      AND ${LIVE}
    ORDER BY users DESC, m.title LIMIT $1`,
  'anime-missing-tvdb': `
    SELECT m.id "mediaId", m.title, 'SHOW' type, ${USERS('m')} users, ${IDS('m')} detail
    FROM media_items m
    WHERE m.type = 'SHOW' AND m.content_classification = 'ANIME' AND ${LIVE}
      AND NOT EXISTS (SELECT 1 FROM external_ids e WHERE e.media_id = m.id AND e.provider = 'THE_TVDB')
    ORDER BY users DESC, m.title LIMIT $1`,
  'no-structure-authority': `
    SELECT m.id "mediaId", m.title, 'SHOW' type, ${USERS('m')} users, ${IDS('m')} detail
    FROM media_items m JOIN shows s ON s.media_id = m.id
    WHERE s.structure_provider IS NULL AND ${LIVE}
    ORDER BY users DESC, m.title LIMIT $1`,
  'legacy-unmapped': `
    SELECT m.id "mediaId", m.title, 'SHOW' type, ${USERS('m')} users,
      count(DISTINCT e.id) || ' legacy episode(s) with ' || count(ues.*) || ' user status row(s)' detail
    FROM media_items m JOIN shows s ON s.media_id = m.id JOIN seasons se ON se.show_id = s.id
      JOIN episodes e ON e.season_id = se.id AND e.structure_state = 'LEGACY_UNMAPPED'
      JOIN user_episode_status ues ON ues.episode_id = e.id
    WHERE ${LIVE}
    GROUP BY m.id, m.title
    ORDER BY count(ues.*) DESC, m.title LIMIT $1`,
};

const IDENTITY_JOBS = ['identity_audit', 'identity_maintenance'] as const;

const camel = (key: string) => key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

@Injectable()
export class IdentityHealthAuditService {
  private readonly logger = new Logger(IdentityHealthAuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Runs every audit query inside one READ ONLY transaction (consistent snapshot, no writes). */
  async run(): Promise<IdentityAuditSnapshot> {
    const startedAt = Date.now();
    const snapshot: IdentityAuditSnapshot = { rulesVersion: IDENTITY_AUDIT_RULES_VERSION };
    await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
        await tx.$queryRawUnsafe(
          `SELECT set_config('statement_timeout', '${STATEMENT_TIMEOUT_MS}', true)`,
        );
        for (const query of QUERIES) {
          const [row] = await tx.$queryRaw<Array<Record<string, bigint | number>>>(query);
          for (const [key, value] of Object.entries(row ?? {}))
            snapshot[camel(key)] = Number(value);
        }
      },
      { timeout: STATEMENT_TIMEOUT_MS * 2, maxWait: 10_000 },
    );
    snapshot.durationMs = Date.now() - startedAt;
    this.logger.log(`Identity audit completed in ${snapshot.durationMs}ms`);
    return snapshot;
  }

  /**
   * Run the audit now and store it in the `identity_audit` job history (even when the daily job
   * is disabled), so the admin scoreboard can compare against the previous snapshot.
   */
  async recordSnapshot(): Promise<IdentityAuditSnapshot> {
    const startedAt = new Date();
    const snapshot = await this.run();
    const job = await this.prisma.cronJob.findUnique({ where: { name: 'identity_audit' } });
    if (job) {
      await this.prisma.cronJobRun.create({
        data: {
          jobId: job.id,
          status: 'success',
          result: snapshot,
          durationMs: snapshot.durationMs ?? 0,
          startedAt,
          finishedAt: new Date(),
        },
      });
    }
    return snapshot;
  }

  /** Latest + previous audit snapshots and the identity jobs' state, for the admin scoreboard. */
  async overview() {
    const jobs = await this.prisma.cronJob.findMany({
      where: { name: { in: [...IDENTITY_JOBS] } },
      select: {
        id: true,
        name: true,
        label: true,
        enabled: true,
        schedule: true,
        lastRunAt: true,
        lastStatus: true,
        lastError: true,
      },
    });
    const runs = await Promise.all(
      jobs.map((job) =>
        this.prisma.cronJobRun.findMany({
          where: { jobId: job.id, status: 'success' },
          orderBy: { startedAt: 'desc' },
          take: job.name === 'identity_audit' ? 2 : 1,
          select: { startedAt: true, result: true, durationMs: true },
        }),
      ),
    );
    const byName = Object.fromEntries(
      jobs.map((job, i) => [job.name, { job, runs: runs[i] }]),
    ) as Record<string, { job: (typeof jobs)[number]; runs: (typeof runs)[number] }>;
    const auditRuns = byName.identity_audit?.runs ?? [];
    return {
      audit: {
        latest: (auditRuns[0]?.result as IdentityAuditSnapshot | null) ?? null,
        latestAt: auditRuns[0]?.startedAt ?? null,
        previous: (auditRuns[1]?.result as IdentityAuditSnapshot | null) ?? null,
        previousAt: auditRuns[1]?.startedAt ?? null,
      },
      jobs: IDENTITY_JOBS.map((name) => {
        const entry = byName[name];
        return {
          name,
          label: entry?.job.label ?? name,
          enabled: entry?.job.enabled ?? false,
          schedule: entry?.job.schedule ?? null,
          lastRunAt: entry?.job.lastRunAt ?? null,
          lastStatus: entry?.job.lastStatus ?? null,
          lastError: entry?.job.lastError ?? null,
          lastResult: (entry?.runs[0]?.result as Record<string, unknown> | null) ?? null,
        };
      }),
    };
  }

  /** The rows behind one audit metric (read-only), users first. */
  async samples(kind: IdentitySampleKind, limit = 50): Promise<IdentitySampleRow[]> {
    const sql = SAMPLE_SQL[kind];
    if (!sql) return [];
    const n = Math.max(1, Math.min(Math.floor(limit), 200));
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
        await tx.$queryRawUnsafe(
          `SELECT set_config('statement_timeout', '${STATEMENT_TIMEOUT_MS}', true)`,
        );
        return tx.$queryRawUnsafe<IdentitySampleRow[]>(sql, n);
      },
      { timeout: STATEMENT_TIMEOUT_MS * 2, maxWait: 10_000 },
    );
  }
}
