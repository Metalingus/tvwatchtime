import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';

@Injectable()
export class FeatureFlagService implements OnModuleInit {
  private cache = new Map<string, boolean>();
  private lastRefresh = 0;
  private readonly TTL = 30_000; // 30s cache

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    await this.refresh();
  }

  private async refresh() {
    if (Date.now() - this.lastRefresh < this.TTL) return;
    const flags = await this.prisma.featureFlag.findMany();
    for (const f of flags) this.cache.set(f.key, f.value);
    this.lastRefresh = Date.now();
  }

  async isEnabled(key: string): Promise<boolean> {
    await this.refresh();
    return this.cache.get(key) ?? true; // default to enabled
  }
}
