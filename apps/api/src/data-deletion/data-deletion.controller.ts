import { Body, Controller, Get, Post, Query, Redirect } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { DataDeletionService } from './data-deletion.service';
import { ConfigService } from '@nestjs/config';

@ApiTags('data-deletion')
@Controller('data-deletion')
export class DataDeletionController {
  constructor(
    private readonly service: DataDeletionService,
    private readonly config: ConfigService,
  ) {}

  @Public()
  @Post('request')
  async request(@Body() body: { email: string }) {
    if (!body.email?.trim()) return { sent: false, error: 'Email is required' };
    const result = await this.service.requestDeletion(body.email.trim().toLowerCase());
    return result;
  }

  @Public()
  @Get('confirm')
  @Redirect()
  async confirm(@Query('token') token: string) {
    const result = await this.service.confirmDeletion(token);
    const siteUrl = this.config.get<string>('site.url')!;
    return { url: `${siteUrl}/delete-account?done=true`, statusCode: 302 };
  }
}
