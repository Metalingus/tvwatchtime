import React from 'react';
import { Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAppearance } from '../context/PreferencesProvider';
import { useTranslation } from 'react-i18next';
import { SUPPORTED_LOCALES, type LanguagePreference } from '@tvwatch/shared';
import { showDialog } from '../lib/dialog';

/** Compact globe button that opens a language picker dialog. Reusable on any screen. */
export function LanguagePicker({ style }: { style?: any }) {
  const { languagePreference, setLanguagePreference, tokens } = useAppearance();
  const { t } = useTranslation(['settings']);

  const open = () => {
    showDialog({
      title: t('settings:language.title'),
      buttons: [
        {
          label: t('settings:language.system'),
          variant: languagePreference === 'system' ? 'primary' : 'secondary',
          onPress: () => setLanguagePreference('system'),
          closeOnPress: true,
        },
        ...SUPPORTED_LOCALES.map((l) => ({
          label: l.nativeName,
          variant: (languagePreference === l.code ? 'primary' : 'secondary') as 'primary' | 'secondary',
          onPress: () => setLanguagePreference(l.code as LanguagePreference),
          closeOnPress: true,
        })),
      ],
    });
  };

  return (
    <Pressable onPress={open} hitSlop={12} style={[styles.btn, style]}>
      <Ionicons name="language" size={22} color={tokens.textMuted} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: { padding: 6 },
});
