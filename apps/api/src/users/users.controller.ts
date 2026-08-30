import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Public } from '../common/decorators/public.decorator';
import { UsersService } from './users.service';
import { UserImageService } from './user-image.service';
import { ExportService } from './export.service';
import {
  DeviceRegisterDto,
  SetProfileCoverFromGalleryRequestDto,
  UpdateProfileDto,
} from './dto/user.dto';
import { ProfileTasteService } from './profile-taste.service';
import { MediaType } from '@prisma/client';
import { Throttle } from '@nestjs/throttler';
import { IsIn } from 'class-validator';

class StoreReviewClaimDto {
  @IsIn(['IOS', 'ANDROID'])
  platform!: 'IOS' | 'ANDROID';
}

@ApiTags('users')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly images: UserImageService,
    private readonly exports: ExportService,
    private readonly taste: ProfileTasteService,
  ) {}

  @Get('me')
  me(@CurrentUser('id') userId: string) {
    return this.users.getMe(userId);
  }

  @Public()
  @Get('uploads/:type/:filename')
  async storedUserImage(
    @Param('type') type: string,
    @Param('filename') filename: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const image = await this.images.readStoredImage(type, filename);
    response.setHeader('Content-Type', image.contentType);
    response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return new StreamableFile(image.buffer);
  }

  @Patch('me')
  updateMe(@CurrentUser('id') userId: string, @Body() dto: UpdateProfileDto) {
    return this.users.updateMe(userId, dto);
  }

  @Post('me/store-review/claim')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  claimStoreReviewPrompt(@CurrentUser('id') userId: string, @Body() dto: StoreReviewClaimDto) {
    return this.users.claimStoreReviewPrompt(userId, dto.platform);
  }

  @Post('me/avatar')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  @ApiConsumes('multipart/form-data')
  async uploadAvatar(@CurrentUser('id') userId: string, @UploadedFile() file: any) {
    const url = await this.images.uploadAvatar(userId, {
      buffer: file?.buffer,
      mimetype: file?.mimetype ?? 'image/jpeg',
    });
    return { url };
  }

  @Post('me/cover')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  @ApiConsumes('multipart/form-data')
  async uploadCover(@CurrentUser('id') userId: string, @UploadedFile() file: any) {
    const url = await this.images.uploadCover(userId, {
      buffer: file?.buffer,
      mimetype: file?.mimetype ?? 'image/jpeg',
    });
    return { url };
  }

  @Post('me/cover/gallery-image')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async setGalleryCover(
    @CurrentUser('id') userId: string,
    @Body() dto: SetProfileCoverFromGalleryRequestDto,
  ) {
    const url = await this.images.setCoverFromGallery(userId, dto.ownerType, dto.imageId);
    return { url };
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

  @Get('users/search')
  searchUsers(@Query('q') q: string, @CurrentUser('id') userId: string) {
    return this.users.searchUsers(q || '', userId);
  }

  @Get('users/:username')
  publicUser(@Param('username') username: string, @CurrentUser('id') viewerId?: string) {
    return this.users.getPublicProfile(username, viewerId);
  }

  @Get('users/:username/follows')
  userFollows(
    @Param('username') username: string,
    @Query('type') type: string,
    @CurrentUser('id') viewerId?: string,
  ) {
    return this.users.getFollowsByUsername(
      username,
      type === 'following' ? 'following' : 'followers',
      viewerId,
    );
  }

  @Get('users/:username/lists')
  userLists(@Param('username') username: string, @CurrentUser('id') viewerId?: string) {
    return this.users.getUserPublicLists(username, viewerId);
  }

  @Get('users/:username/taste')
  userTaste(@Param('username') username: string, @CurrentUser('id') viewerId: string) {
    return this.taste.taste(username, viewerId);
  }

  @Get('users/:username/taste/recommendations')
  userRecommendations(
    @Param('username') username: string,
    @CurrentUser('id') viewerId: string,
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '30',
    @Query('type') type?: string,
  ) {
    const mediaType = type === MediaType.SHOW || type === MediaType.MOVIE ? type : undefined;
    return this.taste.recommendations(
      username,
      viewerId,
      Number(page),
      Number(pageSize),
      mediaType,
    );
  }

  @Get('users/:username/favorites')
  userFavorites(
    @Param('username') username: string,
    @CurrentUser('id') viewerId: string,
    @Query('type') type: string,
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '20',
  ) {
    return this.taste.favorites(
      username,
      viewerId,
      type === MediaType.MOVIE ? MediaType.MOVIE : MediaType.SHOW,
      Number(page),
      Number(pageSize),
    );
  }

  @Get('me/follows')
  myFollows(@CurrentUser('id') userId: string, @Query('type') type: string) {
    return this.users.getFollows(userId, type === 'following' ? 'following' : 'followers', userId);
  }

  // ---- Data Export ----
  @Post('me/export-request')
  async requestExport(@CurrentUser('id') userId: string) {
    return this.exports.requestExport(userId);
  }

  @Public()
  @Get('me/export-download')
  async downloadExport(@Query('token') token: string, @Res() res: Response) {
    const { buffer, fileName, contentType } = await this.exports.downloadExport(token);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(buffer);
  }
}
