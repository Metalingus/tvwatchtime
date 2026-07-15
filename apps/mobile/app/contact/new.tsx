import React, { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Header } from '../../components/Header';
import { Button, Card, Screen, SectionHeader, T } from '../../components/primitives';
import { TextField } from '../../components/TextField';
import { useCreateContactThread } from '../../api/hooks';
import { useAppearance } from '../../context/PreferencesProvider';
import { useTranslation } from 'react-i18next';
import { spacing, radius } from '../../theme/theme';
import { showSuccess, showError } from '../../lib/dialog';

const REASONS: { value: string; key: string; icon: string }[] = [
  { value: 'FEEDBACK', key: 'feedback', icon: 'chatbubble-outline' },
  { value: 'BUG_REPORT', key: 'bugReport', icon: 'bug-outline' },
  { value: 'DATA', key: 'data', icon: 'download-outline' },
  { value: 'PERSONAL_INFO', key: 'personalInfo', icon: 'person-outline' },
  { value: 'ACCOUNT', key: 'account', icon: 'lock-closed-outline' },
  { value: 'OTHER', key: 'other', icon: 'ellipsis-horizontal-circle-outline' },
];

export default function ContactNewScreen() {
  const { tokens } = useAppearance();
  const { t } = useTranslation(['contact', 'common']);
  const [reason, setReason] = useState('FEEDBACK');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const create = useCreateContactThread();

  const submit = async () => {
    if (!subject.trim() || !body.trim()) {
      showError({ description: t('contact:fillFields') });
      return;
    }
    try {
      await create.mutateAsync({ reason, subject: subject.trim(), body: body.trim() });
      showSuccess({ title: t('contact:sent'), description: t('contact:sentDesc') });
      router.replace('/contact' as any);
    } catch (e: any) {
      showError({ description: e?.message ?? t('common:tryAgain') });
    }
  };

  return (
    <Screen>
      <Header title={t('contact:newMessage')} showBack />
      <ScrollView
        contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg, paddingBottom: 60 }}
      >
        <Card>
          <SectionHeader title={t('contact:reasonLabel')} />
          <View
            style={{
              flexDirection: 'row',
              flexWrap: 'wrap',
              gap: spacing.sm,
              marginTop: spacing.xs,
            }}
          >
            {REASONS.map((r) => {
              const selected = reason === r.value;
              return (
                <Pressable
                  key={r.value}
                  onPress={() => setReason(r.value)}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 6,
                    paddingHorizontal: spacing.md,
                    paddingVertical: spacing.sm,
                    borderRadius: radius.lg,
                    borderWidth: 1,
                    borderColor: selected ? tokens.primary : tokens.border,
                    backgroundColor: selected ? tokens.primary : tokens.surfaceElevated,
                  }}
                >
                  <Ionicons
                    name={r.icon as any}
                    size={15}
                    color={selected ? tokens.primaryForeground : tokens.textMuted}
                  />
                  <T
                    variant="caption"
                    style={{ color: selected ? tokens.primaryForeground : tokens.textPrimary }}
                  >
                    {t(`contact:reason.${r.key}`)}
                  </T>
                </Pressable>
              );
            })}
          </View>
        </Card>

        <TextField
          label={t('contact:subject')}
          value={subject}
          onChangeText={setSubject}
          placeholder={t('contact:subjectPlaceholder')}
        />
        <TextField
          label={t('contact:body')}
          value={body}
          onChangeText={setBody}
          multiline
          placeholder={t('contact:bodyPlaceholder')}
        />

        <Button
          title={t('contact:submit')}
          onPress={submit}
          loading={create.isPending}
          icon="send-outline"
        />
      </ScrollView>
    </Screen>
  );
}
