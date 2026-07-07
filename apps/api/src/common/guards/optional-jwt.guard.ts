import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Attaches the user when a valid token is present, but allows anonymous access.
 * Used by public discovery/search endpoints that personalize results.
 */
@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const auth = req.headers['authorization'] || '';
    if (!auth.startsWith('Bearer ')) return true;
    try {
      await super.canActivate(context);
    } catch {
      // ignore invalid token on optional routes
    }
    return true;
  }

  handleRequest(err: any, user: any) {
    return user;
  }
}
