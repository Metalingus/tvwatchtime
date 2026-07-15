import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SettingService } from '../../../common/setting.service';
import type { ProviderRateSettings } from './rate-limiter';

export interface ProviderResilienceConfig extends ProviderRateSettings {
  /** Lowercase provider tag (Redis keys/metrics). */
  tag: string;
  baseUrl?: string;
  timeoutMs: number;
  maxRetries: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  cacheTtlSec: number;
  negativeCacheTtlSec: number;
}

export interface ProviderCredentials {
  apiKey?: string;
  pin?: string;
}

interface ProviderSpec {
  /** Lowercase provider tag used in Redis keys/metrics (e.g. 'tvdb'). */
  tag: string;
  enabledKey: string;
  enabledDefault: boolean;
  rpsKey: string;
  rpmKey: string;
  concurrencyKey: string;
  timeoutKey: string;
  retriesKey: string;
  backoffBaseKey: string;
  backoffMaxKey: string;
  cacheTtlKey: string;
  negCacheTtlKey: string;
  baseUrlKey?: string;
  baseUrlDefault?: string;
  apiKeyKey?: string;
  apiKeyEnv?: string;
  pinKey?: string;
  pinEnv?: string;
  requiresKey: boolean;
  defaults: {
    rps: number;
    rpm: number;
    concurrency: number;
    timeoutMs: number;
    maxRetries: number;
    backoffBaseMs: number;
    backoffMaxMs: number;
    cacheTtlSec: number;
    negativeCacheTtlSec: number;
  };
}

/**
 * Single source of provider resilience/configuration with precedence
 * **validated admin override (SettingService) > env (configuration.ts) > safe default**.
 * Secrets are read via getDecrypted and are NEVER returned through getAll/metrics.
 */
@Injectable()
export class ProviderConfigService {
  constructor(
    private readonly settings: SettingService,
    private readonly config: ConfigService,
  ) {}

  private async build(spec: ProviderSpec): Promise<ProviderResilienceConfig> {
    const enabledFlag = await this.settings.getBool(spec.enabledKey, spec.enabledDefault);
    const creds = await this.credentials(spec);
    const enabled = enabledFlag && (!spec.requiresKey || !!creds.apiKey);
    const rps = await this.settings.getNumber(spec.rpsKey, this.env(spec.rpsKey, spec.defaults.rps));
    const rpm = await this.settings.getNumber(spec.rpmKey, this.env(spec.rpmKey, spec.defaults.rpm));
    const concurrency = await this.settings.getNumber(
      spec.concurrencyKey,
      this.env(spec.concurrencyKey, spec.defaults.concurrency),
    );
    const timeoutMs = await this.settings.getNumber(spec.timeoutKey, this.env(spec.timeoutKey, spec.defaults.timeoutMs));
    const maxRetries = await this.settings.getNumber(spec.retriesKey, this.env(spec.retriesKey, spec.defaults.maxRetries));
    const backoffBaseMs = await this.settings.getNumber(
      spec.backoffBaseKey,
      this.env(spec.backoffBaseKey, spec.defaults.backoffBaseMs),
    );
    const backoffMaxMs = await this.settings.getNumber(
      spec.backoffMaxKey,
      this.env(spec.backoffMaxKey, spec.defaults.backoffMaxMs),
    );
    const cacheTtlSec = await this.settings.getNumber(spec.cacheTtlKey, this.env(spec.cacheTtlKey, spec.defaults.cacheTtlSec));
    const negativeCacheTtlSec = await this.settings.getNumber(
      spec.negCacheTtlKey,
      this.env(spec.negCacheTtlKey, spec.defaults.negativeCacheTtlSec),
    );
    const baseUrl = spec.baseUrlKey
      ? (await this.settings.get(spec.baseUrlKey, '')) || this.env(spec.baseUrlKey, spec.baseUrlDefault ?? '')
      : spec.baseUrlDefault;
    return {
      tag: spec.tag,
      enabled,
      rps,
      rpm,
      concurrency,
      timeoutMs,
      maxRetries,
      backoffBaseMs,
      backoffMaxMs,
      cacheTtlSec,
      negativeCacheTtlSec,
      baseUrl: baseUrl || undefined,
    };
  }

  /** envOr fallback through ConfigService (flat keys exposed in configuration.ts). */
  private env<T>(key: string, fallback: T): T {
    const v = this.config.get<T>(key);
    return v === undefined ? fallback : v;
  }

  private async credentials(spec: ProviderSpec): Promise<ProviderCredentials> {
    const out: ProviderCredentials = {};
    if (spec.apiKeyKey) {
      const dec = (await this.settings.getDecrypted(spec.apiKeyKey)) || '';
      out.apiKey = dec || (spec.apiKeyEnv ? this.config.get<string>(spec.apiKeyEnv) : undefined);
    }
    if (spec.pinKey) {
      const dec = (await this.settings.getDecrypted(spec.pinKey)) || '';
      out.pin = dec || (spec.pinEnv ? this.config.get<string>(spec.pinEnv) : undefined);
    }
    return out;
  }

  // ---- Per-provider specs ----

