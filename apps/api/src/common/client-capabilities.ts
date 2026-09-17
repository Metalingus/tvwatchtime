import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';
import { Observable } from 'rxjs';
import { COMMSUNI_CLIENT_HEADER, COMMSUNI_CLIENT_VERSION } from '@tvwatch/shared';

const clients = new AsyncLocalStorage<boolean>();

/** No request context means trusted internal/background work, not an old HTTP client. */
export const isLegacyClientRequest = () => clients.getStore() === false;
export function runWithCommsUniClient<T>(supported: boolean, action: () => T): T {
  return clients.run(supported, action);
}

@Injectable()
export class ClientCapabilitiesInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest();
    context.switchToHttp().getResponse().vary(COMMSUNI_CLIENT_HEADER);
    const supported =
      request.headers?.[COMMSUNI_CLIENT_HEADER.toLowerCase()] === COMMSUNI_CLIENT_VERSION;
    return new Observable((subscriber) =>
      runWithCommsUniClient(supported, () => next.handle().subscribe(subscriber)),
    );
  }
}
