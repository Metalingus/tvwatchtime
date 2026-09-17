import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import { CommsUniError } from './commsuni.client';
import { UnmappedConversation } from './commsuni.resolver';

@Catch(CommsUniError, UnmappedConversation)
export class CommsUniExceptionFilter implements ExceptionFilter {
  catch(error: CommsUniError | UnmappedConversation, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse();
    const status = error instanceof CommsUniError ? error.status || 503 : 409;
    if (error instanceof CommsUniError && error.retryAfterSeconds > 0)
      response.setHeader('Retry-After', String(error.retryAfterSeconds));
    response.status(status).json({
      statusCode: status,
      ...(error instanceof CommsUniError && error.retryAfterSeconds > 0
        ? { retryAfterSeconds: error.retryAfterSeconds }
        : {}),
      code: error instanceof CommsUniError ? error.code : 'conversation_unmapped',
      reason: error instanceof CommsUniError ? error.reason : error.reason,
      message:
        error instanceof UnmappedConversation
          ? 'Shared conversation identity is not verified'
          : 'Shared conversation request could not be completed',
    });
  }
}
