import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { UserImageService } from './user-image.service';
import { ExportService } from './export.service';
import { UsersController } from './users.controller';

@Module({
  providers: [UsersService, UserImageService, ExportService],
  controllers: [UsersController],
  exports: [UsersService],
})
export class UsersModule {}
