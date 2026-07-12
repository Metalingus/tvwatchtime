import { AuthProvider } from './enums';
import type { ThemePreference, LanguagePreference } from './theme-locale';

export interface AuthSessionDto {
  accessToken: string;
  refreshToken: string;
  user: PublicUserDto;
}

export interface SocialLoginDto {
  provider: AuthProvider;
  /** OAuth ID token (Google/Apple) or access token (Facebook) */
  token: string;
  /** iOS Apple Sign-In authorization code fallback */
  authorizationCode?: string;
  nonce?: string;
  username?: string;
}

export interface EmailRegisterDto {
  email: string;
  username: string;
  password: string;
}

export interface EmailLoginDto {
  email: string;
  password: string;
}

export interface RefreshDto {
  refreshToken: string;
}

export interface DeviceRegisterDto {
  token: string;
  platform: 'IOS' | 'ANDROID' | 'WEB';
  appVersion?: string;
  timezone?: string;
}

export interface PublicUserDto {
  id: string;
  username: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  coverUrl?: string | null;
  bio?: string | null;
  followingCount: number;
  followersCount: number;
  commentsCount: number;
  createdAt: string;
}

export interface CurrentUserDto extends PublicUserDto {
  email: string;
  authProviders: AuthProvider[];
  isPrivate: boolean;
  mustChangePassword?: boolean;
  role?: string;
  themePreference?: ThemePreference;
  languagePreference?: LanguagePreference;
}

export interface UpdateProfileDto {
  username?: string;
  displayName?: string | null;
  bio?: string | null;
  avatarUrl?: string | null;
  coverUrl?: string | null;
  isPrivate?: boolean;
  themePreference?: ThemePreference;
  languagePreference?: LanguagePreference;
}