  private static readonly TMDB: ProviderSpec = {
    tag: 'tmdb',
    enabledKey: 'TMDB_ENABLED',
    enabledDefault: true,
    rpsKey: 'TMDB_REQUESTS_PER_SECOND',
    rpmKey: 'TMDB_REQUESTS_PER_MINUTE',
    concurrencyKey: 'TMDB_CONCURRENCY',
    timeoutKey: 'TMDB_TIMEOUT_MS',
    retriesKey: 'TMDB_MAX_RETRIES',
    backoffBaseKey: 'TMDB_BACKOFF_BASE_MS',
    backoffMaxKey: 'TMDB_BACKOFF_MAX_MS',
    cacheTtlKey: 'TMDB_CACHE_TTL_SECONDS',
    negCacheTtlKey: 'TMDB_NEGATIVE_CACHE_TTL_SECONDS',
    apiKeyKey: 'TMDB_API_KEY',
    apiKeyEnv: 'metadata.tmdbApiKey',
    requiresKey: true,
    defaults: {
      rps: 40,
      rpm: 0,
      concurrency: 0,
      timeoutMs: 10000,
      maxRetries: 4,
      backoffBaseMs: 500,
      backoffMaxMs: 30000,
      cacheTtlSec: 86400,
      negativeCacheTtlSec: 3600,
    },
  };

  private static readonly TVDB: ProviderSpec = {
    tag: 'tvdb',
    enabledKey: 'TVDB_ENABLED',
    enabledDefault: true,
    rpsKey: 'TVDB_REQUESTS_PER_SECOND',
    rpmKey: 'TVDB_REQUESTS_PER_MINUTE',
    concurrencyKey: 'TVDB_CONCURRENCY',
    timeoutKey: 'TVDB_TIMEOUT_MS',
    retriesKey: 'TVDB_MAX_RETRIES',
    backoffBaseKey: 'TVDB_BACKOFF_BASE_MS',
    backoffMaxKey: 'TVDB_BACKOFF_MAX_MS',
    cacheTtlKey: 'TVDB_CACHE_TTL_SECONDS',
    negCacheTtlKey: 'TVDB_NEGATIVE_CACHE_TTL_SECONDS',
    apiKeyKey: 'TVDB_API_KEY',
    apiKeyEnv: 'metadata.tvdbApiKey',
    pinKey: 'TVDB_PIN',
    pinEnv: 'metadata.tvdbPin',
    requiresKey: true,
    defaults: {
      rps: 2,
      rpm: 60,
      concurrency: 2,
      timeoutMs: 10000,
      maxRetries: 5,
      backoffBaseMs: 500,
      backoffMaxMs: 30000,
      cacheTtlSec: 86400,
      negativeCacheTtlSec: 3600,
    },
  };

  private static readonly KITSU: ProviderSpec = {
    tag: 'kitsu',
    enabledKey: 'KITSU_ENABLED',
    enabledDefault: true,
    rpsKey: 'KITSU_REQUESTS_PER_SECOND',
    rpmKey: 'KITSU_REQUESTS_PER_MINUTE',
    concurrencyKey: 'KITSU_CONCURRENCY',
    timeoutKey: 'KITSU_TIMEOUT_MS',
    retriesKey: 'KITSU_MAX_RETRIES',
    backoffBaseKey: 'KITSU_BACKOFF_BASE_MS',
    backoffMaxKey: 'KITSU_BACKOFF_MAX_MS',
    cacheTtlKey: 'KITSU_CACHE_TTL_SECONDS',
    negCacheTtlKey: 'KITSU_NEGATIVE_CACHE_TTL_SECONDS',
    baseUrlKey: 'KITSU_BASE_URL',
    baseUrlDefault: 'https://kitsu.app/api/edge',
    requiresKey: false,
    defaults: {
      rps: 3,
      rpm: 60,
      concurrency: 2,
      timeoutMs: 10000,
      maxRetries: 5,
      backoffBaseMs: 500,
      backoffMaxMs: 30000,
      cacheTtlSec: 86400,
      negativeCacheTtlSec: 3600,
    },
  };

  private static readonly JIKAN: ProviderSpec = {
    tag: 'jikan',
    enabledKey: 'JIKAN_ENABLED',
    enabledDefault: true,
    rpsKey: 'JIKAN_REQUESTS_PER_SECOND',
    rpmKey: 'JIKAN_REQUESTS_PER_MINUTE',
    concurrencyKey: 'JIKAN_CONCURRENCY',
    timeoutKey: 'JIKAN_TIMEOUT_MS',
    retriesKey: 'JIKAN_MAX_RETRIES',
    backoffBaseKey: 'JIKAN_BACKOFF_BASE_MS',
    backoffMaxKey: 'JIKAN_BACKOFF_MAX_MS',
    cacheTtlKey: 'JIKAN_CACHE_TTL_SECONDS',
    negCacheTtlKey: 'JIKAN_NEGATIVE_CACHE_TTL_SECONDS',
    baseUrlKey: 'JIKAN_BASE_URL',
    baseUrlDefault: 'https://api.jikan.moe/v4',
    requiresKey: false,
    defaults: {
      rps: 3,
      rpm: 60,
      concurrency: 2,
      timeoutMs: 15000,
      maxRetries: 5,
      backoffBaseMs: 750,
      backoffMaxMs: 60000,
      cacheTtlSec: 86400,
      negativeCacheTtlSec: 3600,
    },
  };

  tmdb() {
    return this.build(ProviderConfigService.TMDB);
  }
  tvdb() {
    return this.build(ProviderConfigService.TVDB);
  }
  kitsu() {
    return this.build(ProviderConfigService.KITSU);
  }
  jikan() {
    return this.build(ProviderConfigService.JIKAN);
  }

  /** Credentials only (decrypted); used by the owning client, never serialized to admin UI. */
  tmdbCredentials() {
    return this.credentials(ProviderConfigService.TMDB);
  }
  tvdbCredentials() {
    return this.credentials(ProviderConfigService.TVDB);
  }

  /** Jikan readiness is separate from container health (empty index ≠ ready). */
  async jikanReadiness(): Promise<{ configured: boolean; healthy: boolean; hasData: boolean }> {
    const cfg = await this.jikan();
    return { configured: cfg.enabled, healthy: cfg.enabled, hasData: cfg.enabled };
  }
}
