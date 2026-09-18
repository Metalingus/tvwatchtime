import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma, NotificationCategory } from '@prisma/client';
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
  dedupeKey?: string;
  pushDedupeKey?: string;
}

@Injectable()
export class PushService implements OnModuleInit {
  private readonly logger = new Logger(PushService.name);
  private fcm?: admin.messaging.Messaging;
  private readonly expoToken?: string;
  /** False when VAPID setup was skipped — every web push would go out unsigned
   *  and fail with a bare 401 ("Received unexpected response code"). */
  private vapidConfigured = false;

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
          wp.setVAPIDDetails(
            vapidSubject || 'mailto:noreply@tvwatchtime.org',
            vapidPublic,
            vapidPrivate,
          );
          this.vapidConfigured = true;
          this.logger.log('Web push VAPID configured');
        }
      } catch (e) {
        this.logger.warn(`Web push VAPID setup skipped: ${(e as Error).message}`);
      }
    } else {
      this.logger.warn(
        'Web push VAPID keys not set (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY) — web push deliveries will fail',
      );
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

  async schedule(input: ScheduleInput, db: Prisma.TransactionClient = this.prisma) {
    await db.pushNotificationJob.create({
      data: {
        userId: input.userId,
        category: input.category,
        title: input.title,
        body: input.body,
        payload: {
          imageUrl: input.imageUrl,
          link: input.link,
          ...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}),
          ...(input.pushDedupeKey ? { pushDedupeKey: input.pushDedupeKey } : {}),
        },
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
      await this.prisma.pushNotificationJob.update({
        where: { id: job.id },
        data: { status: 'DISPATCHED', dispatchedAt: new Date(), attempts: { increment: 1 } },
      });
      try {
        if (!job.userId) continue;
        await this.sendToUser(job.userId, {
          title: job.title,
          body: job.body ?? undefined,
          data: { ...(job.payload as any), category: job.category },
        });
        await this.prisma.pushNotificationJob.update({
          where: { id: job.id },
          data: { status: 'DELIVERED' },
        });
      } catch (e) {
        await this.prisma.pushNotificationJob.update({
          where: { id: job.id },
          data: { status: 'FAILED', error: (e as Error).message?.slice(0, 500) },
        });
        this.logger.warn(`Push job ${job.id} failed: ${(e as Error).message}`);
      }
    }
  }

  async sendToUser(
    userId: string,
    msg: { title: string; body?: string; data?: Record<string, unknown>; imageUrl?: string | null },
  ) {
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
    devices: {
      id: string;
      token: string;
      platform: string;
      pushP256dh: string | null;
      pushAuth: string | null;
    }[],
    msg: { title: string; body?: string; data?: Record<string, unknown>; imageUrl?: string | null },
  ): Promise<{ sent: number; failed: number }> {
    if (devices.length === 0) return { sent: 0, failed: 0 };

    // Separate web push devices from mobile devices
    const webDevices = devices.filter((d) => d.platform === 'web' && d.pushP256dh && d.pushAuth);
    const mobileDevices = devices.filter(
      (d) => !(d.platform === 'web' && d.pushP256dh && d.pushAuth),
    );

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
        if (!this.vapidConfigured) {
          // Unsigned sends fail 401 at the push service — skip the per-device loop
          // and say WHY once per call instead of spamming one warn per device.
          this.logger.warn(
            `Web push skipped for ${webDevices.length} device(s): VAPID not configured ` +
              '(check VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT)',
          );
          failed += webDevices.length;
        } else {
          for (const device of webDevices) {
            try {
              await wp.sendNotification(
                {
                  endpoint: device.token,
                  keys: { p256dh: device.pushP256dh!, auth: device.pushAuth! },
                },
                JSON.stringify({
                  title: msg.title,
                  body: msg.body,
                  url: (msg.data as any)?.link || '/',
                  imageUrl: msg.imageUrl,
                }),
              );
              sent++;
            } catch (e: any) {
              if (e.statusCode === 410 || e.statusCode === 404) {
                await this.prisma.device.update({
                  where: { id: device.id },
                  data: { active: false },
                });
              } else {
                // web-push's message ("Received unexpected response code") hides the
                // actual cause — log the status code and response body too. 401/403
                // means VAPID mismatch (rotated keys or wrong subject): affected
                // browsers must resubscribe (the web app self-heals on next start).
                const status = e.statusCode ? ` [${e.statusCode}]` : '';
                const body = e.body ? ` — ${String(e.body).slice(0, 160)}` : '';
                this.logger.warn(
                  `Web push failed${status}: ${(e as Error).message?.slice(0, 120)}${body}`,
                );
              }
              failed++;
            }
          }
        }
      } else {
        failed += webDevices.length;
      }
    }

    if (mobileDevices.length === 0) return { sent, failed };

    // Route by token TYPE, not by configured-provider priority. The app registers
    // Expo push tokens (ExponentPushToken[...]) which are invalid as FCM tokens —
    // pushed through FCM every one fails (the "N pushed, M failed" broadcast bug:
    // only native FCM devices ever received anything).
    const expoDevices = mobileDevices.filter((d) => d.token.startsWith('ExponentPushToken'));
    const fcmDevices = mobileDevices.filter((d) => !d.token.startsWith('ExponentPushToken'));

    if (expoDevices.length > 0) {
      const pushMode = this.config.get<string>('metadata.pushMode') || 'expo';
      const relayUrl = this.config.get<string>('metadata.relayUrl');
      if (pushMode === 'relay' && relayUrl) {
        // Relay mode — self-hosted backends forwarding Expo tokens to the public relay
        for (const device of expoDevices) {
          try {
            const r = await fetch(`${relayUrl}/push/relay`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                token: device.token,
                title: msg.title,
                body: msg.body,
                data: msg.data,
              }),
            });
            if (r.ok) sent++;
            else failed++;
          } catch (e) {
            this.logger.warn(
              `Relay push failed for ${device.token.slice(0, 20)}...: ${(e as Error).message}`,
            );
            failed++;
          }
        }
      } else {
        // Direct Expo Push API. The access token is recommended but optional —
        // Expo accepts unauthenticated sends unless the project enforces it.
        try {
          const headers: Record<string, string> = { 'Content-Type': 'application/json' };
          if (this.expoToken) headers.Authorization = `Bearer ${this.expoToken}`;
          const res = await fetch('https://exp.host/--/api/v2/push/send', {
            method: 'POST',
            headers,
            body: JSON.stringify(
              expoDevices.map((d) => ({
                to: d.token,
                title: msg.title,
                body: msg.body,
                data: msg.data,
                sound: 'default',
              })),
            ),
          });
          if (!res.ok) {
            failed += expoDevices.length;
            this.logger.warn(`Expo batch push failed: HTTP ${res.status}`);
          } else {
            const tickets = (await res.json()) as {
              data?: { status: string; id?: string; message?: string }[];
            };
            const arr = tickets.data ?? [];
            const okReceipts: { deviceId: string; receiptId: string }[] = [];
            let ticketFailures = 0;
            expoDevices.forEach((device, i) => {
              const t = arr[i];
              if (t?.status === 'ok') {
                sent++;
                if (t.id) okReceipts.push({ deviceId: device.id, receiptId: t.id });
              } else {
                failed++;
                ticketFailures++;
              }
            });
            if (ticketFailures > 0) {
              const firstBad = arr.find((t) => t?.status !== 'ok');
              this.logger.warn(
                `Expo push: ${ticketFailures}/${expoDevices.length} ticket(s) failed` +
                  (firstBad?.message ? ` (first: ${firstBad.message.slice(0, 120)})` : ''),
              );
            }
            // Best-effort receipt check: deactivate tokens Expo reports as gone
            // so stale devices stop inflating send counts.
            if (okReceipts.length > 0) {
              try {
                const receiptRes = await fetch('https://exp.host/--/api/v2/push/getReceipts', {
                  method: 'POST',
                  headers,
                  body: JSON.stringify({ ids: okReceipts.map((r) => r.receiptId) }),
                });
                if (receiptRes.ok) {
                  const receipts = (await receiptRes.json()) as {
                    data?: Record<string, { status: string; details?: { error?: string } }>;
                  };
                  const stale = okReceipts.filter(
                    (r) => receipts.data?.[r.receiptId]?.details?.error === 'DeviceNotRegistered',
                  );
                  if (stale.length > 0) {
                    await this.prisma.device.updateMany({
                      where: { id: { in: stale.map((r) => r.deviceId) } },
                      data: { active: false },
                    });
                    this.logger.log(
                      `Deactivated ${stale.length} stale device(s) (DeviceNotRegistered)`,
                    );
                  }
                }
              } catch {
                // receipt cleanup is best-effort
              }
            }
          }
        } catch (e) {
          this.logger.warn(`Expo batch push failed: ${(e as Error).message?.slice(0, 200)}`);
          failed += expoDevices.length;
        }
      }
    }

    if (fcmDevices.length > 0) {
      if (!this.fcm) {
        this.logger.warn(
          `Skipping ${fcmDevices.length} native FCM device(s): Firebase not configured`,
        );
        failed += fcmDevices.length;
      } else {
        const fcmTokens = fcmDevices.map((d) => d.token);
        try {
          const res = await this.fcm.sendEachForMulticast({
            tokens: fcmTokens,
            notification: { title: msg.title, body: msg.body, imageUrl: msg.imageUrl ?? undefined },
            data: stringifyValues(msg.data ?? {}),
            android: { priority: 'high' },
          });
          sent += res.successCount;
          failed += res.failureCount;
          if (res.failureCount > 0) {
            // Per-token failures are otherwise invisible — surface the first reason.
            const firstErr = res.responses.find((r) => !r.success)?.error;
            this.logger.warn(
              `FCM multicast: ${res.failureCount}/${fcmTokens.length} failed` +
                (firstErr ? ` (first: ${firstErr.code ?? firstErr.message})` : ''),
            );
          }
        } catch (e) {
          this.logger.warn(`FCM multicast failed: ${(e as Error).message?.slice(0, 200)}`);
          failed += fcmTokens.length;
        }
      }
    }

    return { sent, failed };
  }
}

export function stringifyValues(obj: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    // FCM rejects data maps containing ANY non-string value — including undefined
    // (JSON.stringify(undefined) === undefined). Broadcasts with no action carry
    // undefined actionType/actionTarget/actionParams; without this guard the whole
    // multicast throws client-side and every mobile token in the batch fails.
    if (v == null) continue;
    out[k] = typeof v === 'string' ? v : JSON.stringify(v);
  }
  return out;
}
