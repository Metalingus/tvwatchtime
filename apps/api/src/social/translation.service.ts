import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { SUPPORTED_LOCALES, type SupportedLocale, type TranslatableTextDto } from '@tvwatch/shared';
import { createHash, randomUUID } from 'crypto';
import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
import { CapabilityService } from '../common/capability.service';
import { currentLanguage } from '../common/language.context';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';

const SUPPORTED = new Set<string>(SUPPORTED_LOCALES.map((locale) => locale.code));
const TRANSLATION_CACHE_VERSION = 2;
const AZURE_LOCALE: Partial<Record<SupportedLocale, string>> = {
  'pt-BR': 'pt',
  'zh-CN': 'zh-Hans',
};
const MENTION_RE = /@[A-Za-z0-9_]+/g;
const LAUGHTER_RE = /^(?:lol+|lmao+|rofl+|(?:ha){2,}|(?:he){2,})[\s.!?…]*$/iu;
const ALLOWED_TAGS = [
  'p',
  'br',
  'strong',
  'b',
  'em',
  'i',
  'ul',
  'ol',
  'li',
  'blockquote',
  'code',
  'pre',
  'a',
];

type CacheEntry = {
  cacheVersion?: number;
  sameLanguage?: boolean;
  text: string;
  html?: string | null;
  format: 'plain' | 'html';
  sourceHash: string;
  translatedAt: string;
};

export function isTranslationEligible(source: string): boolean {
  const withoutMentions = source.replace(MENTION_RE, '').trim();
  return !!withoutMentions && !LAUGHTER_RE.test(withoutMentions) && /\p{L}/u.test(withoutMentions);
}

