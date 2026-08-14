export type IntegrationProvider = 'SIMKL' | 'STREMIO' | 'JELLYFIN';
export type IntegrationSyncStatus = 'IDLE' | 'SYNCING' | 'SUCCESS' | 'FAILED';
export type IntegrationCapability = 'WATCHED' | 'WATCHLIST' | 'FAVORITES' | 'RATINGS';

export interface IntegrationMediaSyncSettings {
  watched: boolean;
  watchlist: boolean;
  favorites: boolean;
  ratings: boolean;
}

export interface IntegrationSyncSettings {
  movies: IntegrationMediaSyncSettings;
  shows: IntegrationMediaSyncSettings;
}

export interface UpdateIntegrationSettingsDto {
  paused?: boolean;
  syncSettings?: Partial<{
    movies: Partial<IntegrationMediaSyncSettings>;
    shows: Partial<IntegrationMediaSyncSettings>;
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
}

export interface IntegrationLinkStartDto {
  provider: 'SIMKL' | 'STREMIO';
  code: string;
  verificationUrl: string;
  expiresAt: string;
  pollAfterSeconds: number;
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
}
