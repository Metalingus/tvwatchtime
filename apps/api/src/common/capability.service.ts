import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface CapabilityFlags {
  commentImages: boolean;
  userImageStorage: 's3' | 'local';
  moderation: boolean;
  socialGoogle: boolean;
  socialFacebook: boolean;
  socialApple: boolean;
  push: boolean;
  tmdb: boolean;
  tvmaze: boolean;
}

@Injectable()
export class CapabilityService implements OnModuleInit {
  private flags: CapabilityFlags = {
    commentImages: false,
    userImageStorage: 'local',
    moderation: false,
    socialGoogle: false,
    socialFacebook: false,
    socialApple: false,
    push: false,
    tmdb: false,
    tvmaze: false,
  };

  constructor(private readonly config: ConfigService) {}

  async onModuleInit() {
    this.refresh();
  }

  /** Recompute capabilities from current config. Call on startup or after settings change + restart. */
  refresh() {
    const s3AccessKey = this.config.get<string>('commentImages.s3AccessKeyId');
    const s3Secret = this.config.get<string>('commentImages.s3SecretAccessKey');
    const s3Endpoint = this.config.get<string>('commentImages.s3Endpoint');
    const s3Configured = !!(s3Endpoint || (s3AccessKey && s3Secret));

    const googleClientId = this.config.get<string>('auth.google.clientId');
    const googleClientSecret = this.config.get<string>('auth.google.clientSecret');
    const facebookAppId = this.config.get<string>('auth.facebook.appId');
    const facebookAppSecret = this.config.get<string>('auth.facebook.appSecret');
    const appleClientId = this.config.get<string>('auth.apple.clientId');

    const openaiKey = this.config.get<string>('commentImages.openaiApiKey');
    const expoToken = this.config.get<string>('push.expoAccessToken');
    const pushMode = this.config.get<string>('metadata.pushMode') || 'expo';

    const tmdbKey = this.config.get<string>('metadata.tmdbApiKey');
    const tvmazeEnabled = this.config.get<boolean>('metadata.tvmazeEnabled') !== false;
    const tvmazeKey = this.config.get<string>('metadata.tvmazeApiKey');

    this.flags = {
      commentImages: s3Configured,
      userImageStorage: s3Configured ? 's3' : 'local',
      moderation: !!openaiKey,
      socialGoogle: !!(googleClientId && googleClientSecret),
      socialFacebook: !!(facebookAppId && facebookAppSecret),
      socialApple: !!appleClientId,
      push: pushMode !== 'none' && (!!expoToken || pushMode === 'relay'),
      tmdb: !!tmdbKey,
      tvmaze: tvmazeEnabled && !!tvmazeKey,
    };
  }

  get all(): CapabilityFlags {
    return { ...this.flags };
  }

  get commentImages(): boolean {
    return this.flags.commentImages;
  }

  get userImageStorage(): 's3' | 'local' {
    return this.flags.userImageStorage;
  }

  get moderation(): boolean {
    return this.flags.moderation;
  }
}
