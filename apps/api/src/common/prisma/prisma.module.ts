import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { FeatureFlagService } from '../feature-flag.service';
import { SettingService } from '../setting.service';
import { CapabilityService } from '../capability.service';

@Global()
@Module({
  providers: [PrismaService, FeatureFlagService, SettingService, CapabilityService],
  exports: [PrismaService, FeatureFlagService, SettingService, CapabilityService],
})
export class PrismaModule {}
