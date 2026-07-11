import { Body, Controller, Get, HttpCode, Post, Query, Redirect, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { ChangePasswordDto, EmailLoginDto, EmailRegisterDto, ForgotPasswordDto, RefreshDto, ResetPasswordDto, SocialLoginDto } from './dto/auth.dto';
import { Public } from '../common/decorators/public.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('register')
  register(@Body() dto: EmailRegisterDto) {
    return this.auth.register(dto);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  @HttpCode(200)
  login(@Body() dto: EmailLoginDto) {
    return this.auth.login(dto);
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('social')
  @HttpCode(200)
  social(@Body() dto: SocialLoginDto) {
    return this.auth.socialLogin(dto);
  }

  @ApiBearerAuth()
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('change-password')
  @HttpCode(200)
  changePassword(@CurrentUser('id') userId: string, @Body() dto: ChangePasswordDto) {
    return this.auth.changePassword(userId, dto.oldPassword, dto.newPassword);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('forgot-password')
  @HttpCode(200)
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.auth.forgotPassword(dto.email);
  }

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('reset-password')
  @HttpCode(200)
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.auth.resetPassword(dto.token, dto.newPassword);
  }

  @Public()
  @SkipThrottle()
  @Get('oauth-callback')
  @Redirect()
  oauthCallback(@Query() query: Record<string, string>) {
    const params = new URLSearchParams(query);
    // Detect web client via state param (state ends with :web)
    const state = params.get('state') || '';
    const isWeb = state.endsWith(':web');
    if (isWeb) {
      // Clean up state and redirect to web app URL
      params.set('state', state.replace(':web', ''));
      const cleanParams = params.toString();
      return { url: `https://app.tvwatchtime.org/expo-auth-session?${cleanParams}`, statusCode: 302 };
    }
    // Mobile: redirect to custom scheme
    return { url: `tvwatchtime://expo-auth-session?${params.toString()}`, statusCode: 302 };
  }
}
