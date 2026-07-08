import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    let datasourceUrl: string | undefined;

    const pgUser = process.env.POSTGRES_USER;
    const pgPass = process.env.POSTGRES_PASSWORD;
    const pgHost = process.env.POSTGRES_HOST || 'postgres';
    const pgPort = process.env.POSTGRES_PORT || '5432';
    const pgDb = process.env.POSTGRES_DB || 'tvwatch';

    if (pgUser && pgPass) {
      datasourceUrl = `postgresql://${pgUser}:${encodeURIComponent(pgPass)}@${pgHost}:${pgPort}/${pgDb}?schema=public`;
    }

    super({
      log: [
        { emit: 'event', level: 'error' },
        { emit: 'event', level: 'warn' },
      ],
      ...(datasourceUrl ? { datasourceUrl } : {}),
    });
  }

  async onModuleInit() {
    await this.$connect();
    this.logger.log('Prisma connected');
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
