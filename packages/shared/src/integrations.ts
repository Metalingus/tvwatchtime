export type IntegrationProvider = 'SIMKL' | 'STREMIO' | 'JELLYFIN' | 'PLEX' | 'EMBY';
export type IntegrationOpenClient = 'AUTO' | 'WEB' | 'EMBY' | 'SWIFTFIN';
export type IntegrationOpenPlatform = 'ios' | 'android' | 'web';
export type IntegrationSyncStatus = 'IDLE' | 'SYNCING' | 'SUCCESS' | 'FAILED';
export type IntegrationCapability =
  'WATCHED' | 'WATCHLIST' | 'FAVORITES' | 'RATINGS' | 'COLLECTIONS';

export interface IntegrationMediaSyncSettings {
  watched: boolean;
  watchlist: boolean;
  favorites: boolean;
  ratings: boolean;
}

export interface IntegrationSyncSettings {
  movies: IntegrationMediaSyncSettings;
  shows: IntegrationMediaSyncSettings;
  collections: boolean;
}

export interface UpdateIntegrationSettingsDto {
  paused?: boolean;
  preferredOpenClient?: IntegrationOpenClient;
  syncSettings?: Partial<{
    movies: Partial<IntegrationMediaSyncSettings>;
    shows: Partial<IntegrationMediaSyncSettings>;
    collections: boolean;
  }>;
}

export interface IntegrationDto {
  provider: IntegrationProvider;
  available: boolean;
  connected: boolean;
  displayName?: string | null;
  serverUrl?: string | null;
  connectedAt?: string | null;
  lastSyncedAt?: string | null;
  lastSyncStatus: IntegrationSyncStatus;
  lastSyncError?: string | null;
  lastImportId?: string | null;
  capabilities: IntegrationCapability[];
  paused: boolean;
  itemsDisabled: boolean;
  syncedItemCount: number;
  syncSettings: IntegrationSyncSettings;
  preferredOpenClient: IntegrationOpenClient;
}

export interface IntegrationLinkStartDto {
  provider: 'SIMKL' | 'STREMIO' | 'PLEX';
  code: string;
  verificationUrl: string;
  expiresAt: string;
  pollAfterSeconds: number;
}

export interface PlexServerDto {
  machineIdentifier: string;
  name: string;
  owned: boolean;
}

export interface PlexServerSelectionDto {
  provider: 'PLEX';
  servers: PlexServerDto[];
}

export interface IntegrationConnectionResultDto {
  provider: IntegrationProvider;
  connected: true;
}

export interface IntegrationSyncResultDto {
  provider: IntegrationProvider;
  importId: string;
  received: number;
  matched: number;
  unmatched: number;
  created: number;
  skipped: number;
}

export interface IntegrationDataActionResultDto {
  provider: IntegrationProvider;
  removed: number;
  transferred: number;
  preserved: number;
  itemsDisabled: boolean;
}

export interface IntegrationOpenTargetDto {
  provider: IntegrationProvider;
  name: string;
  url: string;
  nativeUrl?: string | null;
}
