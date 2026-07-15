import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { ContactService } from './contact.service';
import {
  ContactListQueryDto,
  CreateContactMessageDto,
  CreateContactThreadDto,
} from './dto/contact.dto';

@ApiTags('contact')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('me/contacts')
export class ContactController {
  constructor(private readonly contact: ContactService) {}

  @Get()
  list(@CurrentUser('id') userId: string, @Query() q: ContactListQueryDto) {
    return this.contact.listForUser(userId, q.page, q.pageSize);
  }

  @Post()
  create(@CurrentUser('id') userId: string, @Body() dto: CreateContactThreadDto) {
    return this.contact.create(userId, dto);
  }

  @Get(':id')
  get(@CurrentUser('id') userId: string, @Param('id') id: string) {
    return this.contact.getForUser(userId, id);
  }

  @Post(':id/messages')
  reply(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: CreateContactMessageDto,
  ) {
    return this.contact.replyAsUser(userId, id, dto);
  }
}
