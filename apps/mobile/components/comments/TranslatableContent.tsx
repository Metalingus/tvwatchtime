import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Linking, Pressable, StyleProp, TextStyle, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import RenderHtml from 'react-native-render-html';
import {
  SUPPORTED_LOCALES,
  type SupportedLocale,
  type TranslatableTextDto,
  type TranslationResultDto,
  type TranslationValueDto,
  type CommsUniMention,
  type ConversationType,
} from '@tvwatch/shared';
import { useTranslation } from 'react-i18next';
import { useFeatureFlags, useTranslateContent } from '../../api/hooks';
import { useAppearance } from '../../context/PreferencesProvider';
import { showDialog } from '../../lib/dialog';
import { spacing } from '../../theme/theme';
import { useContentWidth } from '../../hooks/useContentWidth';
import { T } from '../primitives';

export function TranslatableContent({
  id,
  kind,
  content,
  style,
  conversation,
  mentions = [],
}: {
  id: string;
  kind: 'comment' | 'review';
  content: TranslatableTextDto;
  style?: StyleProp<TextStyle>;
  conversation?: { threadType: ConversationType; threadId: string };
  mentions?: CommsUniMention[];
}) {
  const { tokens, resolvedLocale } = useAppearance();
  const { t } = useTranslation(['comments']);
  const flags = useFeatureFlags();
  const mutation = useTranslateContent();
  const [target, setTarget] = useState<SupportedLocale>(resolvedLocale as SupportedLocale);
  const [translation, setTranslation] = useState<TranslationValueDto | TranslationResultDto | null>(
    content.translation ?? null,
  );
  const [translated, setTranslated] = useState(!!content.translation);
  const [sameLanguage, setSameLanguage] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const width = useContentWidth();
  const translationContext = JSON.stringify([
    id,
    content.original,
    resolvedLocale,
    conversation?.threadType,
    conversation?.threadId,
  ]);
  const currentContext = useRef(translationContext);
  currentContext.current = translationContext;

  useEffect(() => {
    setTarget(resolvedLocale as SupportedLocale);
    setTranslation(content.translation ?? null);
    setTranslated(!!content.translation);
    setSameLanguage(false);
    setNotice(null);
  }, [id, content.original, content.translation, resolvedLocale]);

  const canRequest = flags.data?.comment_translation ?? false;
  // A cached translation must always remain reversible, even if a later language-detection
  // response marks the original as ineligible for a new translation request.
  const visible = !sameLanguage && (!!translation || (content.eligible && canRequest));
  const sourceLanguage = translation?.sourceLanguage ?? content.sourceLanguage;
  const sourceLanguageName = useMemo(() => {
    if (!sourceLanguage) return null;
    try {
      return new Intl.DisplayNames([resolvedLocale], { type: 'language' }).of(sourceLanguage);
    } catch {
      return (
        SUPPORTED_LOCALES.find(
          ({ code }) =>
            code.toLowerCase().split('-')[0] === sourceLanguage.toLowerCase().split('-')[0],
        )?.nativeName ?? sourceLanguage
      );
    }
  }, [resolvedLocale, sourceLanguage]);
  const html = translated ? translation?.html : content.originalHtml;
  const text = translated ? translation?.text : content.original;
  const tagsStyles = useMemo(
    () => ({
      body: { color: tokens.textPrimary, fontSize: 15, lineHeight: 21 },
      p: { marginTop: 0, marginBottom: spacing.sm },
      a: { color: tokens.primary },
      blockquote: {
        borderLeftColor: tokens.border,
        borderLeftWidth: 3,
        paddingLeft: spacing.sm,
        color: tokens.textMuted,
      },
      code: { backgroundColor: tokens.surfaceElevated, color: tokens.textPrimary },
    }),
    [tokens],
  );

  const requestTranslation = async (language: SupportedLocale) => {
    setNotice(null);
    setTarget(language);
    if (translation?.targetLanguage === language) {
      setTranslated((value) => !value);
      return;
    }
    try {
      const result = await mutation.mutateAsync({
        kind,
        id,
        targetLanguage: language,
        conversation,
      });
      if (currentContext.current !== translationContext) return;
      if (result.sameLanguage) {
        setTranslation(null);
        setTranslated(false);
        setSameLanguage(true);
        const languageName =
          SUPPORTED_LOCALES.find(
            ({ code }) =>
              code.toLowerCase().split('-')[0] ===
              result.sourceLanguage.toLowerCase().split('-')[0],
          )?.nativeName ?? result.sourceLanguage;
        setNotice(t('comments:alreadyInSelectedLanguage', { language: languageName }));
        return;
      }
      setTranslation(result);
      setTranslated(true);
    } catch {
      if (currentContext.current !== translationContext) return;
      setNotice(t('comments:translationFailedDescription'));
    }
  };

  const chooseLanguage = () => {
    showDialog({
      title: t('comments:chooseTranslationLanguage'),
      buttons: SUPPORTED_LOCALES.map((locale) => ({
        label: locale.nativeName,
        variant: (target === locale.code ? 'primary' : 'secondary') as 'primary' | 'secondary',
        onPress: () => requestTranslation(locale.code),
        closeOnPress: true,
      })),
    });
  };

  const originalParts: React.ReactNode[] = [];
  let offset = 0;
  for (const span of [...mentions].sort((a, b) => (a.start ?? -1) - (b.start ?? -1))) {
    if (
      span.start == null ||
      span.end == null ||
      span.start < offset ||
      span.end <= span.start ||
      span.end > content.original.length
    )
      continue;
    originalParts.push(content.original.slice(offset, span.start));
    originalParts.push(
      <T key={span.start} style={{ color: tokens.info }}>
        {content.original.slice(span.start, span.end)}
      </T>,
    );
    offset = span.end;
  }
  originalParts.push(content.original.slice(offset));
  return (
    <View>
      {html ? (
        <RenderHtml
          contentWidth={Math.max(1, width - spacing.xl * 2)}
          source={{ html }}
          tagsStyles={tagsStyles as any}
          renderersProps={{
            a: {
              onPress: (_event, href) => {
                if (/^https?:\/\//i.test(href)) void Linking.openURL(href);
              },
            },
          }}
        />
      ) : text ? (
        <T variant="body" style={style} selectable>
          {!translated && mentions.length ? originalParts : text}
        </T>
      ) : null}
      {notice ? (
        <T variant="micro" muted style={{ marginTop: spacing.xs }}>
          {notice}
        </T>
      ) : null}
      {visible ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: spacing.xs }}>
          <Pressable
            onPress={() => requestTranslation(target)}
            onLongPress={chooseLanguage}
            disabled={mutation.isPending}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t('comments:translate')}
            style={{ flexDirection: 'row', alignItems: 'center' }}
          >
            <Ionicons name="language-outline" size={16} color={tokens.primary} />
            <T variant="micro" style={{ color: tokens.primary, marginLeft: 4 }}>
              {mutation.isPending
                ? t('comments:translating')
                : translated
                  ? t('comments:showOriginal')
                  : t('comments:translate')}
            </T>
          </Pressable>
          {translated && sourceLanguageName ? (
            <T variant="micro" muted style={{ marginLeft: spacing.sm }}>
              {t('comments:translatedFrom', { language: sourceLanguageName })}
            </T>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
