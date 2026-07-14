import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { PrismaService } from './prisma/prisma.service';

const ALGO = 'aes-256-gcm';

@Injectable()
export class SettingService implements OnModuleInit {
  private readonly logger = new Logger(SettingService.name);
  private cache = new Map<string, string>();
  private lastRefresh = 0;
  private readonly TTL = 10_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit() {
    await this.seedDefaults();
    await this.refresh();
  }

  private getMasterKey(): Buffer {
    const raw = this.config.get<string>('commentImages.encryptionMasterKey') || 'dev-master-key-change-in-prod-32bytes!';
    return Buffer.from(raw, 'utf8');
  }

  private encrypt(plain: string): string {
    const key = this.getMasterKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGO, key.subarray(0, 32), iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, enc]).toString('base64');
  }

  private decrypt(b64: string): string {
    try {
      const buf = Buffer.from(b64, 'base64');
      const iv = buf.subarray(0, 12);
      const tag = buf.subarray(12, 28);
      const enc = buf.subarray(28);
      const key = this.getMasterKey();
      const decipher = createDecipheriv(ALGO, key.subarray(0, 32), iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
    } catch {
      return '';
    }
  }

  private async refresh() {
    if (Date.now() - this.lastRefresh < this.TTL) return;
    const rows = await this.prisma.appSetting.findMany();
    for (const r of rows) {
      this.cache.set(r.key, r.encrypted ? this.decrypt(r.value) : r.value);
    }
    this.lastRefresh = Date.now();
  }

  /** Get a setting value with env fallback. */
  async get(key: string, fallback?: string): Promise<string> {
    await this.refresh();
    const val = this.cache.get(key);
    if (val !== undefined && val !== '') return val;
    return this.config.get<string>(key) ?? fallback ?? '';
  }

  async getNumber(key: string, fallback: number): Promise<number> {
    const v = await this.get(key);
    const n = Number(v);
    return Number.isFinite(n) && v !== '' ? n : fallback;
  }

  async getBool(key: string, fallback: boolean): Promise<boolean> {
    const v = await this.get(key);
    if (v === '') return fallback;
    return /^(1|true|yes|on)$/i.test(v);
  }

  /** Set a setting (encrypts if sensitive). */
  async set(key: string, value: string, encrypted: boolean, category = 'general'): Promise<void> {
    const stored = encrypted ? this.encrypt(value) : value;
    await this.prisma.appSetting.upsert({
      where: { key },
      create: { key, value: stored, encrypted, category },
      update: { value: stored, encrypted, category },
    });
    this.cache.set(key, value); // cache the plaintext
  }

  /** Get all settings for admin UI (masks encrypted values). */
  async getAll() {
    const rows = await this.prisma.appSetting.findMany({ orderBy: { category: 'asc' } });
    return rows.map((r: any) => {
      const val = r.encrypted ? this.decrypt(r.value) : r.value;
      return {
        key: r.key,
        value: r.encrypted && val ? '••••••••' : val,
        encrypted: r.encrypted,
        category: r.category,
        updatedAt: r.updatedAt.toISOString(),
        isSet: !!val,
      };
    });
  }

  /** Get the actual decrypted value (admin only). */
  async getDecrypted(key: string): Promise<string> {
    await this.refresh();
    return this.cache.get(key) ?? '';
  }

  private async seedDefaults() {
    const defaults: { key: string; value: string; encrypted: boolean; category: string; envKey?: string }[] = [
      // TMDb
      { key: 'TMDB_API_KEY', value: '', encrypted: true, category: 'tmdb', envKey: 'metadata.tmdbApiKey' },
      { key: 'TMDB_LANGUAGE', value: 'en-US', encrypted: false, category: 'tmdb' },
      { key: 'TMDB_RPS', value: '40', encrypted: false, category: 'tmdb' },
      // TVmaze
      { key: 'TVMAZE_ENABLED', value: 'true', encrypted: false, category: 'tvmaze' },
      { key: 'TVMAZE_API_KEY', value: '', encrypted: true, category: 'tvmaze' },
      // Trakt
      { key: 'TRAKT_CLIENT_ID', value: '', encrypted: true, category: 'trakt' },
      { key: 'TRAKT_CLIENT_SECRET', value: '', encrypted: true, category: 'trakt' },
      // Push
      { key: 'EXPO_ACCESS_TOKEN', value: '', encrypted: true, category: 'push', envKey: 'push.expoAccessToken' },
      // Notifications
      { key: 'WATCHLIST_REMINDER_SHOW_COOLDOWN_DAYS', value: '30', encrypted: false, category: 'notifications' },
      { key: 'WATCHLIST_REMINDER_STALE_DAYS', value: '14', encrypted: false, category: 'notifications' },
      // Rate limits
      { key: 'IMPORT_DAILY_LIMIT', value: '3', encrypted: false, category: 'limits' },
      { key: 'MAX_PUSH_NOTIFICATIONS_PER_USER_PER_DAY', value: '3', encrypted: false, category: 'limits' },
      { key: 'COMMENT_IMAGE_UPLOADS_PER_USER_PER_DAY', value: '20', encrypted: false, category: 'limits' },
      { key: 'COMMENT_IMAGE_WORKER_CONCURRENCY', value: '2', encrypted: false, category: 'limits' },
      // Image processing
      { key: 'COMMENT_IMAGE_MAX_LONG_EDGE', value: '1600', encrypted: false, category: 'images' },
      { key: 'COMMENT_IMAGE_WEBP_QUALITY', value: '95', encrypted: false, category: 'images' },
      { key: 'COMMENT_THUMBNAIL_MAX_LONG_EDGE', value: '480', encrypted: false, category: 'images' },
      { key: 'COMMENT_THUMBNAIL_WEBP_QUALITY', value: '85', encrypted: false, category: 'images' },
    ];

    for (const d of defaults) {
      const existing = await this.prisma.appSetting.findUnique({ where: { key: d.key } });
      if (existing) continue;
      // Seed from env if available
      let value = d.value;
      if (d.envKey) {
        const envVal = this.config.get<string>(d.envKey);
        if (envVal) value = envVal;
      }
      const stored = d.encrypted && value ? this.encrypt(value) : value;
      await this.prisma.appSetting.create({ data: { key: d.key, value: stored, encrypted: d.encrypted, category: d.category } });
    }
  }
}
