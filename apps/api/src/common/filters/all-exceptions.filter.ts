import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ProviderHttp } from '../../media-metadata/providers/shared/provider-http';
import { Request, Response } from 'express';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exception');
  constructor(private readonly metrics?: ProviderHttp) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    const isHttp = exception instanceof HttpException;
    const status = isHttp ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    const responseBody = isHttp ? exception.getResponse() : null;
    let message: any = responseBody || 'Internal server error';
    let code: string | undefined;
    if (typeof message === 'object' && message !== null) {
      code = typeof (message as any).code === 'string' ? (message as any).code : undefined;
      message = (message as any).message ?? message;
    }

    if (code?.startsWith('IDENTITY_')) void this.metrics?.metric('identity', 'rejectedUserWrites');
    if (status >= 500) {
      this.logger.error(
        `${req.method} ${req.url} -> ${status}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    }

    res.status(status).json({
      statusCode: status,
      message: Array.isArray(message) ? message : String(message),
      ...(code ? { code } : {}),
      path: req.url,
      timestamp: new Date().toISOString(),
    });
  }
}
