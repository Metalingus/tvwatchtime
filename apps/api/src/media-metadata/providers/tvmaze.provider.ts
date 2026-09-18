import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Retired provider retained only for compatibility with old DI consumers. */
@Injectable()
export class TvmazeProvider {
  readonly enabled = false;
  constructor(_config: ConfigService) {}

  async getEpisodeAirTimes(
    _tvdb?: string,
    _imdb?: string,
  ): Promise<
    Map<
      string,
      {
        season: number;
        number: number;
        airtime: string | null;
        airstamp: string | null;
      }
    >
  > {
    return new Map();
  }
}
