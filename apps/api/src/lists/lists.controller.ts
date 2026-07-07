import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { ListsService } from './lists.service';
import { AddListItemDto, CreateListDto, UpdateListDto } from './dto/list.dto';

@ApiTags('lists')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller()
export class ListsController {
  constructor(private readonly lists: ListsService) {}

  @Get('me/lists')
  mine(@CurrentUser('id') userId: string) {
    return this.lists.list(userId);
  }

  @Post('me/lists')
  create(@CurrentUser('id') userId: string, @Body() dto: CreateListDto) {
    return this.lists.create(userId, dto);
  }

  @Get('lists/:id')
  get(@Param('id') id: string, @CurrentUser('id') userId?: string) {
    return this.lists.get(id, userId);
  }

  @Patch('lists/:id')
  update(@CurrentUser('id') userId: string, @Param('id') id: string, @Body() dto: UpdateListDto) {
    return this.lists.update(userId, id, dto);
  }

  @Delete('lists/:id')
  remove(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.lists.remove(userId, id);
  }

  @Post('lists/:id/items')
  addItem(@CurrentUser('id') userId: string, @Param('id') id: string, @Body() dto: AddListItemDto) {
    return this.lists.addItem(userId, id, dto.mediaId);
  }

  @Delete('lists/:id/items/:itemId')
  removeItem(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
  ) {
    return this.lists.removeItem(userId, id, itemId);
  }
}
