import {
  BadRequestException,
  ConflictException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from './roles.guard';
import { RequireRoles } from './roles.decorator';
import { AdminService } from './admin.service';
import { CronManagerService } from './cron-manager.service';
import { ModerationService } from '../social/moderation.service';
import { MetadataBackfillService } from '../media-metadata/metadata-backfill.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AdminImportService } from './admin-import.service';
import { MediaCanonicalizationService } from '../media-metadata/media-canonicalization.service';
import { IdentityBacklogService } from '../media-metadata/identity-backlog.service';
import { StructureBackfillService } from '../media-metadata/structure-backfill.service';
import { IdentityRepairSweepService } from '../media-metadata/identity-repair-sweep.service';
import {
  IDENTITY_SAMPLE_KINDS,
  IdentityHealthAuditService,
  type IdentitySampleKind,
} from '../media-metadata/identity-health-audit.service';

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('admin')
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly cron: CronManagerService,
    private readonly moderation: ModerationService,
    private readonly metadataBackfill: MetadataBackfillService,
    private readonly adminImports: AdminImportService,
    private readonly mediaCanonicalization: MediaCanonicalizationService,
    private readonly identityBacklog: IdentityBacklogService,
    private readonly structureBackfill: StructureBackfillService,
    private readonly identityAudit: IdentityHealthAuditService,
    private readonly identitySweep: IdentityRepairSweepService,
  ) {}

  // ---------------- Dashboard ----------------
  @Get('stats')
  @RequireRoles('VIEWER')
  getStats() {
    return this.admin.getStats();
  }

  // ---------------- Provider status (multi-provider console) ----------------
  @Get('providers')
  @RequireRoles('ADMIN')
  getProviderStatus() {
    return this.admin.getProviderStatus();
  }

  // ---------------- Metadata health + backfill ----------------
  @Get('metadata-health')
  @RequireRoles('ADMIN')
  getMetadataHealth(
    @Query('content') content?: string,
    @Query('deep') deep?: string,
    @Query('refresh') refresh?: string,
  ) {
    const includeDeep = deep === '1' || deep === 'true';
    const includeContent = includeDeep || content === '1' || content === 'true';
    return this.metadataBackfill.getHealthStats(includeContent, includeDeep, {
      backgroundOnMiss: true,
      refresh: refresh === '1' || refresh === 'true',
    });
  }

  /** Live progress of every running (or recently finished) metadata repair job. */
  @Get('metadata-health/repair-progress')
  @RequireRoles('ADMIN')
  getRepairProgress() {
    return this.metadataBackfill.getRepairProgress();
  }

  @Post('metadata-backfill/run')
  @RequireRoles('ADMIN')
  runMetadataBackfill(@Query('count') count?: string, @Query('rps') rps?: string) {
    const n = count ? Number(count) : undefined;
    const r = rps ? Number(rps) : undefined;
    this.metadataBackfill.backfillBatch(n, r).catch(() => undefined);
    return {
      message: `Backfill started (${n ?? 200} items, ${r ? r + ' items/s' : 'full speed'}). Check API logs.`,
    };
  }

  /**
   * Duplicate-cast repair. mode=report (default, counts only), dry-run (exact counts,
   * rolled back), repair (commits high-confidence merges; votes are re-pointed before
   * any row is deleted). With mediaId the run is targeted, awaited, and audited.
   */
  @Post('cast-dedup/run')
  @RequireRoles('ADMIN')
  async runCastDedup(
    @CurrentUser('id') adminId: string,
    @Query('mode') mode?: string,
    @Query('mediaId') mediaId?: string,
  ) {
    if (!mediaId)
      throw new BadRequestException('mediaId is required (batches run in metadata_completeness)');
    const m = mode === 'dry-run' || mode === 'repair' ? mode : 'report';
    const result = await this.metadataBackfill.repairCastDuplicates({ mode: m, mediaId });
    await this.admin.audit(adminId, 'cast_dedup', 'media', mediaId, {
      mode: m,
      merged: result.merged,
      votesMoved: result.votesMoved,
      rowsDeleted: result.rowsDeleted,
    });
    return result;
  }

  /**
   * Manually merge ONE reviewed duplicate cast pair (the report's name-only/MEDIUM
   * cases — e.g. "Matt Murdock" vs "Matt Murdock / Daredevil"). keepCastId survives;
   * votes on mergeCastId are re-pointed before its row is deleted. Awaited + audited.
   */
  @Post('cast-dedup/merge')
  @RequireRoles('ADMIN')
  async mergeCastPair(
    @CurrentUser('id') adminId: string,
    @Body() body: { mediaId?: string; keepCastId?: string; mergeCastId?: string },
  ) {
    if (!body?.mediaId || !body?.keepCastId || !body?.mergeCastId) {
      throw new BadRequestException('mediaId, keepCastId and mergeCastId are required');
    }
    if (body.keepCastId === body.mergeCastId) {
      throw new BadRequestException('keepCastId and mergeCastId must differ');
    }
    const result = await this.metadataBackfill.mergeCastPair(
      body.mediaId,
      body.keepCastId,
      body.mergeCastId,
    );
    await this.admin.audit(adminId, 'cast_dedup_merge', 'media', body.mediaId, {
      keepCastId: body.keepCastId,
      mergeCastId: body.mergeCastId,
      ...result,
    });
    return result;
  }

  /**
   * Season/episode structure reconciliation (mixed-provider structures, e.g. Dragon
   * Ball's flattened TMDB structure surviving next to the TVDB split). mode=report
   * (default), dry-run (matcher only), repair (canonical-owner hydration/remap). One title,
   * awaited and audited; the identity_maintenance job repairs the backlog.
   */
  @Post('structure-reconcile/run')
  @RequireRoles('ADMIN')
  async runStructureReconcile(
    @CurrentUser('id') adminId: string,
    @Query('mode') mode?: string,
    @Query('mediaId') mediaId?: string,
  ) {
    if (!mediaId)
      throw new BadRequestException('mediaId is required (batches run in identity_maintenance)');
    const m = mode === 'dry-run' || mode === 'repair' ? mode : 'report';
    const result = await this.metadataBackfill.reconcileStructures({ mode: m, mediaId });
    await this.admin.audit(adminId, 'structure_reconcile', 'media', mediaId, {
      mode: m,
      repaired: result.repaired,
      remapped: result.remapped,
    });
    return result;
  }

  /**
   * One title through one step of the nightly identity maintenance, synchronously: verified
   * repair of inconsistent ids, the crosswalk backlog, or the structure authority backfill.
   * dry-run reports what the job would do; apply writes it (audited). Batches run only in the
   * identity_maintenance job.
   */
  @Post('identity/title-run')
  @RequireRoles('ADMIN')
  async runIdentityForTitle(
    @CurrentUser('id') adminId: string,
    @Query('tool') tool?: string,
    @Query('mode') mode?: string,
    @Query('mediaId') mediaId?: string,
  ) {
    if (!mediaId) throw new BadRequestException('mediaId is required');
    const m = mode === 'apply' ? 'apply' : 'dry-run';
    const report =
      tool === 'repair'
        ? await this.identitySweep.run({ mode: m, mediaId, limit: 1 })
        : tool === 'backlog'
          ? await this.identityBacklog.run({ mode: m, mediaId, limit: 1, watchforge: true })
          : tool === 'structure'
            ? await this.structureBackfill.run({ mode: m, mediaId, limit: 1 })
            : null;
    if (!report) throw new BadRequestException('tool must be repair, backlog or structure');
    if (m === 'apply')
      await this.admin.audit(adminId, `identity_${tool}_title`, 'media', mediaId, {
        processed: report.processed,
        counts: report.counts,
      });
    return report;
  }

  /** Identity scoreboard: latest vs previous audit snapshot and the identity jobs' state. */
  @Get('identity/overview')
  @RequireRoles('ADMIN')
  getIdentityOverview() {
    return this.identityAudit.overview();
  }

  /** Take a read-only audit snapshot now (stored in the identity_audit job history). */
  @Post('identity/audit/run')
  @RequireRoles('ADMIN')
  async runIdentityAudit() {
    await this.identityAudit.recordSnapshot();
    return this.identityAudit.overview();
  }

  /** The actual rows behind one identity metric, users first (read-only). */
  @Get('identity/samples')
  @RequireRoles('ADMIN')
  getIdentitySamples(@Query('kind') kind?: string, @Query('limit') limit?: string) {
    if (!IDENTITY_SAMPLE_KINDS.includes(kind as IdentitySampleKind))
      throw new BadRequestException(`kind must be one of ${IDENTITY_SAMPLE_KINDS.join(', ')}`);
    return this.identityAudit.samples(kind as IdentitySampleKind, Number(limit) || 50);
  }

  @Get('media-canonicalization/stats')
  @RequireRoles('ADMIN')
  getMediaCanonicalizationStats() {
    return this.mediaCanonicalization.getStats();
  }

  /**
   * Detect/consolidate exact duplicates and TMDB season-components around a TVDB aggregate.
   * The repair is copy-only and sources stay visible until the verification gate activates
   * their redirect. Every run is detached from the request and reported through the shared
   * Metadata Health progress endpoint so provider work cannot hit the HTTP timeout.
   */
  @Post('media-canonicalization/run')
  @RequireRoles('ADMIN')
  runMediaCanonicalization(
    @CurrentUser('id') adminId: string,
    @Query('mode') mode?: string,
    @Query('count') count?: string,
    @Query('mediaId') mediaId?: string,
    @Query('cursor') cursor?: string,
  ) {
    const m = mode === 'repair' ? 'repair' : 'dry-run';
    const n = count ? Number(count) : undefined;
    const requestedCount = Number(n ?? 25);
    const expectedTotal = mediaId
      ? 1
      : Number.isFinite(requestedCount)
        ? Math.max(1, Math.min(Math.floor(requestedCount), 100))
        : 25;
    const job = 'media-canonicalization';
    const started = this.metadataBackfill.startRepairProgress(job, {
      total: expectedTotal,
      current: mediaId ?? `Preparing ${m} batch`,
    });
    if (!started) {
      return {
        started: false,
        message: 'Media canonicalization is already running. Watch Repair progress.',
      };
    }

    let processed = 0;
    let total = expectedTotal;
    let candidates = 0;
    let activated = 0;
    let blocked = 0;
    void this.mediaCanonicalization
      .run({
        mode: m,
        mediaId,
        count: n,
        cursor,
        onProgress: (progress) => {
          processed = progress.processed;
          total = progress.total;
          candidates = progress.candidates;
          activated = progress.activated;
          blocked = progress.blocked;
          this.metadataBackfill.updateRepairProgress(job, {
            ...progress,
            succeeded: progress.processed,
            failed: 0,
          });
        },
      })
      .then((result) => {
        this.metadataBackfill.finishRepairProgress(job, {
          processed: result.scanned,
          total: result.scanned,
          succeeded: result.scanned,
          failed: 0,
          candidates: result.candidates,
          activated: result.activated,
          blocked: result.blocked,
          current: result.nextCursor
            ? `Completed; next cursor ${result.nextCursor}`
            : 'Completed; end of pass',
          report: { ...result, targeted: Boolean(mediaId) },
        });
        // Repairs activate redirects, so batch repairs are audited as well as targeted runs.
        if (mediaId || m === 'repair') {
          this.admin
            .audit(adminId, 'media_canonicalization', mediaId ? 'media' : undefined, mediaId, {
              mode: m,
              scanned: result.scanned,
              nextCursor: result.nextCursor,
              candidates: result.candidates,
              activated: result.activated,
              blocked: result.blocked,
            })
            .catch((error) => {
              console.error(
                '[Media Canonicalization] audit FAILED:',
                (error as Error)?.message ?? error,
              );
            });
        }
      })
      .catch((error) => {
        this.metadataBackfill.finishRepairProgress(job, {
          processed,
          total,
          succeeded: processed,
          failed: 1,
          candidates,
          activated,
          blocked,
          current: `Failed: ${(error as Error)?.message ?? error}`,
        });
        console.error('[Media Canonicalization] FAILED:', (error as Error)?.message ?? error);
      });
    return {
      started: true,
      message: mediaId
        ? `Media canonicalization (${m}) started for ${mediaId}.`
        : `Media canonicalization (${m}) started (${expectedTotal} TVDB shows max).`,
    };
  }

  @Post('repair-provider-duplicate-comments/run')
  @RequireRoles('ADMIN')
  async runRepairProviderDuplicateComments(
    @CurrentUser('id') adminId: string,
    @Query('source') source?: string,
    @Query('target') target?: string,
  ) {
    if (!source || !target || source === target) {
      throw new BadRequestException('source and target media ids are required and must differ');
    }
    const result = await this.metadataBackfill.repairMergedMovieThreadComments(source, target);
    await this.admin.audit(adminId, 'repair_provider_duplicate_comments', 'media', target, {
      source,
      ...result,
    });
    return result;
  }

  @Post('repair-movie-thread-self-attachments/run')
  @RequireRoles('ADMIN')
  async runRepairMovieThreadSelfAttachments(
    @CurrentUser('id') adminId: string,
    @Query('target') target?: string,
  ) {
    if (!target) throw new BadRequestException('target media id is required');
    const result = await this.metadataBackfill.clearMovieThreadSelfAttachments(target);
    await this.admin.audit(adminId, 'repair_movie_thread_self_attachments', 'media', target, {
      ...result,
    });
    return result;
  }

  @Post('repair-english-content/run')
  @RequireRoles('ADMIN')
  runRepairEnglishContent(@Query('count') count?: string, @Query('deep') deep?: string) {
    const n = count ? Number(count) : undefined;
    const d = deep === '1' || deep === 'true';
    this.metadataBackfill.repairNonEnglishContent(n, d).catch((e) => {
      console.error('[English content repair] FAILED:', (e as Error)?.message ?? e);
    });
    return {
      message: `English-content verify+repair started (${n ?? 200} rows${d ? ', deep scan' : ''}). Check API logs for progress + results.`,
    };
  }

  @Post('repair-english-content/one')
  @RequireRoles('ADMIN')
  async runRepairOneEnglishContent(
    @CurrentUser('id') adminId: string,
    @Query('mediaId') mediaId?: string,
  ) {
    if (!mediaId) throw new BadRequestException('mediaId is required');
    const result = await this.metadataBackfill.repairOneEnglishContent(mediaId);
    await this.admin.audit(adminId, 'repair_english_content_one', 'media', mediaId, {
      ...result,
    });
    return result;
  }

  @Post('repair-banner-posters/run')
  @RequireRoles('ADMIN')
  runRepairBannerPosters(@Query('count') count?: string) {
    const n = count ? Number(count) : undefined;
    this.metadataBackfill.repairBannerPosters(n).catch((e) => {
      console.error('[Banner poster repair] FAILED:', (e as Error)?.message ?? e);
    });
    return {
      message: `Banner-poster repair started (${n ?? 500} rows max). Check API logs for progress + results.`,
    };
  }

  @Post('tmdb-changes/run')
  @RequireRoles('ADMIN')
  runTmdbChanges(@Query('start') start?: string) {
    this.metadataBackfill.syncTmdbChanges(start).catch((e) => {
      // Log the error so the admin can see it in API logs (fire-and-forget otherwise swallows).
      console.error('[TMDB Changes Sync] FAILED:', (e as Error)?.message ?? e);
    });
    return {
      message: start
        ? `TMDB changes sync (custom range from ${start}) started in background. Check API logs for progress + results.`
        : 'TMDB changes sync started in background. Check API logs for progress + results.',
    };
  }

  @Get('charts')
  @RequireRoles('VIEWER')
  getCharts() {
    return this.admin.getCharts();
  }

  // ---------------- Media ----------------
  @Get('media')
  @RequireRoles('VIEWER')
  getMedia(@Query() q: any) {
    return this.admin.getMedia(q);
  }

  @Get('media/:id')
  @RequireRoles('VIEWER')
  getMediaDetail(@Param('id') id: string) {
    return this.admin.getMediaDetail(id);
  }

  // ---------------- Users ----------------
  @Get('users')
  @RequireRoles('SUPPORT')
  getUsers(@Query() q: any) {
    return this.admin.getUsers(q);
  }

  @Get('users/:id')
  @RequireRoles('SUPPORT')
  getUserDetail(@Param('id') id: string) {
    return this.admin.getUserDetail(id);
  }

  @Patch('users/:id')
  @RequireRoles('ADMIN')
  updateUser(
    @CurrentUser('id') adminId: string,
    @Param('id') id: string,
    @Body() dto: { role?: string; isSuspended?: boolean },
  ) {
    return this.admin.updateUser(adminId, id, dto);
  }

  @Delete('users/:id')
  @RequireRoles('ADMIN')
  deleteUser(
    @CurrentUser('id') adminId: string,
    @Param('id') id: string,
    @Body() body: { confirmUsername?: string },
  ) {
    return this.admin.deleteUser(adminId, id, body?.confirmUsername ?? '');
  }

  @Post('users/:id/test-push')
  @RequireRoles('ADMIN')
  testPush(
    @CurrentUser('id') adminId: string,
    @Param('id') id: string,
    @Body() body: { movieId?: string },
  ) {
    return this.admin.sendTestPush(adminId, id, body);
  }

  // ---------------- User imports ----------------
  @Get('imports')
  @RequireRoles('ADMIN')
  listImports(@Query() q: any) {
    return this.adminImports.list({
      search: q.search,
      status: q.status,
      page: q.page ? Number(q.page) : 1,
      pageSize: q.pageSize ? Number(q.pageSize) : 50,
    });
  }

  @Get('imports/:id')
  @RequireRoles('ADMIN')
  getImport(@Param('id') id: string) {
    return this.adminImports.detail(id);
  }

  @Get('imports/:id/items')
  @RequireRoles('ADMIN')
  getImportItems(@Param('id') id: string, @Query() q: any) {
    return this.adminImports.items(id, {
      status: q.status,
      entity: q.entity,
      page: q.page ? Number(q.page) : 1,
      pageSize: q.pageSize ? Number(q.pageSize) : 500,
    });
  }

  @Patch('imports/:id/items/:itemId')
  @RequireRoles('ADMIN')
  patchImportItem(
    @CurrentUser('id') adminId: string,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() body: { matchedMediaId?: string; userResolution?: string },
  ) {
    return this.adminImports.patchItem(adminId, id, itemId, body);
  }

  @Post('imports/:id/resolve-episodes')
  @RequireRoles('ADMIN')
  resolveImportEpisodes(
    @CurrentUser('id') adminId: string,
    @Param('id') id: string,
    @Body() body: { matchedMediaId: string; sourceTitle: string; season?: number | null },
  ) {
    return this.adminImports.resolveEpisodes(adminId, id, body);
  }

  @Post('imports/:id/auto-resolve')
  @RequireRoles('ADMIN')
  autoResolveImport(
    @CurrentUser('id') adminId: string,
    @Param('id') id: string,
    @Body() body: { status?: string; entity?: string },
  ) {
    return this.adminImports.autoResolve(adminId, id, body ?? {});
  }

  @Post('imports/:id/confirm')
  @RequireRoles('ADMIN')
  confirmImport(@CurrentUser('id') adminId: string, @Param('id') id: string) {
    return this.adminImports.confirm(adminId, id);
  }

  // ---------------- Admins ----------------
  @Get('admins')
  @RequireRoles('ADMIN')
  getAdmins() {
    return this.admin.getAdmins();
  }

  // ---------------- Hydration Jobs ----------------
  @Post('jobs/hydrate')
  @RequireRoles('CONTENT_MANAGER')
  triggerHydration(
    @CurrentUser('id') adminId: string,
    @Body() body: { type: string; tmdbId?: number; pages?: number },
  ) {
    return this.admin.triggerHydration(adminId, body.type, {
      tmdbId: body.tmdbId,
      pages: body.pages,
    });
  }

  @Get('jobs')
  @RequireRoles('VIEWER')
  getJobs(@Query() q: any) {
    return this.admin.getJobs(q);
  }

  @Get('jobs/:id')
  @RequireRoles('VIEWER')
  getJobDetail(@Param('id') id: string) {
    return this.admin.getJobDetail(id);
  }

  @Post('jobs/:id/cancel')
  @RequireRoles('CONTENT_MANAGER')
  cancelJob(@CurrentUser('id') adminId: string, @Param('id') id: string) {
    return this.admin.cancelJob(adminId, id);
  }

  @Post('jobs/:id/retry')
  @RequireRoles('CONTENT_MANAGER')
  retryJob(@CurrentUser('id') adminId: string, @Param('id') id: string) {
    return this.admin.retryJob(adminId, id);
  }

  // ---------------- Audit Logs ----------------
  @Get('audit-logs')
  @RequireRoles('ADMIN')
  getAuditLogs(@Query() q: any) {
    return this.admin.getAuditLogs(q);
  }

  // ---------------- Feature Flags ----------------
  @Get('feature-flags')
  @RequireRoles('ADMIN')
  getFeatureFlags() {
    return this.admin.getFeatureFlags();
  }

  @Patch('feature-flags')
  @RequireRoles('ADMIN')
  updateFeatureFlag(
    @CurrentUser('id') adminId: string,
    @Body() body: { key: string; value: boolean },
  ) {
    return this.admin.updateFeatureFlag(adminId, body.key, body.value);
  }

  // ---------------- Cron Jobs ----------------
  @Get('cron')
  @RequireRoles('VIEWER')
  getCronJobs() {
    return this.cron.getAll();
  }

  @Get('cron/:name/history')
  @RequireRoles('VIEWER')
  getCronHistory(@Param('name') name: string, @Query('page') page?: string) {
    return this.cron.getHistory(name, page ? Number(page) : 1);
  }

  @Patch('cron/:name')
  @RequireRoles('ADMIN')
  updateCronJob(
    @CurrentUser('id') adminId: string,
    @Param('name') name: string,
    @Body()
    body: { schedule?: string; enabled?: boolean; timezone?: string | null; config?: unknown },
  ) {
    return this.cron.update(adminId, name, body);
  }

  @Post('cron/:name/trigger')
  @RequireRoles('CONTENT_MANAGER')
  triggerCronJob(@CurrentUser('id') adminId: string, @Param('name') name: string) {
    return this.cron.triggerNow(adminId, name);
  }

  // ---------------- Settings ----------------
  @Get('settings')
  @RequireRoles('ADMIN')
  getSettings() {
    return this.admin.getSettings();
  }

  @Get('settings/:key')
  @RequireRoles('SUPER_ADMIN')
  getSettingValue(@Param('key') key: string) {
    return this.admin.getSettingValue(key);
  }

  @Patch('settings/:key')
  @RequireRoles('SUPER_ADMIN')
  updateSetting(
    @CurrentUser('id') adminId: string,
    @Param('key') key: string,
    @Body() body: { value: string; encrypted: boolean },
  ) {
    return this.admin.updateSetting(adminId, key, body.value, body.encrypted);
  }

  // ---------------- Scheduled Hydrations ----------------
  @Get('scheduled-hydrations')
  @RequireRoles('VIEWER')
  getScheduledHydrations() {
    return this.admin.getScheduledHydrations();
  }

  @Post('scheduled-hydrations')
  @RequireRoles('ADMIN')
  createScheduledHydration(
    @CurrentUser('id') adminId: string,
    @Body()
    body: {
      type: string;
      label: string;
      schedule: string;
      timezone?: string | null;
      pages?: number;
      enabled?: boolean;
      config?: unknown;
    },
  ) {
    return this.admin.createScheduledHydration(body);
  }

  @Patch('scheduled-hydrations/:id')
  @RequireRoles('ADMIN')
  updateScheduledHydration(
    @Param('id') id: string,
    @Body()
    body: {
      schedule?: string;
      pages?: number;
      enabled?: boolean;
      timezone?: string | null;
      config?: unknown;
    },
  ) {
    return this.admin.updateScheduledHydration(id, body);
  }

  @Delete('scheduled-hydrations/:id')
  @RequireRoles('ADMIN')
  deleteScheduledHydration(@Param('id') id: string) {
    return this.admin.deleteScheduledHydration(id);
  }

  @Post('scheduled-hydrations/:id/trigger')
  @RequireRoles('CONTENT_MANAGER')
  triggerScheduledHydration(@CurrentUser('id') adminId: string, @Param('id') id: string) {
    return this.cron.triggerScheduledHydration(adminId, id);
  }

  // ---------------- Moderation ----------------
  @Get('moderation/reported-comments')
  @RequireRoles('MODERATOR')
  reportedComments(@Query('page') page = '1', @Query('pageSize') pageSize = '20') {
    return this.moderation.reportedComments(parseInt(page), parseInt(pageSize));
  }

  @Get('moderation/reported-images')
  @RequireRoles('MODERATOR')
  reportedImages(@Query('page') page = '1', @Query('pageSize') pageSize = '20') {
    return this.moderation.reportedImages(parseInt(page), parseInt(pageSize));
  }

  @Get('moderation/reported-users')
  @RequireRoles('MODERATOR')
  reportedUsers(@Query('page') page = '1', @Query('pageSize') pageSize = '20') {
    return this.moderation.reportedUsers(parseInt(page), parseInt(pageSize));
  }

  @Delete('moderation/comments/:id')
  @RequireRoles('MODERATOR')
  deleteComment(@Param('id') id: string) {
    return this.moderation.deleteComment(id);
  }

  @Post('moderation/dismiss')
  @RequireRoles('MODERATOR')
  dismissReports(@Body() body: { targetType: string; targetId: string }) {
    return this.moderation.dismissReports(body.targetType as any, body.targetId);
  }

  // ---------------- Announcements ----------------
  @Get('announcements')
  @RequireRoles('ADMIN')
  listAnnouncements() {
    return this.admin.listAnnouncements();
  }

  @Post('announcements')
  @RequireRoles('ADMIN')
  createAnnouncement(@CurrentUser('id') adminId: string, @Body() dto: any) {
    return this.admin.createAnnouncement(adminId, dto);
  }

  @Patch('announcements/:id')
  @RequireRoles('ADMIN')
  updateAnnouncement(
    @CurrentUser('id') adminId: string,
    @Param('id') id: string,
    @Body() dto: any,
  ) {
    return this.admin.updateAnnouncement(adminId, id, dto);
  }

  @Delete('announcements/:id')
  @RequireRoles('ADMIN')
  deleteAnnouncement(@CurrentUser('id') adminId: string, @Param('id') id: string) {
    return this.admin.deleteAnnouncement(adminId, id);
  }

  @Post('announcements/:id/activate')
  @RequireRoles('ADMIN')
  activateAnnouncement(
    @CurrentUser('id') adminId: string,
    @Param('id') id: string,
    @Body() body: { alsoPush?: boolean },
  ) {
    return this.admin.activateAnnouncement(adminId, id, !!body.alsoPush);
  }

  @Post('announcements/:id/deactivate')
  @RequireRoles('ADMIN')
  deactivateAnnouncement(@CurrentUser('id') adminId: string, @Param('id') id: string) {
    return this.admin.deactivateAnnouncement(adminId, id);
  }

  @Post('announcements/:id/reshow')
  @RequireRoles('ADMIN')
  reshowAnnouncement(@CurrentUser('id') adminId: string, @Param('id') id: string) {
    return this.admin.reshowAnnouncement(adminId, id);
  }

  @Post('announcements/:id/push')
  @RequireRoles('ADMIN')
  sendAnnouncementPush(@CurrentUser('id') adminId: string, @Param('id') id: string) {
    return this.admin.sendAnnouncementPush(adminId, id);
  }

  // ---------------- Broadcasts ----------------
  @Get('broadcasts')
  @RequireRoles('ADMIN')
  listBroadcasts() {
    return this.admin.listBroadcasts();
  }

  @Get('broadcasts/:id')
  @RequireRoles('ADMIN')
  getBroadcast(@Param('id') id: string) {
    return this.admin.getBroadcast(id);
  }

  @Post('broadcasts')
  @RequireRoles('ADMIN')
  createBroadcast(@CurrentUser('id') adminId: string, @Body() dto: any) {
    return this.admin.createBroadcast(adminId, dto);
  }

  // ---------------- Contact threads ----------------
  @Get('contacts')
  @RequireRoles('SUPPORT')
  listContacts(@Query() q: any) {
    return this.admin.listContacts(q);
  }

  @Get('contacts/:id')
  @RequireRoles('SUPPORT')
  getContact(@Param('id') id: string) {
    return this.admin.getContact(id);
  }

  @Post('contacts/:id/messages')
  @RequireRoles('SUPPORT')
  replyContact(
    @CurrentUser('id') adminId: string,
    @Param('id') id: string,
    @Body() body: { body: string },
  ) {
    return this.admin.replyContact(adminId, id, body.body);
  }

  @Post('contacts/:id/close')
  @RequireRoles('SUPPORT')
  closeContact(@CurrentUser('id') adminId: string, @Param('id') id: string) {
    return this.admin.closeContact(adminId, id);
  }

  @Post('contacts/:id/reopen')
  @RequireRoles('SUPPORT')
  reopenContact(@CurrentUser('id') adminId: string, @Param('id') id: string) {
    return this.admin.reopenContact(adminId, id);
  }
}
