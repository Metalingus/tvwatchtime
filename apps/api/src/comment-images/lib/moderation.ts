import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface ModerationResult {
  flagged: boolean;
  categories: Record<string, boolean>;
  categoryScores: Record<string, number>;
  model: string;
  decision: 'allow' | 'reject' | 'needs_manual_review';
}

@Injectable()
export class ModerationService {
  private readonly logger = new Logger(ModerationService.name);
  private readonly apiKey: string | undefined;
  private readonly model: string;

  constructor(config: ConfigService) {
    this.apiKey = config.get<string>('commentImages.openaiApiKey');
    this.model = config.get<string>('commentImages.openaiModerationModel') || 'omni-moderation-latest';
  }

  get enabled() {
    return !!this.apiKey;
  }

  async moderate(text: string, imageBuffer: Buffer, mimeType: string): Promise<ModerationResult> {
    if (!this.apiKey) {
      this.logger.log('Skipping moderation (no OPENAI_API_KEY configured)');
      return { flagged: false, categories: {}, categoryScores: {}, model: 'skipped', decision: 'allow' };
    }

    const b64 = imageBuffer.toString('base64');
    const dataUrl = `data:${mimeType};base64,${b64}`;

    const inputs: any[] = [];
    if (text?.trim()) inputs.push({ type: 'text', text: text.slice(0, 2000) });
    inputs.push({ type: 'image_url', image_url: { url: dataUrl } });

    const res = await fetch('https://api.openai.com/v1/moderations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: inputs }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenAI moderation failed (${res.status}): ${body.slice(0, 300)}`);
    }

    const data: any = await res.json();
    const result = data.results?.[0];
    if (!result) throw new Error('OpenAI moderation returned no results');

    const flagged: boolean = result.flagged;
    const categories: Record<string, boolean> = result.categories ?? {};
    const categoryScores: Record<string, number> = result.category_scores ?? {};

    let decision: ModerationResult['decision'] = 'allow';
    if (flagged) {
      // Reject sexual/minors, violence, self-harm, hate, illicit immediately
      const hardReject = ['sexual/minors', 'sexual', 'violence', 'violence/graphic', 'self-harm', 'self-harm/intent', 'self-harm/instructions', 'hate', 'hate/threatening', 'harassment', 'harassment/threatening', 'illicit', 'illicit/violence'];
      const shouldReject = hardReject.some((k) => categories[k]);
      decision = shouldReject ? 'reject' : 'needs_manual_review';
    }

    return { flagged, categories, categoryScores, model: this.model, decision };
  }
}
