import { ConfigService } from '@nestjs/config';
import { CommsUniBackfillService } from './commsuni.backfill.service';
import { unseal } from './commsuni.crypto';
import { CommsUniBackfillApply, CommsUniBackfillRequest } from './commsuni.backfill.dto';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { IsIn } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../admin/roles.guard';
import { RequireRoles } from '../admin/roles.decorator';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { CommsUniClient } from './commsuni.client';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { object } from './commsuni.read.service';

class ReportDecision {
  @IsIn(['HIDDEN', 'DISMISSED']) state!: 'HIDDEN' | 'DISMISSED';
}

@Controller('admin/commsuni')
@UseGuards(JwtAuthGuard, RolesGuard)
@RequireRoles('MODERATOR')
export class CommsUniAdminController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly client: CommsUniClient,
    private readonly backfill: CommsUniBackfillService,
    private readonly config: ConfigService,
  ) {}

  @Get()
  async overview() {
    const [states, oldest, reports, quota] = await Promise.all([
      this.prisma.commsUniOutbox.groupBy({ by: ['state'], _count: { _all: true } }),
      this.prisma.commsUniOutbox.findFirst({
        where: {
          state: { in: ['PENDING', 'RETRY', 'UNCERTAIN', 'WAITING_REVIEW', 'BLOCKED_MAPPING'] },
        },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
      this.prisma.commsUniReport.count({ where: { state: 'OPEN' } }),
      this.redis.get('commsuni:quota:' + this.client.scope),
    ]);
    return {
      enabled: this.client.enabled,
      writesEnabled: this.client.writesEnabled,
      states,
      oldestPendingAt: oldest?.createdAt ?? null,
      openReports: reports,
      quota,
    };
  }

  @Get('operations')
  operations() {
    return this.prisma.commsUniOutbox.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        state: true,
        method: true,
        commentId: true,
        remoteId: true,
        errorCode: true,
        attempts: true,
        createdAt: true,
        nextAttemptAt: true,
        cleanup: true,
      },
    });
  }

  @Get('operations/:id')
  async reviewOperation(@Param('id') id: string) {
    const row = await this.prisma.commsUniOutbox.findUnique({
      where: { id },
      select: {
        id: true,
        commentId: true,
        remoteId: true,
        state: true,
        errorCode: true,
        target: true,
      },
    });
    if (!row) throw new BadRequestException('Operation not found');
    const comment = row.commentId
      ? await this.prisma.comment.findUnique({
          where: { id: row.commentId },
          select: {
            id: true,
            body: true,
            threadType: true,
            threadId: true,
            image: { select: { id: true, status: true } },
          },
        })
      : null;
    const diagnostic = object(object(row.target).lastError);
    const encrypted = diagnostic.messageEncrypted;
    let providerMessage: string | null = null;
    if (typeof encrypted === 'string') {
      try {
        providerMessage = unseal<string>(
          this.config.get<string>('commsuni.actorSecret') || '',
          encrypted,
        );
      } catch {
        /* wrong scope/key */
      }
    }
    const { target, ...operation } = row;
    return {
      ...operation,
      comment,
      providerError: {
        code: diagnostic.code,
        reason: diagnostic.reason,
        status: diagnostic.status,
        requestId: diagnostic.requestId,
        message: providerMessage,
      },
    };
  }

  @Post('operations/:id/approve')
  async approve(@CurrentUser('id') adminId: string, @Param('id') id: string) {
    await this.prisma.$transaction(async (tx) => {
      const row = await tx.commsUniOutbox.findUnique({ where: { id } });
      if (!row || row.firstAttemptAt || row.state !== 'WAITING_REVIEW' || !row.commentId)
        throw new BadRequestException('This operation cannot be approved');
      await tx.commsUniOutbox.update({
        where: { id },
        data: {
          state: 'PENDING',
          errorCode: null,
        },
      });
      await tx.comment.updateMany({
        where: { id: row.commentId },
        data: { commsUniState: 'PENDING' },
      });
      await tx.adminAuditLog.create({
        data: {
          adminId,
          action: 'commsuni_approve_comment',
          targetType: 'commsuni_outbox',
          targetId: id,
        },
      });
    });
    return { state: 'PENDING', writesEnabled: this.client.writesEnabled };
  }

  @Post('writes/resume-budget')
  @RequireRoles('ADMIN')
  async resumeBudget(@CurrentUser('id') adminId: string) {
    this.client.assertWrites();
    await this.redis.del('commsuni:write-paused:' + this.client.scope);
    await this.redis.delByPattern('commsuni:cooldown:' + this.client.scope + ':*');
    const result = await this.prisma.commsUniOutbox.updateMany({
      where: {
        identity: { scope: this.client.scope },
        state: 'RETRY',
        target: { path: ['lastError', 'reason'], equals: 'daily_budget' },
      },
      data: { nextAttemptAt: new Date() },
    });
    await this.prisma.adminAuditLog.create({
      data: {
        adminId,
        action: 'commsuni_resume_budget',
        targetType: 'commsuni_scope',
        targetId: this.client.scope,
      },
    });
    return { rescheduled: result.count };
  }

  @Get('backfill/readiness')
  @RequireRoles('ADMIN')
  backfillReadiness() {
    return this.backfill.readiness();
  }

  @Get('backfill/preview')
  @RequireRoles('ADMIN')
  previewBackfill(@Query() query: CommsUniBackfillRequest) {
    return this.backfill.preview(query);
  }

  @Post('backfill/enqueue')
  @RequireRoles('ADMIN')
  enqueueBackfill(@Body() input: CommsUniBackfillApply) {
    return this.backfill.enqueue(input);
  }

  @Get('backfill/runs/:runId')
  @RequireRoles('ADMIN')
  backfillReport(@Param('runId') runId: string, @Query('cursor') cursor?: string) {
    return this.backfill.report(runId, cursor);
  }

  @Get('reports')
  reports() {
    return this.prisma.commsUniReport.findMany({
      where: { state: 'OPEN' },
      take: 100,
      orderBy: { createdAt: 'asc' },
    });
  }

  @Patch('reports/:id')
  async decide(
    @CurrentUser('id') adminId: string,
    @Param('id') id: string,
    @Body() dto: ReportDecision,
  ) {
    await this.prisma.$transaction(async (tx) => {
      await tx.commsUniReport.update({ where: { id }, data: { state: dto.state } });
      await tx.adminAuditLog.create({
        data: {
          adminId,
          action: 'commsuni_report_decision',
          targetType: 'commsuni_report',
          targetId: id,
          metadata: { state: dto.state },
        },
      });
    });
    // Local suppression only. No provider write, even if shared publishing is enabled.
    await this.redis.delByPattern('commsuni:session:*');
    return { state: dto.state };
  }
}
