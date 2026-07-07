import { Body, Controller, Delete, Get, Param, Patch, Post, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { UsersService } from './users.service';
import { UserImageService } from './user-image.service';
import { DeviceRegisterDto, UpdateProfileDto } from './dto/user.dto';

@ApiTags('users')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly images: UserImageService,
  ) {}

  @Get('me')
  me(@CurrentUser('id') userId: string) {
    return this.users.getMe(userId);
  }

  @Patch('me')
  updateMe(@CurrentUser('id') userId: string, @Body() dto: UpdateProfileDto) {
    return this.users.updateMe(userId, dto);
  }

  @Post('me/avatar')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  @ApiConsumes('multipart/form-data')
  uploadAvatar(@CurrentUser('id') userId: string, @UploadedFile() file: any) {
    return this.images.uploadAvatar(userId, {
      buffer: file?.buffer,
      mimetype: file?.mimetype ?? 'image/jpeg',
    });
  }

  @Post('me/cover')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  @ApiConsumes('multipart/form-data')
  uploadCover(@CurrentUser('id') userId: string, @UploadedFile() file: any) {
    return this.images.uploadCover(userId, {
      buffer: file?.buffer,
      mimetype: file?.mimetype ?? 'image/jpeg',
    });
  }

  @Delete('me')
  deleteMe(@CurrentUser('id') userId: string) {
    return this.users.deleteMe(userId);
  }

  @Post('devices/register')
  registerDevice(@CurrentUser('id') userId: string, @Body() dto: DeviceRegisterDto) {
    return this.users.registerDevice(userId, dto);
  }

  @Delete('devices/:id')
  removeDevice(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.users.removeDevice(userId, id);
  }

  @Get('users/:username')
  publicUser(@Param('username') username: string, @CurrentUser('id') viewerId?: string) {
    return this.users.getPublicUser(username, viewerId);
  }
}
