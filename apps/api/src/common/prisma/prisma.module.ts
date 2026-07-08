import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { FeatureFlagService } from '../feature-flag.service';
import { SettingService } from '../setting.service';
import { CapabilityService } from '../capability.service';
import { EmailService } from '../email.service';

@Global()
@Module({
  providers: [PrismaService, FeatureFlagService, SettingService, CapabilityService, EmailService],
  exports: [PrismaService, FeatureFlagService, SettingService, CapabilityService, EmailService],
})
export class PrismaModule {}
