import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Observable, tap } from 'rxjs';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context.switchToHttp().getRequest();
    const { method, url } = req;
    const now = Date.now();
    return next.handle().pipe(
      tap({
        next: () => {
          if (!url.startsWith('/api/health')) {
            this.logger.debug(`${method} ${url} ${Date.now() - now}ms`);
          }
        },
      }),
    );
  }
}
