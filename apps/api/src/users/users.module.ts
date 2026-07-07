import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { UserImageService } from './user-image.service';
import { UsersController } from './users.controller';

@Module({
  providers: [UsersService, UserImageService],
  controllers: [UsersController],
  exports: [UsersService],
})
export class UsersModule {}