@Injectable()
export class TranslationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    private readonly capabilities: CapabilityService,
  ) {}

  sanitizeReview(source: string): string {
    const parsed = marked.parse(source, { async: false, gfm: true, breaks: true }) as string;
    return this.sanitizeProviderHtml(parsed);
  }

  private sanitizeProviderHtml(html: string): string {
    return sanitizeHtml(html, {
      allowedTags: ALLOWED_TAGS,
      allowedAttributes: { a: ['href'] },
      allowedSchemes: ['http', 'https'],
      allowProtocolRelative: false,
    });
  }

  private plainText(html: string) {
    return sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} }).trim();
  }

  private hash(source: string) {
    return createHash('sha256').update(source).digest('hex');
  }

  content(
    original: string,
    translations: unknown,
    sourceLanguage?: string | null,
    format: 'plain' | 'html' = 'plain',
  ): TranslatableTextDto {
    const originalHtml = format === 'html' ? this.sanitizeReview(original) : null;
    const canonical = originalHtml ?? original;
    const entry = ((translations ?? {}) as Record<string, CacheEntry>)[currentLanguage()];
    const valid =
      entry?.cacheVersion === TRANSLATION_CACHE_VERSION && entry.sourceHash === this.hash(canonical)
        ? entry
        : null;
    const sameKnownLanguage = sourceLanguage
      ? this.baseLanguage(sourceLanguage) === this.baseLanguage(currentLanguage())
      : false;
    return {
      original,
      format,
      ...(originalHtml ? { originalHtml } : {}),
      sourceLanguage: sourceLanguage ?? null,
      eligible:
        !sameKnownLanguage &&
        isTranslationEligible(format === 'html' ? this.plainText(canonical) : original),
      translation:
        valid && !valid.sameLanguage
          ? {
              targetLanguage: currentLanguage(),
              sourceLanguage: sourceLanguage ?? null,
              text: valid.text,
              html: valid.html ?? null,
              format: valid.format,
              translatedAt: valid.translatedAt,
            }
          : null,
    };
  }

  /** User-requested provider translation. Only a short-lived cache; no provider row is stored. */
  async translateTransient(
    namespace: string,
    raw: string,
    language: string,
    mentions: { start: number | null; end: number | null }[] = [],
  ) {
    if (!SUPPORTED.has(language) || !isTranslationEligible(raw))
      throw new BadRequestException('This content does not need translation');
    if (!this.capabilities.commentTranslation)
      throw new ServiceUnavailableException('Comment translation is not configured');
    const key = 'translation:commsuni:' + namespace + ':' + language + ':' + this.hash(raw);
    const cached = await this.redis.get<{ text: string }>(key);
    if (cached) return cached;
    const target = language as SupportedLocale;
    const detected = await this.detect(raw);
    if (this.baseLanguage(detected.language) === this.baseLanguage(target)) return { text: raw };
    let input = '';
    let offset = 0;
    const protectedText: string[] = [];
    for (const mention of [...mentions].sort((a, b) => (a.start ?? -1) - (b.start ?? -1))) {
      if (
        mention.start == null ||
        mention.end == null ||
        mention.start < offset ||
        mention.end <= mention.start ||
        mention.end > raw.length
      )
        continue;
      input += this.escapeHtml(raw.slice(offset, mention.start));
      const value = raw.slice(mention.start, mention.end);
      protectedText.push(value);
      input += '<span translate="no">' + this.escapeHtml(value) + '</span>';
      offset = mention.end;
    }
    input += this.escapeHtml(raw.slice(offset));
    const translated = await this.azureTranslate(this.protectMentions(input), target);
    const text = this.plainText(this.sanitizeProviderHtml(translated.text));
    if (protectedText.some((value) => !text.includes(value)))
      throw new BadGatewayException('Translation changed a mention');
    const result = { text };
    await this.redis.set(key, result, 60);
    return result;
  }

  async translateComment(id: string, targetLanguage: string) {
    const row = await this.prisma.comment.findUnique({ where: { id } });
    if (!row || row.hidden || row.adminDeleted || row.deletedByUser) {
      throw new NotFoundException('Comment not found');
    }
    return this.translateAndStore('comment', row, targetLanguage);
  }

  async translateReview(id: string, targetLanguage: string) {
    const row = await this.prisma.externalReview.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Review not found');
    return this.translateAndStore('review', row, targetLanguage);
  }

  private async translateAndStore(kind: 'comment' | 'review', row: any, language: string) {
    if (!SUPPORTED.has(language)) throw new BadRequestException('Unsupported language');
    const target = language as SupportedLocale;
    const raw = kind === 'comment' ? row.body : row.content;
    const format = kind === 'review' ? 'html' : 'plain';
    const canonical = format === 'html' ? this.sanitizeReview(raw) : raw;
    if (!isTranslationEligible(format === 'html' ? this.plainText(canonical) : canonical)) {
      throw new BadRequestException('This content does not need translation');
    }
    const sourceHash = this.hash(canonical);
    const cached = ((row.translations ?? {}) as Record<string, CacheEntry>)[target];
    if (cached?.cacheVersion === TRANSLATION_CACHE_VERSION && cached.sourceHash === sourceHash) {
      return this.result(cached, row.language ?? 'unknown', target, true);
    }
    if (!this.capabilities.commentTranslation) {
      throw new ServiceUnavailableException('Comment translation is not configured');
    }

    const lockKey = `translation:${kind}:${row.id}:${target}:${sourceHash}`;
    const token = randomUUID();
    if ((await this.redis.client.set(lockKey, token, 'EX', 30, 'NX')) !== 'OK') {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const refreshed =
        kind === 'comment'
          ? await this.prisma.comment.findUnique({
              where: { id: row.id },
              select: { language: true, translations: true },
            })
          : await this.prisma.externalReview.findUnique({
              where: { id: row.id },
              select: { language: true, translations: true },
            });
      const shared = ((refreshed?.translations ?? {}) as Record<string, CacheEntry>)[target];
      if (shared?.cacheVersion === TRANSLATION_CACHE_VERSION && shared.sourceHash === sourceHash) {
        return this.result(shared, refreshed?.language ?? 'unknown', target, true);
      }
      throw new ServiceUnavailableException('Translation is already in progress');
    }

    try {
      const table =
        kind === 'comment' ? Prisma.raw('"comments"') : Prisma.raw('"external_reviews"');
      const detection = await this.detect(raw);
      const input = format === 'html' ? canonical : this.escapeHtml(canonical);
      const translated = await this.azureTranslate(this.protectMentions(input), target);
      // Translate's contextual auto-detection is more reliable for short prose than the standalone
      // Detect result. Keep Detect as the required first pass, but prefer Translate's result when
      // the two disagree instead of forcing translation from the wrong language.
      const sourceLanguage = translated.sourceLanguage ?? detection.language;
      await this.prisma.$executeRaw(
        Prisma.sql`UPDATE ${table} SET "language" = ${sourceLanguage} WHERE "id" = ${row.id}`,
      );
      if (this.baseLanguage(sourceLanguage) === this.baseLanguage(target)) {
        const entry: CacheEntry = {
          cacheVersion: TRANSLATION_CACHE_VERSION,
          sameLanguage: true,
          text: format === 'html' ? this.plainText(canonical) : canonical,
          format,
          sourceHash,
          translatedAt: new Date().toISOString(),
        };
        await this.prisma.$executeRaw(
          Prisma.sql`UPDATE ${table}
            SET "language" = ${sourceLanguage},
                "translations" = jsonb_set(COALESCE("translations", '{}'::jsonb), ARRAY[${target}], ${JSON.stringify(entry)}::jsonb, true)
            WHERE "id" = ${row.id}`,
        );
        return this.result(entry, sourceLanguage, target, false);
      }
      const safeHtml = this.sanitizeProviderHtml(translated.text);
      const sourceMentions = raw.match(MENTION_RE) ?? [];
      const outputMentions = safeHtml.match(MENTION_RE) ?? [];
      if (sourceMentions.join('\u0000') !== outputMentions.join('\u0000')) {
        throw new BadGatewayException('Translation provider changed a username mention');
      }
      const entry: CacheEntry = {
        cacheVersion: TRANSLATION_CACHE_VERSION,
        text: this.plainText(safeHtml),
        ...(format === 'html' ? { html: safeHtml } : {}),
        format,
        sourceHash,
        translatedAt: new Date().toISOString(),
      };
      await this.prisma.$executeRaw(
        Prisma.sql`UPDATE ${table}
          SET "language" = ${sourceLanguage},
              "translations" = jsonb_set(COALESCE("translations", '{}'::jsonb), ARRAY[${target}], ${JSON.stringify(entry)}::jsonb, true)
          WHERE "id" = ${row.id}`,
      );
      return this.result(entry, sourceLanguage, target, false);
    } finally {
      const release =
        "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";
      await this.redis.client.eval(release, 1, lockKey, token).catch(() => undefined);
    }
  }

  private result(
    entry: CacheEntry,
    sourceLanguage: string,
    target: SupportedLocale,
    cached: boolean,
  ) {
    return {
      targetLanguage: target,
      sourceLanguage,
      text: entry.text,
      html: entry.html ?? null,
      format: entry.format,
      translatedAt: entry.translatedAt,
      cached,
      sameLanguage: entry.sameLanguage ?? false,
    };
  }

  private async detect(text: string): Promise<{ language: string; score: number }> {
    const result = await this.azure('/detect?api-version=3.0', [{ text }]);
    const detected = result?.[0];
    if (!detected?.language || detected.score < 0.5) {
      throw new BadGatewayException('Could not detect the comment language');
    }
    return { language: detected.language, score: detected.score };
  }

  private async azureTranslate(html: string, target: SupportedLocale) {
    const to = AZURE_LOCALE[target] ?? target;
    const result = await this.azure(
      `/translate?api-version=3.0&to=${encodeURIComponent(to)}&textType=html`,
      [{ text: html }],
    );
    const value = result?.[0]?.translations?.[0]?.text;
    if (!value) throw new BadGatewayException('Translation provider returned no text');
    return {
      text: value as string,
      sourceLanguage: result?.[0]?.detectedLanguage?.language as string | undefined,
    };
  }

  private async azure(path: string, body: unknown): Promise<any> {
    const endpoint = this.config.get<string>('translations.azureEndpoint')!.replace(/\/$/, '');
    const key = this.config.get<string>('translations.azureKey')!;
    const region = this.config.get<string>('translations.azureRegion')!;
    let lastStatus = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await fetch(`${endpoint}${path}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Ocp-Apim-Subscription-Key': key,
            'Ocp-Apim-Subscription-Region': region,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        lastStatus = response.status;
        if (response.ok) return response.json();
        if (response.status !== 429 && response.status < 500) break;
        const seconds = Number(response.headers.get('retry-after') ?? 0);
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(2000, seconds * 1000 || 250 * (attempt + 1))),
        );
      } catch {
        if (attempt === 2)
          throw new ServiceUnavailableException('Translation provider unavailable');
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new BadGatewayException(`Translation provider failed (${lastStatus || 'network'})`);
  }

  private protectMentions(html: string) {
    return html.replace(MENTION_RE, (mention) => `<span translate="no">${mention}</span>`);
  }

  private escapeHtml(value: string) {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  private baseLanguage(value: string) {
    return value.toLowerCase().split('-')[0];
  }
}
