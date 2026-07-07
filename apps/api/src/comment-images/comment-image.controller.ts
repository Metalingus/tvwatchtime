import { Controller, Delete, Get, Param, Post, Res, ServiceUnavailableException, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Public } from '../common/decorators/public.decorator';
import { CommentImageService } from './comment-image.service';
import { CapabilityService } from '../common/capability.service';

@ApiTags('comment-images')
@Controller()
export class CommentImageController {
  constructor(
    private readonly svc: CommentImageService,
    private readonly capabilities: CapabilityService,
  ) {}

  @Post('comments/:commentId/image')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024 } }))
  @ApiBearerAuth()
  @ApiConsumes('multipart/form-data')
  upload(@CurrentUser('id') userId: string, @Param('commentId') commentId: string, @UploadedFile() file: any) {
    if (!this.capabilities.commentImages) {
      throw new ServiceUnavailableException('Image uploads require S3/MinIO storage configuration');
    }
    return this.svc.upload(userId, commentId, {
      buffer: file?.buffer,
      originalname: file?.originalname ?? 'upload',
      size: file?.size ?? 0,
      mimetype: file?.mimetype ?? 'application/octet-stream',
    });
  }

  @Get('comment-images/:imageId/status')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  status(@CurrentUser('id') userId: string, @Param('imageId') imageId: string) {
    return this.svc.getStatus(userId, imageId);
  }

  @Public()
  @Get('comment-images/:imageId')
  serve(@Param('imageId') imageId: string) {
    return this.svc.serveImage('public', imageId, false);
  }

  @Public()
  @Get('comment-images/:imageId/thumbnail')
  serveThumb(@Param('imageId') imageId: string) {
    return this.svc.serveImage('public', imageId, true);
  }

  @Delete('comment-images/:imageId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  remove(@CurrentUser('id') userId: string, @Param('imageId') imageId: string) {
    return this.svc.remove(userId, imageId);
  }
}
