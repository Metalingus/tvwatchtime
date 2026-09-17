import { Inject, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export const MODERATION_HTTP = Symbol('MODERATION_HTTP');
export type ModerationInput =
  { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
export interface ModerationResult {
  flagged: boolean;
  categories: Record<string, boolean>;
  categoryScores: Record<string, number>;
  model: string;
  decision: 'allow' | 'reject' | 'needs_manual_review';
}

// Keep automatic rejection focused on sexual content and clear abuse. Discussion of
// fictional violence, crime or self-harm is normal in TV/movie threads. Broad harassment
// flags can also catch character criticism, so require a higher score for that category.
// These are provider score cutoffs, not a contextual distinction between people/characters.
const thresholds: Record<string, number> = {
  'sexual/minors': 0.01,
  sexual: 0.5,
  hate: 0.8,
  'hate/threatening': 0.5,
  harassment: 0.9,
  'harassment/threatening': 0.5,
};

@Injectable()
export class ContentModerationService {
  constructor(
    private readonly config: ConfigService,
    @Optional() @Inject(MODERATION_HTTP) private readonly http?: typeof fetch,
  ) {}

  get enabled() {
    return !!this.config.get<string>('commentImages.openaiApiKey');
  }

  async moderateText(text: string): Promise<ModerationResult> {
    return this.moderate(text.trim() ? [{ type: 'text', text }] : []);
  }

  async moderate(input: ModerationInput[]): Promise<ModerationResult> {
    const model =
      this.config.get<string>('commentImages.openaiModerationModel') || 'omni-moderation-latest';
    if (!this.enabled || !input.length)
      return {
        flagged: false,
        categories: {},
        categoryScores: {},
        model: 'skipped',
        decision: 'allow',
      };
    if ((this.config.get('nodeEnv') === 'test' || process.env.NODE_ENV === 'test') && !this.http)
      throw new Error('Tests require an injected mock moderation transport');

    // Never truncate a caption/comment: its tail must be moderated too.
    let response: Response;
    try {
      response = await (this.http ?? fetch)('https://api.openai.com/v1/moderations', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + this.config.get<string>('commentImages.openaiApiKey'),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model, input }),
        signal: AbortSignal.timeout(8000),
        redirect: 'error',
      });
    } catch {
      throw new Error('Content moderation is unavailable');
    }
    // Provider error bodies can contain submitted content; never put them in logs.
    if (!response.ok) throw new Error('Content moderation failed (' + response.status + ')');
    const data = (await response.json().catch(() => null)) as { results?: unknown } | null;
    if (!data || !Array.isArray(data.results) || !data.results.length)
      throw new Error('Content moderation returned no valid results');
    const categories: Record<string, boolean> = Object.create(null);
    const categoryScores: Record<string, number> = Object.create(null);
    let flagged = false;
    for (const result of data.results) {
      if (
        typeof result?.flagged !== 'boolean' ||
        !result.categories ||
        !result.category_scores ||
        typeof result.categories !== 'object' ||
        Array.isArray(result.categories) ||
        typeof result.category_scores !== 'object' ||
        Array.isArray(result.category_scores)
      )
        throw new Error('Content moderation returned an invalid result');
      flagged ||= result.flagged;
      for (const [name, value] of Object.entries(result.categories)) {
        if (typeof value !== 'boolean') throw new Error('Invalid moderation category');
        categories[name] = (categories[name] ?? false) || value;
      }
      for (const [name, value] of Object.entries(result.category_scores)) {
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)
          throw new Error('Invalid moderation score');
        categoryScores[name] = Math.max(categoryScores[name] ?? 0, value);
      }
    }
    const reject =
      flagged &&
      Object.entries(thresholds).some(
        ([name, threshold]) => categories[name] && (categoryScores[name] ?? 0) >= threshold,
      );
    return { flagged, categories, categoryScores, model, decision: reject ? 'reject' : 'allow' };
  }
}
