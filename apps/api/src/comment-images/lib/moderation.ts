import { Injectable } from '@nestjs/common';
import {
  ContentModerationService,
  type ModerationInput,
} from '../../common/moderation/content-moderation.service';
export type { ModerationResult } from '../../common/moderation/content-moderation.service';

@Injectable()
export class ModerationService {
  constructor(private readonly moderation: ContentModerationService) {}
  get enabled() {
    return this.moderation.enabled;
  }

  async moderate(text: string, imageBuffer: Buffer, mimeType: string) {
    const input: ModerationInput[] = [];
    if (text?.trim()) input.push({ type: 'text', text });
    input.push({
      type: 'image_url',
      image_url: { url: 'data:' + mimeType + ';base64,' + imageBuffer.toString('base64') },
    });
    return this.moderation.moderate(input);
  }
}
