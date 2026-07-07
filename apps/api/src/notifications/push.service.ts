import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { NotificationCategory } from '@prisma/client';
import * as admin from 'firebase-admin';
import { PrismaService } from '../common/prisma/prisma.service';

interface ScheduleInput {
  userId: string;
  category: NotificationCategory;
  title: string;
  body?: string;
  imageUrl?: string | null;
  link?: string | null;
  scheduledFor?: Date;
}

@Injectable()
export class PushService implements OnModuleInit {
  private readonly logger = new Logger(PushService.name);
  private fcm?: admin.messaging.Messaging;
  private readonly expoToken?: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.expoToken = config.get<string>('push.expoAccessToken');
  }

  onModuleInit() {
    const cfg = this.config.get('push.firebase');
    if (cfg?.projectId && cfg?.clientEmail && cfg?.privateKey) {
      try {
        if (!admin.apps.length) {
          admin.initializeApp({
            credential: admin.credential.cert({
              projectId: cfg.projectId,
              clientEmail: cfg.clientEmail,
              privateKey: cfg.privateKey,
            }),
          });
        }
        this.fcm = admin.messaging();
        this.logger.log('Firebase messaging initialized');
      } catch (e) {
        this.logger.warn(`Firebase init failed: ${(e as Error).message}`);
      }
    } else {
      this.logger.warn('Push: no Firebase config; Expo fallback used if token present');
    }
  }

  async schedule(input: ScheduleInput) {
    await this.prisma.pushNotificationJob.create({
      data: {
        userId: input.userId,
        category: input.category,
        title: input.title,
        body: input.body,
        payload: { imageUrl: input.imageUrl, link: input.link },
        scheduledFor: input.scheduledFor ?? new Date(),
        status: 'QUEUED',
      },
    });
  }

  @Cron(process.env.NOTIFICATIONS_DISPATCH_CRON || CronExpression.EVERY_5_MINUTES)
  async dispatchDue() {
    const due = await this.prisma.pushNotificationJob.findMany({
      where: { status: { in: ['QUEUED', 'SCHEDULED'] }, scheduledFor: { lte: new Date() } },
      take: 100,
      orderBy: { scheduledFor: 'asc' },
    });
    for (const job of due) {
      await this.prisma.pushNotificationJob.update({ where: { id: job.id }, data: { status: 'DISPATCHED', dispatchedAt: new Date(), attempts: { increment: 1 } } });
      try {
        if (!job.userId) continue;
        await this.sendToUser(job.userId, {
          title: job.title,
          body: job.body ?? undefined,
          data: { ...(job.payload as any), category: job.category },
        });
        await this.prisma.pushNotificationJob.update({ where: { id: job.id }, data: { status: 'DELIVERED' } });
      } catch (e) {
        await this.prisma.pushNotificationJob.update({
          where: { id: job.id },
          data: { status: 'FAILED', error: (e as Error).message?.slice(0, 500) },
        });
        this.logger.warn(`Push job ${job.id} failed: ${(e as Error).message}`);
      }
    }
  }

  async sendToUser(userId: string, msg: { title: string; body?: string; data?: Record<string, unknown>; imageUrl?: string | null }) {
    const devices = await this.prisma.device.findMany({ where: { userId, active: true } });
    if (devices.length === 0) return;
    const tokens = devices.map((d) => d.token);

    // Mode priority: FCM > Expo direct > Relay > skip
    if (this.fcm) {
      await this.fcm.sendEachForMulticast({
        tokens,
        notification: { title: msg.title, body: msg.body, imageUrl: msg.imageUrl ?? undefined },
        data: stringifyValues(msg.data ?? {}),
        android: { priority: 'high' },
      });
      return;
    }

    if (this.expoToken) {
      const expoTokens = tokens.filter((t) => t.startsWith('ExponentPushToken'));
      if (expoTokens.length === 0) return;
      await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.expoToken}` },
        body: JSON.stringify(expoTokens.map((to) => ({ to, title: msg.title, body: msg.body, data: msg.data, sound: 'default' }))),
      });
      return;
    }

    // Relay mode — for self-hosted backends without their own Expo token
    const pushMode = this.config.get<string>('metadata.pushMode') || 'expo';
    const relayUrl = this.config.get<string>('metadata.relayUrl');
    if (pushMode === 'relay' && relayUrl) {
      for (const token of tokens) {
        try {
          await fetch(`${relayUrl}/push/relay`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, title: msg.title, body: msg.body, data: msg.data }),
          });
        } catch (e) {
          this.logger.warn(`Relay push failed for ${token.slice(0, 20)}...: ${(e as Error).message}`);
        }
      }
      return;
    }

    this.logger.debug('No push delivery method configured (no FCM, no Expo token, no relay)');
  }
}

function stringifyValues(obj: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = typeof v === 'string' ? v : JSON.stringify(v);
  return out;
}
