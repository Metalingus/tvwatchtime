import { AuthProvider } from './enums';
import type { ThemePreference, LanguagePreference } from './theme-locale';
import type { MediaTagSlug } from './discovery';

export interface ExploreDefaultFilters {
  genre: string | null;
  excludeGenres: string[];
  order: 'popularity' | 'releaseDate';
  mediaType: 'both' | 'movies' | 'shows';
  country: string | null;
  hideAnime: boolean;
  /** Optional for compatibility with profiles saved before curated tags existed. */
  tags?: MediaTagSlug[];
}

export interface AuthSessionDto {
  accessToken: string;
  refreshToken: string;
  user: CurrentUserDto;
}

export enum AuthErrorCode {
  APPLE_AUTH_UNAVAILABLE = 'APPLE_AUTH_UNAVAILABLE',
  APPLE_IDENTITY_TOKEN_MISSING = 'APPLE_IDENTITY_TOKEN_MISSING',
  APPLE_AUTHORIZATION_CODE_MISSING = 'APPLE_AUTHORIZATION_CODE_MISSING',
  APPLE_INVALID_TOKEN = 'APPLE_INVALID_TOKEN',
  APPLE_INVALID_SIGNATURE = 'APPLE_INVALID_SIGNATURE',
  APPLE_INVALID_ISSUER = 'APPLE_INVALID_ISSUER',
  APPLE_INVALID_AUDIENCE = 'APPLE_INVALID_AUDIENCE',
  APPLE_TOKEN_EXPIRED = 'APPLE_TOKEN_EXPIRED',
  APPLE_INVALID_NONCE = 'APPLE_INVALID_NONCE',
  APPLE_INVALID_STATE = 'APPLE_INVALID_STATE',
  APPLE_CODE_ALREADY_CONSUMED = 'APPLE_CODE_ALREADY_CONSUMED',
  APPLE_PROVIDER_UNAVAILABLE = 'APPLE_PROVIDER_UNAVAILABLE',
  ACCOUNT_EXISTS_WITH_DIFFERENT_PROVIDER = 'ACCOUNT_EXISTS_WITH_DIFFERENT_PROVIDER',
  ACCOUNT_DISABLED = 'ACCOUNT_DISABLED',
  ACCOUNT_DELETED = 'ACCOUNT_DELETED',
}

export interface AppleAuthNonceDto {
  nonce: string;
  state: string;
  expiresInSeconds: number;
}

export interface AppleFullNameDto {
  namePrefix?: string | null;
  givenName?: string | null;
  middleName?: string | null;
  familyName?: string | null;
  nameSuffix?: string | null;
  nickname?: string | null;
}

export interface AppleLoginDto {
  identityToken: string;
  authorizationCode: string;
  nonce: string;
  state: string;
  fullName?: AppleFullNameDto | null;
  email?: string | null;
}

export interface SocialLoginDto {
  provider: AuthProvider;
  /** OAuth ID token (Google) or access token (Facebook) */
  token?: string;
  /** OAuth authorization code used by browser-based providers. */
  authorizationCode?: string;
  nonce?: string;
  username?: string;
  redirectUri?: string;
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
  /** True for the system "Deleted user" account (comments of deleted accounts) — render a
   *  localized "Deleted user" name and suppress profile links/avatar. */
  isDeletedUser?: boolean;
}

export interface CurrentUserDto extends PublicUserDto {
  email: string;
  authProviders: AuthProvider[];
  isPrivate: boolean;
  hideAnimeInExplore: boolean;
  exploreDefaultFilters?: ExploreDefaultFilters | null;
  mustChangePassword?: boolean;
  onboardingStatus?: import('./onboarding').OnboardingStatus;
  onboardingVersion?: number | null;
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
  hideAnimeInExplore?: boolean;
  exploreDefaultFilters?: ExploreDefaultFilters | null;
  themePreference?: ThemePreference;
  languagePreference?: LanguagePreference;
}
