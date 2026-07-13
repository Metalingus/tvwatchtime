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
    // Web push VAPID setup (optional — won't crash if web-push isn't available)
    const vapidPublic = this.config.get<string>('push.vapidPublicKey');
    const vapidPrivate = this.config.get<string>('push.vapidPrivateKey');
    const vapidSubject = this.config.get<string>('push.vapidSubject');
    if (vapidPublic && vapidPrivate) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const wp = require('web-push');
        if (wp && typeof wp.setVAPIDDetails === 'function') {
          wp.setVAPIDDetails(vapidSubject || 'mailto:noreply@tvwatchtime.org', vapidPublic, vapidPrivate);
          this.logger.log('Web push VAPID configured');
        }
      } catch (e) {
        this.logger.warn(`Web push VAPID setup skipped: ${(e as Error).message}`);
      }
    }

    // Firebase FCM setup
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
    await this.sendToDevices(devices, msg);
  }

  /**
   * Send one message to an arbitrary set of devices (across users). Used by the
   * broadcast fan-out. Handles web-push, FCM, Expo and relay modes and returns
   * per-send success/failure counts so the caller can record progress.
   */
  async sendToDevices(
    devices: { id: string; token: string; platform: string; pushP256dh: string | null; pushAuth: string | null }[],
    msg: { title: string; body?: string; data?: Record<string, unknown>; imageUrl?: string | null },
  ): Promise<{ sent: number; failed: number }> {
    if (devices.length === 0) return { sent: 0, failed: 0 };

    // Separate web push devices from mobile devices
    const webDevices = devices.filter((d) => d.platform === 'web' && d.pushP256dh && d.pushAuth);
    const mobileDevices = devices.filter((d) => !(d.platform === 'web' && d.pushP256dh && d.pushAuth));

    let sent = 0;
    let failed = 0;

    // Send to web push devices (per-device; web users are typically fewer)
    if (webDevices.length > 0) {
      let wp: any = null;
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        wp = require('web-push');
      } catch {
        wp = null;
      }
      if (wp && typeof wp.sendNotification === 'function') {
        for (const device of webDevices) {
          try {
            await wp.sendNotification(
              { endpoint: device.token, keys: { p256dh: device.pushP256dh!, auth: device.pushAuth! } },
              JSON.stringify({ title: msg.title, body: msg.body, url: (msg.data as any)?.link || '/', imageUrl: msg.imageUrl }),
            );
            sent++;
          } catch (e: any) {
            if (e.statusCode === 410 || e.statusCode === 404) {
              await this.prisma.device.update({ where: { id: device.id }, data: { active: false } });
            } else {
              this.logger.warn(`Web push failed: ${(e as Error).message?.slice(0, 200)}`);
            }
            failed++;
          }
        }
      } else {
        failed += webDevices.length;
      }
    }

    if (mobileDevices.length === 0) return { sent, failed };
    const tokens = mobileDevices.map((d) => d.token);

    // Mode priority: FCM > Expo direct > Relay > skip
    if (this.fcm) {
      try {
        const res = await this.fcm.sendEachForMulticast({
          tokens,
          notification: { title: msg.title, body: msg.body, imageUrl: msg.imageUrl ?? undefined },
          data: stringifyValues(msg.data ?? {}),
          android: { priority: 'high' },
        });
        sent += res.successCount;
        failed += res.failureCount;
      } catch (e) {
        this.logger.warn(`FCM multicast failed: ${(e as Error).message?.slice(0, 200)}`);
        failed += tokens.length;
      }
      return { sent, failed };
    }

    if (this.expoToken) {
      const expoTokens = tokens.filter((t) => t.startsWith('ExponentPushToken'));
      if (expoTokens.length === 0) return { sent, failed };
      try {
        const res = await fetch('https://exp.host/--/api/v2/push/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.expoToken}` },
          body: JSON.stringify(expoTokens.map((to) => ({ to, title: msg.title, body: msg.body, data: msg.data, sound: 'default' }))),
        });
        if (res.ok) {
          const tickets = (await res.json()) as { data?: { status: string }[] };
          const arr = tickets.data ?? [];
          for (const t of arr) (t?.status === 'ok' ? sent++ : failed++);
          // Any tokens without a ticket entry count as failed
          const accounted = arr.length;
          if (expoTokens.length > accounted) failed += expoTokens.length - accounted;
        } else {
          failed += expoTokens.length;
        }
      } catch (e) {
        this.logger.warn(`Expo batch push failed: ${(e as Error).message?.slice(0, 200)}`);
        failed += expoTokens.length;
      }
      return { sent, failed };
    }

    // Relay mode — for self-hosted backends without their own Expo token
    const pushMode = this.config.get<string>('metadata.pushMode') || 'expo';
    const relayUrl = this.config.get<string>('metadata.relayUrl');
    if (pushMode === 'relay' && relayUrl) {
      for (const token of tokens) {
        try {
          const r = await fetch(`${relayUrl}/push/relay`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token, title: msg.title, body: msg.body, data: msg.data }),
          });
          if (r.ok) sent++;
          else failed++;
        } catch (e) {
          this.logger.warn(`Relay push failed for ${token.slice(0, 20)}...: ${(e as Error).message}`);
          failed++;
        }
      }
      return { sent, failed };
    }

    this.logger.debug('No push delivery method configured (no FCM, no Expo token, no relay)');
    failed += mobileDevices.length;
    return { sent, failed };
  }
}

function stringifyValues(obj: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = typeof v === 'string' ? v : JSON.stringify(v);
  return out;
}
