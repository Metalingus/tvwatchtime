import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { FeatureFlagService } from '../common/feature-flag.service';
import { currentLanguage } from '../common/language.context';
import { ImportService } from './import.service';
import { ListImportItemsDto, PatchImportItemDto, ResolveByNameDto } from './dto';

@ApiTags('imports')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('imports')
export class ImportController {
  constructor(
    private readonly imports: ImportService,
    private readonly flags: FeatureFlagService,
  ) {}

  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } },
  })
  async upload(@CurrentUser('id') userId: string, @UploadedFile() file: any) {
    if (!(await this.flags.isEnabled('imports_enabled')))
      throw new BadRequestException('Imports are temporarily disabled');
    return this.imports.upload(
      userId,
      {
        buffer: file?.buffer,
        originalname: file?.originalname ?? 'upload',
        size: file?.size ?? 0,
      },
      currentLanguage(),
    );
  }

  @Get('resumable')
  resumable(@CurrentUser('id') userId: string) {
    return this.imports.getResumable(userId);
  }

  @Post('dismiss-pending')
  dismissPending(@CurrentUser('id') userId: string) {
    return this.imports.dismissPending(userId);
  }

  @Get(':id')
  status(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.imports.getStatus(userId, id);
  }

  @Post(':id/retry-identities')
  retryIdentities(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.imports.retryMovieIdentities(userId, id, cursor);
  }

  @Get(':id/summary')
  summary(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.imports.getSummary(userId, id);
  }

  @Get(':id/files')
  files(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.imports.getFiles(userId, id);
  }

  @Get(':id/items')
  items(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Query() q: ListImportItemsDto,
  ) {
    return this.imports.getItems(userId, id, {
      status: q.status,
      hideUnmatched: q.hideUnmatched === 'true',
      entity: q.entity,
      page: q.page ? Number(q.page) : 1,
      pageSize: q.pageSize ? Number(q.pageSize) : 50,
    });
  }

  @Patch(':id/items/:itemId')
  patchItem(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() dto: PatchImportItemDto,
  ) {
    return this.imports.patchItem(userId, id, itemId, dto);
  }

  @Post(':id/resolve-episodes')
  resolveEpisodes(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: { matchedMediaId: string; sourceTitle: string; season?: number },
  ) {
    return this.imports.resolveAllForShow(
      userId,
      id,
      dto.matchedMediaId,
      dto.sourceTitle,
      dto.season,
    );
  }

  @Post(':id/resolve-by-name')
  resolveByName(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: ResolveByNameDto,
  ) {
    return this.imports.resolveByName(userId, id, { status: dto.status, entity: dto.entity });
  }

  @Post(':id/confirm')
  confirm(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.imports.confirm(userId, id);
  }

  @Post(':id/cancel')
  cancel(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.imports.cancel(userId, id);
  }

  @Post(':id/rollback')
  rollback(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.imports.rollback(userId, id);
  }

  @Delete(':id')
  remove(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.imports.remove(userId, id);
  }
}
