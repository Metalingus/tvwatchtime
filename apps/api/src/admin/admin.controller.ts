import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from './roles.guard';
import { RequireRoles } from './roles.decorator';
import { AdminService } from './admin.service';
import { CronManagerService } from './cron-manager.service';
import { ModerationService } from '../social/moderation.service';
import { MetadataBackfillService } from '../media-metadata/metadata-backfill.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';

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
  ) {}

  // ---------------- Dashboard ----------------
  @Get('stats')
  @RequireRoles('VIEWER')
  getStats() { return this.admin.getStats(); }

  // ---------------- Provider status (multi-provider console) ----------------
  @Get('providers')
  @RequireRoles('ADMIN')
  getProviderStatus() { return this.admin.getProviderStatus(); }

  // ---------------- Metadata health + backfill ----------------
  @Get('metadata-health')
  @RequireRoles('ADMIN')
  getMetadataHealth() { return this.metadataBackfill.getHealthStats(); }

  @Post('metadata-backfill/run')
  @RequireRoles('ADMIN')
  runMetadataBackfill() { return this.metadataBackfill.backfillBatch(); }

  @Get('charts')
  @RequireRoles('VIEWER')
  getCharts() { return this.admin.getCharts(); }

  // ---------------- Media ----------------
  @Get('media')
  @RequireRoles('VIEWER')
  getMedia(@Query() q: any) { return this.admin.getMedia(q); }

  @Get('media/:id')
  @RequireRoles('VIEWER')
  getMediaDetail(@Param('id') id: string) { return this.admin.getMediaDetail(id); }

  // ---------------- Users ----------------
  @Get('users')
  @RequireRoles('SUPPORT')
  getUsers(@Query() q: any) { return this.admin.getUsers(q); }

  @Get('users/:id')
  @RequireRoles('SUPPORT')
  getUserDetail(@Param('id') id: string) { return this.admin.getUserDetail(id); }

  @Patch('users/:id')
  @RequireRoles('ADMIN')
  updateUser(@CurrentUser('id') adminId: string, @Param('id') id: string, @Body() dto: { role?: string; isSuspended?: boolean }) {
    return this.admin.updateUser(adminId, id, dto);
  }

  @Post('users/:id/test-push')
  @RequireRoles('ADMIN')
  testPush(@CurrentUser('id') adminId: string, @Param('id') id: string) {
    return this.admin.sendTestPush(adminId, id);
  }

  // ---------------- Admins ----------------
  @Get('admins')
  @RequireRoles('ADMIN')
  getAdmins() { return this.admin.getAdmins(); }

  // ---------------- Hydration Jobs ----------------
  @Post('jobs/hydrate')
  @RequireRoles('CONTENT_MANAGER')
  triggerHydration(@CurrentUser('id') adminId: string, @Body() body: { type: string; tmdbId?: number; pages?: number }) {
    return this.admin.triggerHydration(adminId, body.type, { tmdbId: body.tmdbId, pages: body.pages });
  }

  @Get('jobs')
  @RequireRoles('VIEWER')
  getJobs(@Query() q: any) { return this.admin.getJobs(q); }

  @Get('jobs/:id')
  @RequireRoles('VIEWER')
  getJobDetail(@Param('id') id: string) { return this.admin.getJobDetail(id); }

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
  getAuditLogs(@Query() q: any) { return this.admin.getAuditLogs(q); }

  // ---------------- Feature Flags ----------------
  @Get('feature-flags')
  @RequireRoles('ADMIN')
  getFeatureFlags() { return this.admin.getFeatureFlags(); }

  @Patch('feature-flags')
  @RequireRoles('ADMIN')
  updateFeatureFlag(@CurrentUser('id') adminId: string, @Body() body: { key: string; value: boolean }) {
    return this.admin.updateFeatureFlag(adminId, body.key, body.value);
  }

  // ---------------- Cron Jobs ----------------
  @Get('cron')
  @RequireRoles('VIEWER')
  getCronJobs() { return this.cron.getAll(); }

  @Get('cron/:name/history')
  @RequireRoles('VIEWER')
  getCronHistory(@Param('name') name: string, @Query('page') page?: string) {
    return this.cron.getHistory(name, page ? Number(page) : 1);
  }

  @Patch('cron/:name')
  @RequireRoles('ADMIN')
  updateCronJob(@CurrentUser('id') adminId: string, @Param('name') name: string, @Body() body: { schedule?: string; enabled?: boolean }) {
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
  getSettings() { return this.admin.getSettings(); }

  @Get('settings/:key')
  @RequireRoles('SUPER_ADMIN')
  getSettingValue(@Param('key') key: string) { return this.admin.getSettingValue(key); }

  @Patch('settings/:key')
  @RequireRoles('SUPER_ADMIN')
  updateSetting(@CurrentUser('id') adminId: string, @Param('key') key: string, @Body() body: { value: string; encrypted: boolean }) {
    return this.admin.updateSetting(adminId, key, body.value, body.encrypted);
  }

  // ---------------- Scheduled Hydrations ----------------
  @Get('scheduled-hydrations')
  @RequireRoles('VIEWER')
  getScheduledHydrations() { return this.admin.getScheduledHydrations(); }

  @Post('scheduled-hydrations')
  @RequireRoles('ADMIN')
  createScheduledHydration(@CurrentUser('id') adminId: string, @Body() body: { type: string; label: string; schedule: string; pages?: number; enabled?: boolean }) {
    return this.admin.createScheduledHydration(body);
  }

  @Patch('scheduled-hydrations/:id')
  @RequireRoles('ADMIN')
  updateScheduledHydration(@Param('id') id: string, @Body() body: { schedule?: string; pages?: number; enabled?: boolean }) {
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
    return this.admin.triggerScheduledHydration(adminId, id);
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
  updateAnnouncement(@CurrentUser('id') adminId: string, @Param('id') id: string, @Body() dto: any) {
    return this.admin.updateAnnouncement(adminId, id, dto);
  }

  @Delete('announcements/:id')
  @RequireRoles('ADMIN')
  deleteAnnouncement(@CurrentUser('id') adminId: string, @Param('id') id: string) {
    return this.admin.deleteAnnouncement(adminId, id);
  }

  @Post('announcements/:id/activate')
  @RequireRoles('ADMIN')
  activateAnnouncement(@CurrentUser('id') adminId: string, @Param('id') id: string, @Body() body: { alsoPush?: boolean }) {
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
  replyContact(@CurrentUser('id') adminId: string, @Param('id') id: string, @Body() body: { body: string }) {
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
